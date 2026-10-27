// Passo 5 (reconciliação): ao subir e a cada poucos minutos, busca via /message/find o que o
// webhook não entregou (sessão caiu, fila travou, evento perdido) nas conversas que cada instância
// de pessoa é dona. Mesmo normalizador e mesma gravação do webhook (messageid repetido é ignorado).
// Só as conversas desta instância (grupos.instancia = nome); o observador não reconcilia (está
// sendo aposentado e nunca cadastra). Só leitura na uazapi. Sem nomes, números, jids nem texto no log.
import { decifrar } from '../conversas/chave.js';
import type { BancoRadar } from '../db/supabase.js';
import {
  buscarHistorico,
  mapaLids,
  processarConversa,
  type ConversaHistorico,
  type MembroHistorico,
} from '../mensagens/historico.js';
import { gravarMensagensSupabase, mensagensExistentesSupabase } from '../repositorio.js';
import { lerSyncEstado, registrarUltimaMensagem } from './sync.js';
import type { ClienteUazapi } from '../uazapi/cliente.js';

/** Sem sync_estado ainda (primeira vez após o deploy): até onde olhar pra trás. */
export const JANELA_PADRAO_MS = 2 * 3600_000; // 2 horas
/** Sempre reler um pouco antes do marcado, para não perder nada bem na borda. */
const MARGEM_MS = 5 * 60_000;

export interface ResumoReconciliacao {
  instancia: string;
  conversas: number;
  falhas: number;
  novas: number;
}

/** O time ativo e um ehDoTime pronto para o normalizador (mesma regra do webhook). */
export async function carregarTime(db: BancoRadar): Promise<{ time: MembroHistorico[]; ehDoTime: (n: string) => boolean }> {
  const r = await db.from('time').select('numero, lid').eq('ativo', true);
  if (r.error) throw new Error(`falha ao ler o time (código ${r.error.code ?? 'desconhecido'})`);
  const time = (r.data ?? []) as MembroHistorico[];
  const chaves = new Set(time.map((t) => t.numero.replace(/\D/g, '')).filter((c) => c !== ''));
  return { time, ehDoTime: (n: string) => chaves.has(n.replace(/\D/g, '')) };
}

/** Conversas ativas desta instância (dona), com o chatid (privada: decifrado só em memória). */
async function conversasDaInstancia(db: BancoRadar, nome: string, cifra: Buffer | undefined): Promise<ConversaHistorico[]> {
  const r = await db.from('grupos').select('jid, tipo, chat_cifrado').eq('instancia', nome).eq('ativo', true);
  if (r.error) throw new Error(`falha ao ler as conversas (código ${r.error.code ?? 'desconhecido'})`);
  const linhas = (r.data ?? []) as { jid: string; tipo: 'grupo' | 'privada'; chat_cifrado: string | null }[];
  const conversas: ConversaHistorico[] = [];
  for (const l of linhas) {
    if (l.tipo === 'grupo') {
      conversas.push({ jid: l.jid, tipo: 'grupo', chatid: l.jid });
      continue;
    }
    if (!cifra || !l.chat_cifrado) continue; // sem chave ou sem chatid guardado: não dá para reconciliar
    try {
      conversas.push({ jid: l.jid, tipo: 'privada', chatid: decifrar(l.chat_cifrado, cifra) });
    } catch {
      // chave trocada ou valor corrompido: ignora esta conversa, não derruba a reconciliação inteira.
    }
  }
  return conversas;
}

/**
 * Reconcilia uma instância de pessoa: busca o que faltou desde a última mensagem conhecida (ou
 * JANELA_PADRAO_MS na primeira vez), grava só as mensagens novas e avança o marcador.
 */
export async function reconciliarInstancia(
  db: BancoRadar,
  nome: string,
  uazapi: Pick<ClienteUazapi, 'buscarMensagens'>,
  cifra: Buffer | undefined,
): Promise<ResumoReconciliacao> {
  const agora = Date.now();
  const sync = await lerSyncEstado(db, nome);
  const desde = (sync?.ultima_mensagem_em ?? agora - JANELA_PADRAO_MS) - MARGEM_MS;

  const conversas = await conversasDaInstancia(db, nome, cifra);
  const { time, ehDoTime } = await carregarTime(db);

  const brutas = new Map<string, Record<string, unknown>[]>();
  let falhas = 0;
  for (const c of conversas) {
    try {
      const h = await buscarHistorico(uazapi, c.chatid, desde);
      brutas.set(c.jid, h.mensagens);
    } catch {
      falhas++;
    }
  }
  const lids = mapaLids(time, [...brutas.values()].flat());

  const validas = conversas.flatMap((c) => {
    const b = brutas.get(c.jid);
    if (!b) return [];
    return processarConversa(c, b, { instancia: nome, ehDoTime, lids, desde, agora }).validas;
  });

  const existentes = await mensagensExistentesSupabase(db, validas.map((m) => m.id_mensagem));
  const novas = validas.filter((m) => !existentes.has(m.id_mensagem));
  if (novas.length > 0) await gravarMensagensSupabase(db, novas);

  // buscarHistorico já trouxe cada conversa até agora: o marcador avança para agora, não para a
  // mensagem mais recente (senão uma conversa muda ficaria perpetuamente atrás das outras). Com
  // falha, não avança: a próxima rodada tenta de novo a mesma janela (reler o que já deu certo
  // custa menos do que perder mensagem de quem falhou).
  if (falhas === 0) await registrarUltimaMensagem(db, nome, agora);

  return { instancia: nome, conversas: conversas.length, falhas, novas: novas.length };
}

/** Roda para todas as instâncias de pessoa (o observador não reconcilia). Uma falha não derruba as outras. */
export async function reconciliarTodas(
  db: BancoRadar,
  instancias: { nome: string; tipo: 'observador' | 'pessoa' }[],
  clientes: Map<string, Pick<ClienteUazapi, 'buscarMensagens'>>,
  cifra: Buffer | undefined,
  aoFalhar: (instancia: string, erro: unknown) => void,
): Promise<ResumoReconciliacao[]> {
  const resumos: ResumoReconciliacao[] = [];
  for (const i of instancias) {
    if (i.tipo !== 'pessoa') continue;
    const uazapi = clientes.get(i.nome);
    if (!uazapi) continue;
    try {
      resumos.push(await reconciliarInstancia(db, i.nome, uazapi, cifra));
    } catch (e) {
      aoFalhar(i.nome, e);
    }
  }
  return resumos;
}
