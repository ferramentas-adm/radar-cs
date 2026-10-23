// Comparação pura entre o carregamento antigo (dados-legado.ts) e o novo (radar_dados), usada pelo
// npm run radar:comparar e pelos testes. Devolve só contagens.
import { calcular, type EntradaMotor, type MensagemMotor } from '../motor/calcular.js';
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
}

const json = (v: unknown) => JSON.stringify(v);

function mensagensPorConversa(ms: MensagemMotor[]): Map<string, string> {
  const por = new Map<string, string[]>();
  for (const m of ms) por.set(m.id_grupo, [...(por.get(m.id_grupo) ?? []), `${m.autor_tipo}|${m.id_mensagem}|${m.enviada_em}`]);
  return new Map([...por].map(([k, v]) => [k, v.sort().join(',')]));
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

  // Conversas: mesmas, com os mesmos campos e as mesmas mensagens.
  const gAntigo = new Map(legado.grupos.map((g) => [g.id_grupo, json(g)]));
  const gNovo = new Map(novo.grupos.map((g) => [g.id_grupo, json(g)]));
  const mAntigo = mensagensPorConversa(legado.mensagens);
  const mNovo = mensagensPorConversa(novo.mensagens);
  for (const id of new Set([...gAntigo.keys(), ...gNovo.keys()])) {
    if (gAntigo.get(id) !== gNovo.get(id) || mAntigo.get(id) !== mNovo.get(id)) diferencas++;
  }

  // Configuração.
  const cal = (d: DadosRadarLegado) => json({ ...d.calendario.expediente, feriados: [...d.calendario.feriados].sort() });
  if (cal(legado) !== cal(novo)) diferencas++;
  if (json(legado.prazo) !== json(novo.prazo)) diferencas++;
  if (legado.ultimaMensagemEm !== novo.ultimaMensagemEm) diferencas++;

  // Resposta do motor (sem a lista de definições, que o carregamento antigo não tinha).
  const rAntigo = calcular(entrada(legado, agora));
  const rNovo = calcular(entrada(novo, agora));
  for (const k of Object.keys(rNovo) as (keyof typeof rNovo)[]) {
    if (json(rAntigo[k]) !== json(rNovo[k])) diferencas++;
  }

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
  };
}
