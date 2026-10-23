// Varredura por instância (fase C2): lista os grupos do número (POST /group/list, com participantes),
// cadastra os de cliente que ainda não estão em grupos, grava a presença da instância e aplica a regra
// do responsável (src/conversas/responsavel.ts). O script fica em scripts/varrer-grupos.ts.
// Só leitura na uazapi (/instance/status, /group/list, /group/info).
// A presença só é substituída com uma listagem completa e boa: instância conectada, paginação até o
// fim sem erro (429 que não passa = erro) e lista que não seja suspeita (vazia ou com queda grande).
// Nada daqui imprime nome de grupo, número, jid ou texto: só contagens.
import type { NovaConversa } from '../conversas/cadastrador.js';
import { classificarParticipantes, type QuemEhDoTime } from '../conversas/classificar.js';
import type { PlanoResponsaveis } from '../conversas/responsavel.js';
import { statusDoPainel } from '../instancias/estado.js';
import type { ClienteUazapi, Grupo, ParticipanteGrupo } from '../uazapi/cliente.js';
import { buscarTodosGrupos, comTentativas } from './exportar.js';
import { motivoFalha } from '../mensagens/historico.js';

/** Pausa antes de cada /group/info (uma chamada por vez). */
export const PAUSA_MS = 300;
/** Lista com menos da metade dos grupos da última varredura boa é suspeita. */
export const QUEDA_SUSPEITA = 0.5;

const dormir = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export type MotivoListagemRuim = 'desconectada' | 'erro' | 'vazia' | 'queda';

export type Listagem = { ok: true; grupos: Grupo[] } | { ok: false; motivo: MotivoListagemRuim; detalhe?: string };

/**
 * Lista todos os grupos só se der para confiar na lista: instância conectada, todas as páginas
 * sem erro, não vazia e sem queda grande em relação à última varredura boa (anterior).
 */
export async function listarComSeguranca(
  uazapi: Pick<ClienteUazapi, 'instanceStatus' | 'listarGrupos'>,
  anterior: number | undefined,
  esperar: (ms: number) => Promise<void> = dormir,
): Promise<Listagem> {
  let grupos: Grupo[];
  try {
    const { status } = await comTentativas(() => uazapi.instanceStatus(), esperar);
    if (statusDoPainel(status) !== 'conectado') return { ok: false, motivo: 'desconectada' };
    grupos = await buscarTodosGrupos(uazapi, esperar, false);
  } catch (e) {
    return { ok: false, motivo: 'erro', detalhe: motivoFalha(e) };
  }
  if (grupos.length === 0) return { ok: false, motivo: 'vazia' };
  if (anterior !== undefined && anterior > 0 && grupos.length < anterior * QUEDA_SUSPEITA) {
    return { ok: false, motivo: 'queda' };
  }
  return { ok: true, grupos };
}

export interface Classificacao {
  listados: number;
  jaCadastrados: number;
  internos: number;
  aCadastrar: Grupo[];
  falhas: number;
}

/**
 * Separa os grupos listados: já cadastrados (ativos ou bloqueados), internos e de cliente. Usa os
 * participantes da própria lista; lista vazia consulta /group/info (com pausa). Falha na consulta ou
 * resposta sem participantes = falha (nunca classifica às cegas).
 */
export async function classificarListados(
  grupos: Grupo[],
  cadastrados: Set<string>,
  quem: QuemEhDoTime,
  consultar: (jid: string) => Promise<ParticipanteGrupo[]>,
  opcoes: { pausaMs?: number; esperar?: (ms: number) => Promise<void> } = {},
): Promise<Classificacao> {
  const esperar = opcoes.esperar ?? dormir;
  const c: Classificacao = { listados: grupos.length, jaCadastrados: 0, internos: 0, aCadastrar: [], falhas: 0 };
  for (const g of grupos) {
    if (!g.JID.endsWith('@g.us')) {
      c.falhas++;
      continue;
    }
    if (cadastrados.has(g.JID)) {
      c.jaCadastrados++;
      continue;
    }
    let decisao = classificarParticipantes(g.Participants ?? [], quem);
    if (decisao === undefined) {
      try {
        await esperar(opcoes.pausaMs ?? PAUSA_MS);
        decisao = classificarParticipantes(await comTentativas(() => consultar(g.JID), esperar), quem);
      } catch {
        decisao = undefined;
      }
    }
    if (decisao === undefined) c.falhas++;
    else if (decisao === 'interna') c.internos++;
    else c.aCadastrar.push(g);
  }
  return c;
}

