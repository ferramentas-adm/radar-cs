// Identificador e cifra da conversa privada. O número do cliente nunca fica em claro no banco,
// na API nem no painel: o jid é um HMAC (chave RADAR_CHAVE_CONVERSA) e o chatid original fica
// cifrado (RADAR_CHAVE_CIFRA), só para o servidor reconciliar. Nada daqui vai para log.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export interface ChavesConversa {
  /** 32 bytes: HMAC-SHA256 do identificador da conversa privada. */
  conversa: Buffer;
  /** 32 bytes: AES-256-GCM do chatid. */
  cifra: Buffer;
}

export const PREFIXO_PRIVADA = 'privada:';

/**
 * jid da conversa privada: 'privada:' + HMAC(instância + identificador do outro lado).
 * A instância entra na chave: o mesmo cliente com dois especialistas são duas conversas.
 */
export function jidPrivada(instancia: string, identificador: string, chave: Buffer): string {
  return PREFIXO_PRIVADA + createHmac('sha256', chave).update(`${instancia}\n${identificador}`).digest('hex');
}

const VERSAO = 'v1';

/** AES-256-GCM: "v1.<iv>.<tag>.<cifrado>", em base64url. */
export function cifrar(texto: string, chave: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chave, iv);
  const cifrado = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [VERSAO, iv, c.getAuthTag(), cifrado].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** Falha (lança) se o valor foi alterado ou a chave é outra. */
export function decifrar(valor: string, chave: Buffer): string {
  const [versao, iv, tag, cifrado] = valor.split('.');
  if (versao !== VERSAO || !iv || !tag || cifrado === undefined) throw new Error('valor cifrado em formato desconhecido');
  const d = createDecipheriv('aes-256-gcm', chave, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(cifrado, 'base64url')), d.final()]).toString('utf8');
}

/** Chave do .env: Base64 padrão de exatamente 32 bytes (44 caracteres). undefined se inválida. */
export function lerChave(valor: string | undefined): Buffer | undefined {
  const v = valor?.trim() ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(v)) return undefined;
  const b = Buffer.from(v, 'base64');
  return b.length === 32 ? b : undefined;
}
