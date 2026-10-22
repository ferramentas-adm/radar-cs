// Histórico inicial (backfill): carrega da uazapi (POST /message/find) as mensagens dos últimos N
// dias das conversas já cadastradas e grava pelo mesmo normalizador do webhook (texto só como
// máscara, mesma regra de contar, messageid repetido ignorado). O script fica em
// scripts/historico-mensagens.ts. Só leitura na uazapi.
// Diferença em relação ao webhook (só aqui): sem sender_pn, o autor é procurado pelo LID (time.lid e
// pares LID→número vistos no próprio histórico); sem achar, vira cliente e é contado.
// Nada daqui imprime número, jid, chatid ou texto: só contagens.
import type { DadosRadar } from '../api/dados.js';
import { chaveTelefone, comTentativas } from '../grupos/exportar.js';
import { calcular, type MensagemMotor } from '../motor/calcular.js';
import { ErroUazapi, type ClienteUazapi } from '../uazapi/cliente.js';
import { normalizarMensagem, type MensagemNormalizada } from './normalizar.js';

export const DIAS_PADRAO = 7;
export const DIAS_MAX = 7; // a uazapi guarda até 7 dias
export const PAGINA_HISTORICO = 500;
/** Teto por conversa: 7 dias de um grupo movimentado cabem com folga; acima disso, para e avisa. */
export const TETO_POR_CONVERSA = 2000;
/** Pausa antes de cada chamada (uma por vez; a uazapi aceita 10/s por instância). */
export const PAUSA_MS = 300;
/** Relógio da uazapi um pouco adiantado não descarta a mensagem; mais que isso, a data é inválida. */
const TOLERANCIA_FUTURO_MS = 5 * 60_000;

const dormir = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** --dias N (1 a 7; padrão 7). Erro cita só a opção. */
export function lerDias(argv: string[]): number {
  const i = argv.indexOf('--dias');
  if (i === -1) return DIAS_PADRAO;
  const v = argv[i + 1];
  if (!v || !/^[1-9][0-9]*$/.test(v) || Number(v) > DIAS_MAX) {
    throw new Error(`Use --dias N, com N de 1 a ${DIAS_MAX}.`);
  }
  return Number(v);
}

export interface Historico {
  mensagens: Record<string, unknown>[];
  /** Parou no teto antes de chegar ao início da janela. */
  noTeto: boolean;
}

/**
 * Pagina /message/find (mais recente primeiro) até a mensagem mais antiga da página passar do início
 * da janela, acabar o histórico ou bater no teto. Uma chamada por vez, com pausa antes de cada uma;
 * 408 e 429 tentam de novo respeitando o Retry-After.
 */
export async function buscarHistorico(
  uazapi: Pick<ClienteUazapi, 'buscarMensagens'>,
  chatid: string,
  desde: number,
  opcoes: { pagina?: number; teto?: number; pausaMs?: number; esperar?: (ms: number) => Promise<void> } = {},
): Promise<Historico> {
  const pagina = opcoes.pagina ?? PAGINA_HISTORICO;
  const teto = opcoes.teto ?? TETO_POR_CONVERSA;
  const esperar = opcoes.esperar ?? dormir;
  const mensagens: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    await esperar(opcoes.pausaMs ?? PAUSA_MS);
    const limit = Math.min(pagina, teto - mensagens.length);
    const r = await comTentativas(() => uazapi.buscarMensagens({ chatid, limit, offset }), esperar);
    mensagens.push(...r.messages);
    const datas = r.messages.map((m) => Number(m.messageTimestamp)).filter((t) => Number.isFinite(t) && t > 0);
    const maisAntiga = datas.length > 0 ? Math.min(...datas) : undefined;
    if (r.messages.length === 0 || !r.pagination.hasMore) return { mensagens, noTeto: false };
    if (maisAntiga !== undefined && maisAntiga < desde) return { mensagens, noTeto: false };
    if (mensagens.length >= teto) return { mensagens, noTeto: true };
    const proximo = r.pagination.nextOffset ?? offset + r.messages.length;
    // nextOffset que não avança faria um loop infinito.
    if (proximo <= offset) return { mensagens, noTeto: false };
    offset = proximo;
  }
}

