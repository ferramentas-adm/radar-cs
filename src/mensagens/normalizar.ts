// Normalizador: evento "messages" da uazapi (grupo ou privada) → linha de public.mensagens. Função pura.
// Formato dos campos em docs/descoberta-uazapi.md (sender é @lid; o número vem em sender_pn).
import type { InstanciaConfig } from '../config.js';
import { mascararTexto } from '../webhook/sanitizar.js';

export type TipoMensagem = 'texto' | 'audio' | 'imagem' | 'documento' | 'reacao' | 'figurinha' | 'video' | 'outro';

export interface MensagemNormalizada {
  id_mensagem: string;
  jid: string;
  instancia: string;
  autor_tipo: 'cliente' | 'time';
  /** Só dígitos, e só quando é do time; de cliente fica nulo. */
  autor_numero: string | null;
  tipo: TipoMensagem;
  /** Conta para as regras: texto, áudio e foto/documento com legenda. */
  conta: boolean;
  /** Só a máscara "[texto omitido: N caracteres]"; nunca o conteúdo. */
  texto: string | null;
  enviada_em: string;
}

const TIPOS: Record<string, TipoMensagem> = {
  Conversation: 'texto',
  ExtendedTextMessage: 'texto',
  AudioMessage: 'audio',
  ImageMessage: 'imagem',
  DocumentMessage: 'documento',
  ReactionMessage: 'reacao',
  StickerMessage: 'figurinha',
  VideoMessage: 'video',
};

function objeto(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/** O payload é de mensagem de grupo? (antes de olhar o cadastro). Devolve o jid do grupo. */
export function jidDoGrupo(payload: unknown): string | undefined {
  const raiz = objeto(payload);
  if (raiz?.EventType !== 'messages') return undefined;
  const msg = objeto(raiz.message);
  const chatid = texto(msg?.chatid);
  return msg?.isGroup === true && chatid.endsWith('@g.us') ? chatid : undefined;
}

/**
 * Devolve a mensagem normalizada, ou undefined quando não deve ser gravada (não é mensagem de
 * conversa, falta messageid, ou é do próprio observador). jidConversa vem do cadastrador: na
 * privada é o 'privada:<hash>', nunca o chatid; sem ele, só mensagem de grupo é normalizada.
 */
export function normalizarMensagem(
  payload: unknown,
  instancia: Pick<InstanciaConfig, 'nome' | 'tipo'>,
  ehDoTime: (numero: string) => boolean,
  recebidoEm: string,
  jidConversa?: string,
): MensagemNormalizada | undefined {
  const jid = objeto(payload)?.EventType === 'messages' ? (jidConversa ?? jidDoGrupo(payload)) : undefined;
  const msg = objeto(objeto(payload)?.message);
  const id = texto(msg?.messageid);
  if (!jid || !msg || id === '') return undefined;

  // Regra 8: o observador nunca conta como time (e ele nunca escreve; se escrever, não é cliente).
  if (msg.fromMe === true && instancia.tipo === 'observador') return undefined;

  const numero = texto(msg.sender_pn).split('@')[0]!.replace(/\D/g, '');
  const doTime = msg.fromMe === true || (numero !== '' && ehDoTime(numero));

  const tipo = TIPOS[texto(msg.messageType)] ?? 'outro';
  const corpo = texto(msg.text);
  const legenda = corpo.trim() !== '';
  const conta = tipo === 'texto' || tipo === 'audio' || ((tipo === 'imagem' || tipo === 'documento') && legenda);

  // messageTimestamp vem em milissegundos; sem ele, vale a hora em que o receptor recebeu.
  const ms = Number(msg.messageTimestamp);
  const enviada_em = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : recebidoEm;

  return {
    id_mensagem: id,
    jid,
    instancia: instancia.nome,
    autor_tipo: doTime ? 'time' : 'cliente',
    autor_numero: doTime && numero !== '' ? numero : null,
    tipo,
    conta,
    texto: corpo === '' ? null : mascararTexto(corpo),
    enviada_em,
  };
}