/** Grupo de cliente novo, com o dono da instância como responsável provisório. */
export function novaConversaDeGrupo(
  g: Grupo,
  dono: { especialista: string; gestor: string | null },
  instancia: string,
  agoraIso: string,
): NovaConversa {
  return {
    jid: g.JID,
    tipo: 'grupo',
    nome: g.Name?.trim() || null,
    especialista: dono.especialista,
    gestor: dono.gestor,
    instancia,
    origem: 'automatico',
    ativo: true,
    observador_entrou_em: agoraIso,
    chat_cifrado: null,
  };
}

/** Simulação: a presença como ficaria se a listagem desta instância fosse gravada. */
export function simularPresencas(
  presencas: { jid: string; instancia: string }[],
  instancia: string,
  jidsListados: string[],
  cadastrados: Set<string>,
): { jid: string; instancia: string }[] {
  return [
    ...presencas.filter((p) => p.instancia !== instancia),
    ...[...new Set(jidsListados)].filter((j) => cadastrados.has(j)).map((jid) => ({ jid, instancia })),
  ];
}

/** Simulação: a varredura desta instância como se tivesse sido gravada agora. */
export function simularVarreduras(
  varreduras: { instancia: string; concluida_em: string }[],
  instancia: string,
  agoraIso: string,
): { instancia: string; concluida_em: string }[] {
  return [...varreduras.filter((v) => v.instancia !== instancia), { instancia, concluida_em: agoraIso }];
}

export interface ContagensVarredura {
  listagem: Listagem;
  classificacao: Classificacao | undefined;
  cadastrados?: number;
  falhasCadastro?: number;
  presencasGravadas?: number;
  responsaveis: PlanoResponsaveis;
  trocasGravadas?: number;
}

const MOTIVO: Record<MotivoListagemRuim, string> = {
  desconectada: 'instância não conectada',
  erro: 'erro na listagem',
  vazia: 'lista vazia (suspeita)',
  queda: 'lista com menos da metade dos grupos da última varredura (suspeita)',
};

/** Única saída para o terminal: contagens e nomes de instância; nunca nome de grupo, número, jid ou texto. */
export function formatarVarredura(c: ContagensVarredura, gravar: boolean): string {
  const l = c.listagem;
  const k = c.classificacao;
  const r = c.responsaveis;
  const linhas = [`modo: ${gravar ? 'gravação' : 'simulação (nada gravado; use --gravar)'}`];
  if (l.ok && k) {
    linhas.push(
      `listados: ${k.listados} · já cadastrados: ${k.jaCadastrados} · internos: ${k.internos} · ` +
        `de cliente a cadastrar: ${k.aCadastrar.length} · falhas: ${k.falhas}`,
    );
    if (c.cadastrados !== undefined) linhas.push(`cadastrados: ${c.cadastrados} · falhas ao cadastrar: ${c.falhasCadastro ?? 0}`);
    linhas.push(
      c.presencasGravadas !== undefined
        ? `presença: atualizada (${c.presencasGravadas} grupos cadastrados)`
        : 'presença: seria atualizada',
    );
  } else if (!l.ok) {
    linhas.push(`listagem não confiável: ${MOTIVO[l.motivo]}${l.detalhe ? ` (${l.detalhe})` : ''}`);
    linhas.push('nada cadastrado; presença anterior mantida');
  }
  if (r.semVarreduraRecente.length > 0) {
    linhas.push(
      `responsável: nada decidido; ${r.semVarreduraRecente.length} instância(s) de especialista sem varredura boa ` +
        `nas últimas 24 h: ${r.semVarreduraRecente.join(', ')}`,
    );
  } else {
    linhas.push(`trocas automáticas: ${r.trocas.length} · sugeridas: ${r.sugeridas} · aguardando definição: ${r.aguardando}`);
    if (c.trocasGravadas !== undefined) linhas.push(`trocas gravadas: ${c.trocasGravadas}`);
  }
  return linhas.join('\n');
}
