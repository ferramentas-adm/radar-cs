// Classificação das conversas na chegada (funções puras): grupo ou privada, e interna ou de cliente.
// Conversa interna é descartada sem gravar nada:
// - privada em que o outro lado é do time;
// - grupo em que todos os participantes são do time (o número do observador não conta).
// O formato do evento de conversa privada ainda não foi confirmado com payload real: os campos
// lidos aqui (chatid, chatlid, sender_pn, sender_lid) são os mesmos do evento de grupo.
import { chaveTelefone } from '../grupos/exportar.js';
import type { ParticipanteGrupo } from '../uazapi/cliente.js';

export interface ConversaDoEvento {
  tipo: 'grupo' | 'privada';
  /** chatid como veio (@g.us, @s.whatsapp.net ou @lid). Nunca vai para log. */
  chatid: string;
  chatlid: string;
  fromMe: boolean;
  /** Só dígitos de sender_pn ('' se não veio). */
  autorNumero: string;
  /** sender_lid ('' se não veio). */
  autorLid: string;
  /** groupName ('' na privada ou se não veio). */
  nomeGrupo: string;
}

function objeto(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');
const digitos = (v: string): string => (v.split('@')[0] ?? '').replace(/\D/g, '');

/** Lê a conversa de um evento "messages". undefined para outros eventos ou chatid desconhecido. */
export function conversaDoEvento(payload: unknown): ConversaDoEvento | undefined {
  const raiz = objeto(payload);
  if (raiz?.EventType !== 'messages') return undefined;
  const msg = objeto(raiz.message);
  if (!msg) return undefined;
  const chatid = texto(msg.chatid);
  const comum = {
    chatid,
    chatlid: texto(msg.chatlid),
    fromMe: msg.fromMe === true,
    autorNumero: digitos(texto(msg.sender_pn)),
    autorLid: texto(msg.sender_lid),
  };
  if (msg.isGroup === true && chatid.endsWith('@g.us')) {
    return { tipo: 'grupo', ...comum, nomeGrupo: texto(msg.groupName) };
  }
  if (msg.isGroup !== true && (chatid.endsWith('@s.whatsapp.net') || chatid.endsWith('@lid'))) {
    return { tipo: 'privada', ...comum, nomeGrupo: '' };
  }
  return undefined; // status, newsletter, broadcast...
}

export interface OutroLado {
  /** Chave de telefone (só dígitos, sem o nono dígito), quando conhecida. */
  numero?: string;
  lid?: string;
}

/**
 * Quem está do outro lado da conversa privada. O número vem do chatid; se o chatid for @lid, do
 * sender_pn de quem escreveu (quando não é a própria instância) ou do mapa LID → número aprendido.
 */
export function outroLadoDaPrivada(c: ConversaDoEvento, numeroDoLid: (lid: string) => string | undefined): OutroLado {
  const ehLid = (s: string) => /^[^@]+@lid$/.test(s);
  const lid = ehLid(c.chatid) ? c.chatid : ehLid(c.chatlid) ? c.chatlid : undefined;
  let numero: string | undefined;
  if (c.chatid.endsWith('@s.whatsapp.net')) numero = digitos(c.chatid);
  else if (!c.fromMe && c.autorNumero !== '') numero = c.autorNumero;
  else if (lid) numero = numeroDoLid(lid);
  const chave = numero ? chaveTelefone(numero) : '';
  return { ...(chave !== '' ? { numero: chave } : {}), ...(lid ? { lid } : {}) };
}

/** Identificador estável do outro lado para o HMAC: o número quando conhecido, senão o LID. */
export function identificadorDoOutroLado(o: OutroLado): string | undefined {
  if (o.numero) return `pn:${o.numero}`;
  if (o.lid) return `lid:${o.lid}`;
  return undefined;
}

export interface QuemEhDoTime {
  ehDoTime(numero: string): boolean;
  ehLidDoTime(lid: string): boolean;
  /** Chave de telefone do número do observador (não conta como time nem como de fora). */
  observador?: string | undefined;
}

/**
 * Grupo interno ou de cliente pelos participantes de /group/info. undefined se a lista veio vazia:
 * sem participantes não dá para classificar (não classificar às cegas).
 * Participante sem número e com LID desconhecido conta como de fora (decisão do piloto).
 */
export function classificarParticipantes(
  participantes: ParticipanteGrupo[],
  q: QuemEhDoTime,
): 'interna' | 'cliente' | undefined {
  if (participantes.length === 0) return undefined;
  for (const p of participantes) {
    const tel = p.PhoneNumber || (p.JID?.endsWith('@s.whatsapp.net') ? p.JID : '');
    const lid = p.LID || (p.JID?.endsWith('@lid') ? p.JID : '');
    if (tel) {
      const chave = chaveTelefone(tel);
      if (q.observador && chave === q.observador) continue;
      if (q.ehDoTime(chave)) continue;
      return 'cliente';
    }
    if (lid && q.ehLidDoTime(lid)) continue;
    return 'cliente';
  }
  return 'interna';
}