/** Membro do time como vem da tabela time (só o que o histórico usa). */
export interface MembroHistorico {
  numero: string;
  lid: string | null;
}

const digitos = (v: string) => (v.split('@')[0] ?? '').replace(/\D/g, '');

/** Mapa LID → número (só dígitos): o de time.lid e os pares (sender_lid, sender_pn) vistos no histórico. */
export function mapaLids(time: MembroHistorico[], mensagens: Record<string, unknown>[]): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const m of mensagens) {
    const lid = typeof m.sender_lid === 'string' ? m.sender_lid : '';
    const pn = typeof m.sender_pn === 'string' ? digitos(m.sender_pn) : '';
    if (lid.endsWith('@lid') && pn !== '') mapa.set(lid, pn);
  }
  // time.lid vale mais que o aprendido.
  for (const t of time) if (t.lid && digitos(t.numero) !== '') mapa.set(t.lid, digitos(t.numero));
  return mapa;
}

/**
 * Autor da mensagem do histórico: sender_pn; sem ele, o número do LID (sender_lid ou sender @lid).
 * Devolve a mensagem com sender_pn preenchido quando achou, para o normalizador decidir time/cliente
 * do mesmo jeito que no webhook. Não identificado = segue sem número (vira cliente).
 */
export function resolverAutor(
  m: Record<string, unknown>,
  lids: Map<string, string>,
): { mensagem: Record<string, unknown>; identificado: boolean } {
  if (m.fromMe === true) return { mensagem: m, identificado: true };
  const pn = typeof m.sender_pn === 'string' ? m.sender_pn : '';
  if (chaveTelefone(pn) !== '') return { mensagem: m, identificado: true };
  const sender = typeof m.sender === 'string' ? m.sender : '';
  const lid = typeof m.sender_lid === 'string' && m.sender_lid !== '' ? m.sender_lid : sender.endsWith('@lid') ? sender : '';
  const numero = lid ? lids.get(lid) : undefined;
  if (numero) return { mensagem: { ...m, sender_pn: `${numero}@s.whatsapp.net` }, identificado: true };
  return { mensagem: m, identificado: false };
}

/** Conversa a carregar. O chatid (na privada, decifrado) fica só em memória. */
export interface ConversaHistorico {
  jid: string;
  tipo: 'grupo' | 'privada';
  chatid: string;
}

export interface ContextoHistorico {
  instancia: string;
  ehDoTime: (numero: string) => boolean;
  lids: Map<string, string>;
  desde: number;
  agora: number;
}

export interface ResultadoHistorico {
  lidas: number;
  validas: MensagemNormalizada[];
  semData: number;
  foraDaJanela: number;
  outraConversa: number;
  naoIdentificados: number;
}

/**
 * Filtra e normaliza as mensagens de uma conversa: descarta as de outra conversa, sem data válida e
 * mais antigas que a janela; tira duplicadas pelo messageid. Função pura.
 */
export function processarConversa(c: ConversaHistorico, brutas: Record<string, unknown>[], ctx: ContextoHistorico): ResultadoHistorico {
  const r: ResultadoHistorico = { lidas: brutas.length, validas: [], semData: 0, foraDaJanela: 0, outraConversa: 0, naoIdentificados: 0 };
  const vistas = new Set<string>();
  for (const bruta of brutas) {
    // Se a uazapi ignorar o filtro, a mensagem de outra conversa nunca entra nesta.
    if (bruta.chatid !== c.chatid) {
      r.outraConversa++;
      continue;
    }
    const ms = Number(bruta.messageTimestamp);
    if (!Number.isFinite(ms) || ms <= 0 || ms > ctx.agora + TOLERANCIA_FUTURO_MS) {
      r.semData++;
      continue;
    }
    if (ms < ctx.desde) {
      r.foraDaJanela++;
      continue;
    }
    const { mensagem, identificado } = resolverAutor(bruta, ctx.lids);
    const n = normalizarMensagem(
      { EventType: 'messages', message: mensagem },
      { nome: ctx.instancia, tipo: 'pessoa' },
      ctx.ehDoTime,
      new Date(ctx.agora).toISOString(),
      c.jid,
    );
    if (!n || vistas.has(n.id_mensagem)) continue;
    vistas.add(n.id_mensagem);
    if (!identificado) r.naoIdentificados++;
    r.validas.push(n);
  }
  return r;
}

