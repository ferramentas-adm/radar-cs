import { describe, expect, it } from 'vitest';
import { cifrar, decifrar, jidPrivada, lerChave } from '../src/conversas/chave.js';
import { CHAVES } from './fixtures/cadastro.js';
import { CHAT_PRIVADO, NUMERO_CLIENTE } from './fixtures/payloads.js';

describe('jidPrivada', () => {
  const id = 'pn:551188887777';

  it('privada:<64 hex>, estável, sem o número', () => {
    const j = jidPrivada('roni_ramos', id, CHAVES.conversa);
    expect(j).toMatch(/^privada:[0-9a-f]{64}$/);
    expect(jidPrivada('roni_ramos', id, CHAVES.conversa)).toBe(j);
    expect(j).not.toContain('88887777');
  });

  it('a instância entra na chave: o mesmo cliente com dois especialistas são duas conversas', () => {
    expect(jidPrivada('roni_ramos', id, CHAVES.conversa)).not.toBe(jidPrivada('felipe', id, CHAVES.conversa));
  });

  it('outra chave, outro jid (sem a chave não dá para refazer o hash)', () => {
    expect(jidPrivada('roni_ramos', id, CHAVES.conversa)).not.toBe(jidPrivada('roni_ramos', id, CHAVES.cifra));
  });
});

describe('cifrar / decifrar', () => {
  it('volta o chatid; o valor cifrado não tem o número e muda a cada vez', () => {
    const a = cifrar(CHAT_PRIVADO, CHAVES.cifra);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toContain(NUMERO_CLIENTE);
    expect(cifrar(CHAT_PRIVADO, CHAVES.cifra)).not.toBe(a);
    expect(decifrar(a, CHAVES.cifra)).toBe(CHAT_PRIVADO);
  });

  it('valor alterado ou chave errada: erro', () => {
    const a = cifrar(CHAT_PRIVADO, CHAVES.cifra);
    const partes = a.split('.');
    partes[3] = Buffer.from('outra coisa').toString('base64url');
    expect(() => decifrar(partes.join('.'), CHAVES.cifra)).toThrow();
    expect(() => decifrar(a, CHAVES.conversa)).toThrow();
    expect(() => decifrar('lixo', CHAVES.cifra)).toThrow('formato');
  });
});

describe('lerChave', () => {
  it('Base64 padrão de 32 bytes (44 caracteres)', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64');
    expect(b64).toHaveLength(44);
    expect(lerChave(b64)?.length).toBe(32);
    expect(lerChave(` ${b64} `)?.length).toBe(32);
  });

  it('recusa vazio, curto, longo e base64url', () => {
    expect(lerChave(undefined)).toBeUndefined();
    expect(lerChave('')).toBeUndefined();
    expect(lerChave(Buffer.alloc(16).toString('base64'))).toBeUndefined();
    expect(lerChave(Buffer.alloc(48).toString('base64'))).toBeUndefined();
    expect(lerChave(Buffer.alloc(32, 255).toString('base64url'))).toBeUndefined();
  });
});
