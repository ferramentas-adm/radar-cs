// Passo 2b: importação do CSV de grupos (exportado por grupos:exportar e preenchido pelo CS).
// Função pura: recebe o texto do CSV, o time e os grupos que já estão no banco; devolve o que
// gravar (upsert por jid) e as contagens. Mensagens de erro citam só o número da linha.
// Importar é uma pessoa (o CS) definindo o responsável: marca principal_definido_em nos grupos
// novos, nos que mudam de especialista e nos provisórios (cadastro automático) que o CSV confirma.
import { coluna, lerCsv } from '../csv.js';

export interface GrupoBanco {
  jid: string;
  nome: string | null;
  especialista: string | null;
  gestor: string | null;
  instancia: string | null;
  observador_entrou_em: string | null;
  principal_definido_em: string | null;
}

export interface PlanoGrupos {
  /** Linhas completas para o upsert por jid (grupo existente já combinado com o banco). */
  gravar: GrupoBanco[];
  novos: number;
  atualizados: number;
  semMudanca: number;
  /** Linhas sem especialista ou sem gestor. */
  ignorados: number;
  /** Grupos já existentes em que --entrou-em foi ignorado (só vale para grupo novo). */
  entrouEmIgnorado: number;
  erros: string[];
}

export interface EntradaGrupos {
  texto: string;
  /** Nomes do time ativo, como estão no banco. */
  time: string[];
  existentes: GrupoBanco[];
  instancia: string;
  /** ISO UTC gravado em observador_entrou_em dos grupos novos. */
  entrouEm: string;
  /** true quando veio de --entrou-em (para contar quando é ignorado). */
  entrouEmInformado: boolean;
  /** ISO UTC de agora: principal_definido_em do que a importação define. */
  definidoEm: string;
}

const chaveNome = (nome: string) => nome.trim().replace(/\s+/g, ' ').toLowerCase();

export function planejarGrupos(e: EntradaGrupos): PlanoGrupos {
  const csv = lerCsv(e.texto);
  const plano: PlanoGrupos = {
    gravar: [],
    novos: 0,
    atualizados: 0,
    semMudanca: 0,
    ignorados: 0,
    entrouEmIgnorado: 0,
    erros: [],
  };
  const faltando = ['jid', 'especialista', 'gestor'].filter((c) => !csv.cabecalho.includes(c));
  if (faltando.length > 0) {
    plano.erros.push(`cabeçalho: faltam as colunas ${faltando.join(', ')}`);
    return plano;
  }

  const timePorChave = new Map(e.time.map((n) => [chaveNome(n), n]));
  const existentes = new Map(e.existentes.map((g) => [g.jid, g]));
  const jidsNoArquivo = new Set<string>();

  for (const l of csv.linhas) {
    const especialistaCsv = coluna(csv, l, 'especialista');
    const gestorCsv = coluna(csv, l, 'gestor');
    if (especialistaCsv === '' || gestorCsv === '') {
      plano.ignorados++;
      continue;
    }

    const erro = (motivo: string) => plano.erros.push(`linha ${l.numero}: ${motivo}`);
    const jid = coluna(csv, l, 'jid');
    if (!jid.endsWith('@g.us')) {
      erro('jid vazio ou que não é de grupo');
      continue;
    }
    if (jidsNoArquivo.has(jid)) {
      erro('jid repetido no arquivo');
      continue;
    }
    jidsNoArquivo.add(jid);
    const especialista = timePorChave.get(chaveNome(especialistaCsv));
    const gestor = timePorChave.get(chaveNome(gestorCsv));
    if (!especialista || !gestor) {
      erro(
        !especialista && !gestor
          ? 'especialista e gestor não estão no time'
          : `${especialista ? 'gestor' : 'especialista'} não está no time`,
      );
      continue;
    }

    const nome = coluna(csv, l, 'nome');
    const atual = existentes.get(jid);
    if (!atual) {
      plano.novos++;
      plano.gravar.push({
        jid,
        nome: nome || null,
        especialista,
        gestor,
        instancia: e.instancia,
        observador_entrou_em: e.entrouEm,
        principal_definido_em: e.definidoEm,
      });
      continue;
    }

    if (e.entrouEmInformado) plano.entrouEmIgnorado++;
    // Vazio no CSV nunca apaga o que já está no banco; observador_entrou_em nunca muda.
    const combinado: GrupoBanco = {
      jid,
      nome: nome || atual.nome,
      especialista,
      gestor,
      instancia: e.instancia,
      observador_entrou_em: atual.observador_entrou_em,
      principal_definido_em:
        especialista !== atual.especialista ? e.definidoEm : (atual.principal_definido_em ?? e.definidoEm),
    };
    const mudou = (['nome', 'especialista', 'gestor', 'instancia', 'principal_definido_em'] as const).some(
      (c) => combinado[c] !== atual[c],
    );
    if (!mudou) {
      plano.semMudanca++;
      continue;
    }
    plano.atualizados++;
    plano.gravar.push(combinado);
  }
  return plano;
}

/**
 * --entrou-em AAAA-MM-DD → ISO UTC da meia-noite em America/Sao_Paulo. Recusa formato inválido,
 * data que não existe (2026-02-30) e data no futuro (hoje vale).
 */
export function entrouEmParaIso(data: string, agora: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  const valida =
    m !== null && new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toISOString().slice(0, 10) === data;
  if (!valida) throw new Error('--entrou-em precisa de uma data válida no formato AAAA-MM-DD.');
  if (data > diaEmSaoPaulo(agora)) throw new Error('--entrou-em não pode ser uma data no futuro.');

  // Meia-noite local: parte de 00:00 UTC e desconta o deslocamento do fuso naquele instante.
  const meiaNoiteUtc = Date.parse(`${data}T00:00:00Z`);
  let t = meiaNoiteUtc - deslocamentoMin(meiaNoiteUtc) * 60_000;
  t = meiaNoiteUtc - deslocamentoMin(t) * 60_000; // segunda passada: horário de verão antigo
  return new Date(t).toISOString();
}

const FUSO = 'America/Sao_Paulo';

function diaEmSaoPaulo(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(d); // AAAA-MM-DD
}

/** Deslocamento de America/Sao_Paulo em minutos (ex.: -180) no instante t. */
function deslocamentoMin(t: number): number {
  const nome = new Intl.DateTimeFormat('en-US', { timeZone: FUSO, timeZoneName: 'longOffset' })
    .formatToParts(t)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(nome ?? '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
