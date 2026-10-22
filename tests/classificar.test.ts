import { describe, expect, it } from 'vitest';
import {
  classificarParticipantes,
  conversaDoEvento,
  identificadorDoOutroLado,
  outroLadoDaPrivada,
} from '../src/conversas/classificar.js';
import { CHAT_PRIVADO, GRUPO, LID_CLIENTE, NUMERO_TIME, mensagemGrupo, mensagemPrivada } from './fixtures/payloads.js';

const TIME = '551177776666'; // chave de telefone de NUMERO_TIME (sem o nono dígito)
const OBSERVADOR = '5511900000000';
const q = {
  ehDoTime: (n: string) => n === TIME,
  ehLidDoTime: (l: string) => l === '9@lid',
  observador: '551100000000', // chave de telefone de OBSERVADOR, como vem da configuração
};

describe('conversaDoEvento', () => {
  it('grupo e privada', () => {
    expect(conversaDoEvento(mensagemGrupo())).toMatchObject({ tipo: 'grupo', chatid: GRUPO, nomeGrupo: 'Cliente Teste | Grupo Silva' });
    expect(conversaDoEvento(mensagemPrivada())).toMatchObject({ tipo: 'privada', chatid: CHAT_PRIVADO, nomeGrupo: '' });
    expect(conversaDoEvento(mensagemPrivada({ chatid: LID_CLIENTE }))?.tipo).toBe('privada');
  });

  it('outros eventos e chats desconhecidos: nada', () => {
    expect(conversaDoEvento({ EventType: 'connection' })).toBeUndefined();
    expect(conversaDoEvento(mensagemPrivada({ chatid: 'status@broadcast' }))).toBeUndefined();
    expect(conversaDoEvento(mensagemPrivada({ chatid: '1@newsletter' }))).toBeUndefined();
    expect(conversaDoEvento(mensagemGrupo({ isGroup: false }))).toBeUndefined();
  });
});

describe('outroLadoDaPrivada', () => {
  const ler = (sobre: Record<string, unknown>, mapa: Record<string, string> = {}) =>
    outroLadoDaPrivada(conversaDoEvento(mensagemPrivada(sobre))!, (l) => mapa[l]);

  it('número pelo chatid (sem o nono dígito)', () => {
    expect(ler({})).toEqual({ numero: '551188887777', lid: LID_CLIENTE });
  });

  it('chatid @lid: número pelo sender_pn do cliente', () => {
    expect(ler({ chatid: LID_CLIENTE })).toEqual({ numero: '551188887777', lid: LID_CLIENTE });
  });

  it('chatid @lid e mensagem do especialista: número pelo mapa aprendido, senão só o LID', () => {
    const doEsp = { chatid: LID_CLIENTE, chatlid: '', fromMe: true, sender_pn: `${NUMERO_TIME}@s.whatsapp.net` };
    expect(ler(doEsp, { [LID_CLIENTE]: '5511988887777' })).toEqual({ numero: '551188887777', lid: LID_CLIENTE });
    expect(ler(doEsp)).toEqual({ lid: LID_CLIENTE });
  });

  it('identificador: número primeiro, LID depois, nada se não houver', () => {
    expect(identificadorDoOutroLado({ numero: '551188887777', lid: 'x@lid' })).toBe('pn:551188887777');
    expect(identificadorDoOutroLado({ lid: 'x@lid' })).toBe('lid:x@lid');
    expect(identificadorDoOutroLado({})).toBeUndefined();
  });
});

describe('classificarParticipantes', () => {
  it('todos do time (por número, JID ou LID): interna; o observador não conta', () => {
    expect(
      classificarParticipantes(
        [
          { PhoneNumber: '5511977776666' },
          { JID: '551177776666@s.whatsapp.net' },
          { JID: '9@lid' },
          { PhoneNumber: OBSERVADOR },
        ],
        q,
      ),
    ).toBe('interna');
  });

  it('alguém de fora: cliente', () => {
    expect(classificarParticipantes([{ PhoneNumber: '5511977776666' }, { PhoneNumber: '5511988887777' }], q)).toBe('cliente');
  });

  it('participante sem número e com LID desconhecido conta como de fora', () => {
    expect(classificarParticipantes([{ PhoneNumber: '5511977776666' }, { LID: '8@lid' }], q)).toBe('cliente');
    expect(classificarParticipantes([{ PhoneNumber: '5511977776666' }, {}], q)).toBe('cliente');
  });

  it('lista vazia: não classifica (tenta de novo depois)', () => {
    expect(classificarParticipantes([], q)).toBeUndefined();
  });

  it('sem OBSERVADOR_NUMERO, o observador conta como de fora', () => {
    expect(classificarParticipantes([{ PhoneNumber: OBSERVADOR }], { ...q, observador: undefined })).toBe('cliente');
  });
});