/** Mensagens que contam, no formato do motor. */
export function paraMotor(mensagens: MensagemNormalizada[]): MensagemMotor[] {
  return mensagens
    .filter((m) => m.conta)
    .map((m) => ({ id_mensagem: m.id_mensagem, id_grupo: m.jid, autor_tipo: m.autor_tipo, enviada_em: Date.parse(m.enviada_em) }));
}

/**
 * A conversa está em alerta? Roda o motor só com ela. Grupo: tem alerta. Privada: conta como
 * "sem resposta" no número por especialista. Conversa fora dos dados (inativa) nunca está.
 */
export function emAlerta(dados: DadosRadar, jid: string, agora: number, extras: MensagemMotor[] = []): boolean {
  const g = dados.grupos.find((x) => x.id_grupo === jid);
  if (!g) return false;
  const r = calcular({
    agora,
    grupos: [g],
    mensagens: [...dados.mensagens.filter((m) => m.id_grupo === jid), ...extras],
    calendario: dados.calendario,
    prazo: dados.prazo,
    observador: { status: 'conectado', desde: null },
    ultimaMensagemEm: null,
    usuario: { nome: 'historico', pode_marcar: false },
  });
  return g.tipo === 'privada'
    ? r.por_especialista.some((p) => p.conversas_privadas_sem_resposta > 0)
    : r.alertas.length > 0;
}

/** Grupo sem nenhuma mensagem do time que conta, entre as válidas da janela. */
export function semTimeNaJanela(c: ConversaHistorico, validas: MensagemNormalizada[]): boolean {
  return c.tipo === 'grupo' && !validas.some((m) => m.conta && m.autor_tipo === 'time');
}

export interface Contagens {
  conversas: number;
  lidas: number;
  falhas: Map<string, number>;
  noTeto: number;
  mensagensLidas: number;
  novas: number;
  existentes: number;
  semData: number;
  foraDaJanela: number;
  outraConversa: number;
  naoIdentificados: number;
  alertaParaOk: number;
  okParaAlerta: number;
  gruposSemTime: number;
  gravadas?: number;
}

/** Motivo da falha de uma conversa, sem dado nenhum dela (só HTTP ou um rótulo fixo). */
export function motivoFalha(e: unknown): string {
  return e instanceof ErroUazapi ? `HTTP ${e.status}` : 'outro erro';
}

/** Única saída para o terminal: contagens, nunca nomes, números, jids ou texto. */
export function formatarContagens(c: Contagens, dias: number, gravar: boolean): string {
  const falhas = [...c.falhas.values()].reduce((a, b) => a + b, 0);
  const detalhe = falhas > 0 ? ` (${[...c.falhas].map(([k, v]) => `${k}: ${v}`).join(', ')})` : '';
  return [
    `modo: ${gravar ? 'gravação' : 'simulação (nada gravado; use --gravar)'} · janela: ${dias} dia(s)`,
    `conversas: ${c.conversas} · lidas: ${c.lidas} · com falha: ${falhas}${detalhe} · no teto: ${c.noTeto}`,
    `mensagens lidas: ${c.mensagensLidas} · novas: ${c.novas} · já existentes: ${c.existentes}`,
    `descartadas por data: ${c.semData + c.foraDaJanela} (sem data válida: ${c.semData}, fora da janela: ${c.foraDaJanela}) · de outra conversa: ${c.outraConversa}`,
    `autores não identificados (tratados como cliente): ${c.naoIdentificados}`,
    `mudariam de estado: alerta → ok: ${c.alertaParaOk} · ok → alerta: ${c.okParaAlerta}`,
    `grupos sem mensagem do time na janela: ${c.gruposSemTime}`,
    ...(c.gravadas === undefined ? [] : [`gravadas: ${c.gravadas}`]),
  ].join('\n');
}
