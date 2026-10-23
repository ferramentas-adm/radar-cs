// Comparação pura entre o carregamento antigo (dados-legado.ts) e o novo (radar_dados), usada pelo
// npm run radar:comparar e pelos testes. Devolve só contagens e, em `onde`, categorias e nomes de
// campo; nunca nome, número, jid, id de mensagem ou texto.
import { calcular, type EntradaMotor, type GrupoMotor, type MensagemMotor } from '../motor/calcular.js';
import type { DadosRadarLegado } from './dados-legado.js';
import type { DadosRadar } from './dados.js';

export interface Comparacao {
  grupos: number;
  privadas: number;
  mensagens: number;
  alertas: number;
  semResposta: number;
  semContato: number;
  pendentes: number;
  definicoes: number;
  semVarredura: number;
  /** Conversas com dados diferentes + itens da configuração diferentes + partes da resposta diferentes. */
  diferencas: number;
  /** Onde estão as diferenças, uma linha por categoria (vazio quando não há). */
  onde: string[];
}

const json = (v: unknown) => JSON.stringify(v);
const assinatura = (ms: MensagemMotor[]) => ms.map((m) => `${m.autor_tipo}|${m.id_mensagem}|${m.enviada_em}`).sort().join(',');
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;
const porTipo = (c: Record<'grupo' | 'privada', number>) => `${plural(c.grupo, 'grupo', 'grupos')}, ${plural(c.privada, 'privada', 'privadas')}`;

function mensagensPorConversa(ms: MensagemMotor[]): Map<string, MensagemMotor[]> {
  const por = new Map<string, MensagemMotor[]>();
  for (const m of ms) por.set(m.id_grupo, [...(por.get(m.id_grupo) ?? []), m]);
  return por;
}

/** Nomes das chaves cujo valor difere entre os dois objetos. */
function camposDiferentes(a: object, b: object): string[] {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => json(x[k]) !== json(y[k]));
}

function entrada(d: DadosRadarLegado, agora: number): EntradaMotor {
  return {
    grupos: d.grupos,
    mensagens: d.mensagens,
    calendario: d.calendario,
    prazo: d.prazo,
    ultimaMensagemEm: d.ultimaMensagemEm,
    agora,
    observador: { status: 'conectado', desde: null },
    usuario: { nome: 'comparacao', pode_marcar: false },
  };
}

