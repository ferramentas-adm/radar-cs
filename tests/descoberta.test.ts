import { describe, expect, it } from 'vitest';
import { resumirPayloads, sufixoJid } from '../src/descoberta.js';
import { sanitizarPayload } from '../src/webhook/sanitizar.js';
import { TEXTO, eventoConexao, mensagemCitada, mensagemTexto } from './fixtures/payloads.js';

describe('resumirPayloads', () => {
  const payloads = [
    mensagemTexto(),
    mensagemTexto({ messageid: 'x2', sender: '123456789@lid', fromMe: true }),
    mensagemCitada(),
    eventoConexao(),
  ].map((p) => sanitizarPayload(p, { guardarTexto: false }));

  it('conta eventos, messageType e formato do autor', () => {
    const r = resumirPayloads(payloads);
    expect(r.total).toBe(4);
    expect(r.porEvento).toEqual({ messages: 3, connection: 1 });
    expect(r.porMessageType).toEqual({ Conversation: 2, ExtendedTextMessage: 1 });
    expect(r.formatoAutor).toEqual({ sender: { '@s.whatsapp.net': 2, '@lid': 1 } }); // fromMe (booleano) fica de fora
    expect(r.fromMe).toEqual({ false: 2, true: 1 });
    expect(r.chavesPorMessageType.ExtendedTextMessage).toHaveProperty('content', 1);
  });

  it('não devolve texto nem número de telefone', () => {
    const s = JSON.stringify(resumirPayloads(payloads));
    expect(s).not.toContain(TEXTO);
    expect(s).not.toContain('5511988887777');
    expect(s).not.toContain('123456789');
    expect(s).not.toContain('Cliente Teste');
  });

  it('sufixoJid', () => {
    expect(sufixoJid('120363@g.us')).toBe('@g.us');
    expect(sufixoJid('5511')).toBe('(sem @)');
    expect(sufixoJid(undefined)).toBe('(vazio)');
  });
});
