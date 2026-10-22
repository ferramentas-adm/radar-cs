import { describe, expect, it } from 'vitest';
import { mascararTexto, sanitizarPayload, sanitizarPayloadPrivada } from '../src/webhook/sanitizar.js';
import {
  LID_CLIENTE,
  NUMERO_CLIENTE,
  TEXTO,
  TOKEN,
  TOKEN_RONI,
  mensagemCitada,
  mensagemPrivada,
  mensagemTexto,
} from './fixtures/payloads.js';

const padrao = { guardarTexto: false };

describe('sanitizarPayload: token', () => {
  it('remove o token do topo', () => {
    const s = sanitizarPayload(mensagemTexto(), padrao) as Record<string, unknown>;
    expect(s).not.toHaveProperty('token');
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it('remove token e admintoken aninhados, sem diferenciar maiúsculas', () => {
    const p = { a: { Token: 'x1', b: [{ admintoken: 'x2', ADMINTOKEN: 'x3', ok: 1 }] } };
    expect(sanitizarPayload(p, padrao)).toEqual({ a: { b: [{ ok: 1 }] } });
  });

  it('não altera a entrada', () => {
    const p = mensagemTexto();
    const copia = structuredClone(p);
    sanitizarPayload(p, padrao);
    expect(p).toEqual(copia);
  });

  it('mantém os campos de estrutura', () => {
    const s = sanitizarPayload(mensagemTexto(), padrao) as { message: Record<string, unknown> };
    expect(s.message).toMatchObject({
      messageid: '3EB0AAAA0001',
      chatid: '120363040001000@g.us',
      sender: '5511988887777@s.whatsapp.net',
      fromMe: false,
      isGroup: true,
      messageType: 'Conversation',
      messageTimestamp: 1792512000000,
    });
  });
});

describe('sanitizarPayload: texto mascarado por padrão', () => {
  it('troca message.text e message.content (string) por "[texto omitido: N caracteres]"', () => {
    const s = sanitizarPayload(mensagemTexto(), padrao) as { message: Record<string, unknown> };
    const esperado = `[texto omitido: ${TEXTO.length} caracteres]`;
    expect(s.message.text).toBe(esperado);
    expect(s.message.content).toBe(esperado);
  });

  it('N conta o tamanho do texto original, com acentos e emoji', () => {
    expect(mascararTexto('')).toBe('[texto omitido: 0 caracteres]');
    expect(mascararTexto('ação')).toBe('[texto omitido: 4 caracteres]');
    expect(mascararTexto('ok 👍')).toBe(`[texto omitido: ${'ok 👍'.length} caracteres]`);
  });

  it('nenhum pedaço da conversa sobra no payload: citação e prévia do chat também', () => {
    const s = JSON.stringify(sanitizarPayload(mensagemCitada(), padrao));
    expect(s).not.toContain('boleto');
    expect(s).not.toContain(TEXTO);
    // A estrutura da citação continua visível (é o que a descoberta precisa).
    expect(s).toContain('quotedMessage');
    expect(s).toContain('stanzaID');
  });

  it('content que é objeto mantém a estrutura e só tem as strings de texto mascaradas', () => {
    const s = sanitizarPayload(mensagemCitada(), padrao) as { message: { content: Record<string, unknown> } };
    expect(s.message.content).toEqual({
      text: '[texto omitido: 14 caracteres]',
      contextInfo: {
        stanzaID: '3EB0AAAA0001',
        quotedMessage: { conversation: `[texto omitido: ${TEXTO.length} caracteres]` },
      },
    });
  });

  it('com guardarTexto=true o texto fica, e o token continua saindo', () => {
    const s = sanitizarPayload(mensagemTexto(), { guardarTexto: true }) as Record<string, unknown> & {
      message: Record<string, unknown>;
    };
    expect(s.message.text).toBe(TEXTO);
    expect(s.message.content).toBe(TEXTO);
    expect(s).not.toHaveProperty('token');
  });
});

describe('sanitizarPayloadPrivada', () => {
  it('só a lista fechada de campos: sem chatid, números, LID, nome nem texto', () => {
    const s = sanitizarPayloadPrivada(mensagemPrivada());
    expect(s).toEqual({
      EventType: 'messages',
      message: {
        messageid: '3EB0CCCC0001',
        messageType: 'Conversation',
        mediaType: '',
        fromMe: false,
        isGroup: false,
        messageTimestamp: 1792512000000,
        text: mascararTexto(TEXTO),
      },
    });
    const tudo = JSON.stringify(s);
    for (const proibido of [NUMERO_CLIENTE, LID_CLIENTE, 'Contato Cliente', TOKEN_RONI, TEXTO]) {
      expect(tudo).not.toContain(proibido);
    }
  });
});