export function compararDadosRadar(legado: DadosRadarLegado, novo: DadosRadar, agora: number): Comparacao {
  let diferencas = 0;
  const onde: string[] = [];

  // Conversas: mesmas, com os mesmos campos e as mesmas mensagens.
  const gAntigo = new Map(legado.grupos.map((g) => [g.id_grupo, g]));
  const gNovo = new Map(novo.grupos.map((g) => [g.id_grupo, g]));
  const mAntigo = mensagensPorConversa(legado.mensagens);
  const mNovo = mensagensPorConversa(novo.mensagens);
  const zero = () => ({ grupo: 0, privada: 0 });
  const soAntigo = zero();
  const soNovo = zero();
  const comCampos = zero();
  const comMensagens = zero();
  const porCampo = new Map<string, number>();
  let msAntigo = 0;
  let msNovo = 0;
  let ultimaTime = 0;
  let empate = 0;
  let pendentes = 0;
  for (const id of new Set([...gAntigo.keys(), ...gNovo.keys()])) {
    const a = gAntigo.get(id);
    const n = gNovo.get(id);
    const tipo = ((a ?? n) as GrupoMotor).tipo ?? 'grupo';
    let difere = false;
    if (!a || !n) {
      (a ? soAntigo : soNovo)[tipo]++;
      difere = true;
    } else {
      const campos = camposDiferentes(a, n);
      if (campos.length) {
        comCampos[tipo]++;
        for (const c of campos) porCampo.set(c, (porCampo.get(c) ?? 0) + 1);
        difere = true;
      }
    }
    const ma = mAntigo.get(id) ?? [];
    const mn = mNovo.get(id) ?? [];
    if (assinatura(ma) !== assinatura(mn)) {
      comMensagens[tipo]++;
      msAntigo += ma.length;
      msNovo += mn.length;
      const doTime = (ms: MensagemMotor[]) => ms.filter((m) => m.autor_tipo === 'time');
      const doCliente = (ms: MensagemMotor[]) => ms.filter((m) => m.autor_tipo === 'cliente');
      const [ta, tn] = [doTime(ma), doTime(mn)];
      if (assinatura(ta) !== assinatura(tn)) {
        ultimaTime++;
        // as duas leituras escolheram mensagens do time diferentes com o mesmo horário
        if (ta.length === 1 && tn.length === 1 && ta[0]!.enviada_em === tn[0]!.enviada_em) empate++;
      }
      if (assinatura(doCliente(ma)) !== assinatura(doCliente(mn))) pendentes++;
      difere = true;
    }
    if (difere) diferencas++;
  }
  if (soAntigo.grupo + soAntigo.privada) onde.push(`conversas só no antigo: ${porTipo(soAntigo)}`);
  if (soNovo.grupo + soNovo.privada) onde.push(`conversas só no novo: ${porTipo(soNovo)}`);
  if (comCampos.grupo + comCampos.privada) {
    const lista = [...porCampo].sort(([x], [y]) => x.localeCompare(y)).map(([c, q]) => `${c} ${q}`);
    onde.push(`conversas com campos diferentes: ${porTipo(comCampos)} (${lista.join(', ')})`);
  }
  if (comMensagens.grupo + comMensagens.privada) {
    onde.push(`conversas com mensagens diferentes: ${porTipo(comMensagens)} (mensagens: antigo ${msAntigo}, novo ${msNovo})`);
    if (ultimaTime) onde.push(`  última mensagem do time diferente: ${ultimaTime}`);
    if (empate) onde.push(`  empate de horário entre duas mensagens do time: ${empate} (cada leitura escolheu uma; o motor não muda por isso)`);
    if (pendentes) onde.push(`  pendentes do cliente diferentes: ${pendentes}`);
  }

  // Configuração.
  const calendario = camposDiferentes(legado.calendario.expediente, novo.calendario.expediente);
  const feriados = (d: DadosRadarLegado) => [...d.calendario.feriados].sort();
  if (json(feriados(legado)) !== json(feriados(novo))) {
    calendario.push(`feriados (antigo ${legado.calendario.feriados.size}, novo ${novo.calendario.feriados.size})`);
  }
  if (calendario.length) {
    diferencas++;
    onde.push(`calendário/expediente: ${calendario.join(', ')}`);
  }
  const prazo = camposDiferentes(legado.prazo, novo.prazo);
  if (prazo.length) {
    diferencas++;
    onde.push(`prazo: ${prazo.join(', ')}`);
  }
  if (legado.ultimaMensagemEm !== novo.ultimaMensagemEm) {
    diferencas++;
    onde.push('última mensagem: diferente');
  }

  // Resposta do motor (sem a lista de definições, que o carregamento antigo não tinha).
  const motor = camposDiferentes(calcular(entrada(legado, agora)), calcular(entrada(novo, agora)));
  diferencas += motor.length;
  if (motor.length) onde.push(`resposta do motor: ${motor.join(', ')}`);

  const completo = calcular({ ...entrada(novo, agora), ...(novo.responsaveis ? { responsaveis: novo.responsaveis } : {}) });
  const comMotivo = (tipo: string) => completo.alertas.filter((a) => a.motivos.some((m) => m.tipo === tipo)).length;
  return {
    grupos: novo.grupos.filter((g) => (g.tipo ?? 'grupo') === 'grupo').length,
    privadas: novo.grupos.filter((g) => g.tipo === 'privada').length,
    mensagens: novo.mensagens.length,
    alertas: completo.alertas.length,
    semResposta: comMotivo('sem_resposta'),
    semContato: comMotivo('sem_contato'),
    pendentes: completo.pendentes.length,
    definicoes: completo.definicoes_pendentes.total,
    semVarredura: completo.definicoes_pendentes.sem_varredura_recente,
    diferencas,
    onde,
  };
}
