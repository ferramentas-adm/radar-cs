// Especialista responsável de um grupo, decidido pela presença (fase C2). Funções puras.
// O sinal é quais instâncias de especialista estão no grupo (tabela presencas, gravada pela
// varredura), nunca "de qual instância chegou a mensagem" (com duas no grupo, só a primeira grava).
// Só conta quem tem time.funcao = 'especialista' e uma instância (time.instancia).
//
// Grupo definido por pessoa (principal_definido_em preenchido: importado ou definir-principal):
//   - o dono está no grupo, ou não há especialista nenhum: mantém;
//   - o dono saiu e há 1 especialista: sugere a troca (uma pessoa confirma);
//   - o dono saiu e há 2 ou mais: aguardando definição (continua com o dono atual).
// Grupo provisório (cadastro automático, principal_definido_em nulo):
//   - 0 especialistas: mantém; 1: troca sozinho (com histórico) se não for o atual;
//   - 2 ou mais: aguardando definição (continua com o dono atual).
// Segurança: só decide quando TODAS as instâncias de especialista têm varredura boa nas últimas
// 24 horas. Se só uma foi varrida, todo grupo parece ter um especialista só.
import type { Funcao } from '../importar/time.js';

export const JANELA_VARREDURA_MS = 24 * 3600_000;

export interface MembroResponsavel {
  nome: string;
  instancia: string | null;
  gestor_padrao: string | null;
  funcao: Funcao | null;
}

export interface GrupoResponsavel {
  jid: string;
  especialista: string | null;
  gestor: string | null;
  principal_definido_em: string | null;
}

export interface Especialista {
  nome: string;
  instancia: string;
  gestor: string | null;
}

export type Decisao =
  | { acao: 'manter' }
  | { acao: 'trocar'; para: Especialista }
  | { acao: 'sugerir'; para: Especialista }
  | { acao: 'aguardando'; especialistas: string[] };

/** Instância → especialista (só funcao = especialista e com instância). */
export function especialistasPorInstancia(time: MembroResponsavel[]): Map<string, Especialista> {
  const mapa = new Map<string, Especialista>();
  for (const t of time) {
    if (t.funcao === 'especialista' && t.instancia) {
      mapa.set(t.instancia, { nome: t.nome, instancia: t.instancia, gestor: t.gestor_padrao });
    }
  }
  return mapa;
}

export function decidirResponsavel(g: GrupoResponsavel, presentes: Especialista[]): Decisao {
  const nomes = [...new Set(presentes.map((p) => p.nome))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const unico = nomes.length === 1 ? presentes.find((p) => p.nome === nomes[0])! : undefined;
  const donoPresente = g.especialista !== null && nomes.includes(g.especialista);

  if (g.principal_definido_em !== null) {
    if (donoPresente || nomes.length === 0) return { acao: 'manter' };
    if (unico) return { acao: 'sugerir', para: unico };
    return { acao: 'aguardando', especialistas: nomes };
  }
  if (nomes.length === 0) return { acao: 'manter' };
  if (unico) return unico.nome === g.especialista ? { acao: 'manter' } : { acao: 'trocar', para: unico };
  return { acao: 'aguardando', especialistas: nomes };
}

/** Instâncias de especialista sem varredura boa nas últimas 24 horas (em ordem alfabética). */
export function semVarreduraRecente(
  especialistas: Map<string, Especialista>,
  varreduras: { instancia: string; concluida_em: string }[],
  agora: number,
): string[] {
  const ultima = new Map(varreduras.map((v) => [v.instancia, Date.parse(v.concluida_em)]));
  return [...especialistas.keys()]
    .filter((i) => {
      const t = ultima.get(i);
      return t === undefined || !Number.isFinite(t) || t < agora - JANELA_VARREDURA_MS;
    })
    .sort();
}

export interface TrocaAutomatica {
  jid: string;
  /** Especialista atual (a troca só é gravada se ele ainda for o atual). */
  esperado: string | null;
  especialista: string;
  gestor: string | null;
  instancia: string;
}

export interface PlanoResponsaveis {
  trocas: TrocaAutomatica[];
  sugeridas: number;
  aguardando: number;
  /** Os grupos aguardando definição, com os especialistas presentes (para o painel). */
  aguardandoLista: { jid: string; especialistas: string[] }[];
  /** Não vazio = nada foi decidido (nem troca, nem sugestão, nem aguardando). */
  semVarreduraRecente: string[];
}

export interface EntradaResponsaveis {
  /** Grupos ativos (só tipo grupo). */
  grupos: GrupoResponsavel[];
  presencas: { jid: string; instancia: string }[];
  /** Time ativo. */
  time: MembroResponsavel[];
  varreduras: { instancia: string; concluida_em: string }[];
  agora: number;
}

export function planejarResponsaveis(e: EntradaResponsaveis): PlanoResponsaveis {
  const especialistas = especialistasPorInstancia(e.time);
  const plano: PlanoResponsaveis = {
    trocas: [],
    sugeridas: 0,
    aguardando: 0,
    aguardandoLista: [],
    semVarreduraRecente: semVarreduraRecente(especialistas, e.varreduras, e.agora),
  };
  if (plano.semVarreduraRecente.length > 0) return plano;

  const presentes = new Map<string, Especialista[]>();
  for (const p of e.presencas) {
    const esp = especialistas.get(p.instancia);
    if (esp) presentes.set(p.jid, [...(presentes.get(p.jid) ?? []), esp]);
  }
  for (const g of e.grupos) {
    const d = decidirResponsavel(g, presentes.get(g.jid) ?? []);
    if (d.acao === 'trocar') {
      plano.trocas.push({
        jid: g.jid,
        esperado: g.especialista,
        especialista: d.para.nome,
        // Sem gestor padrão, fica o gestor que o grupo já tinha.
        gestor: d.para.gestor ?? g.gestor,
        instancia: d.para.instancia,
      });
    } else if (d.acao === 'sugerir') plano.sugeridas++;
    else if (d.acao === 'aguardando') {
      plano.aguardando++;
      plano.aguardandoLista.push({ jid: g.jid, especialistas: d.especialistas });
    }
  }
  return plano;
}
