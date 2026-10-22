import { describe, expect, it } from 'vitest';
import type { DadosRadar } from '../src/api/dados.js';
import {
  buscarHistorico,
  emAlerta,
  formatarContagens,
  lerDias,
  mapaLids,
  motivoFalha,
  paraMotor,
  processarConversa,
  resolverAutor,
  semTimeNaJanela,
  type ContextoHistorico,
  type ConversaHistorico,
} from '../src/mensagens/historico.js';
import { ClienteUazapi, ErroUazapi } from '../src/uazapi/cliente.js';

const MIN = 60_000;
const DIA = 24 * 60 * MIN;
const sp = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00-03:00`);
const AG = sp('2026-10-20 15:00'); // terça, no meio do expediente
const DESDE = AG - 7 * DIA;

const GRUPO = '120363040001000@g.us';
const CHAT_PRIVADO = '5511944445555@s.whatsapp.net';
const NUMERO_TIME = '5511988887777';
const LID_TIME = '999000111@lid';
const LID_APRENDIDO = '888000222@lid';
const NUMERO_APRENDIDO = '5511966665555';
const LID_CLIENTE = '777000333@lid';
const TEXTO = 'quero o boleto do mês passado';

let seq = 0;
function msg(sobre: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageid: `3EB0H${seq++}`,
    chatid: GRUPO,
    sender: LID_CLIENTE,
    sender_pn: '551133334444@s.whatsapp.net',
    sender_lid: LID_CLIENTE,
    fromMe: false,
    isGroup: true,
    messageType: 'Conversation',
    messageTimestamp: AG - 60 * MIN,
    text: TEXTO,
    ...sobre,
  };
}

function fetchFalso(respostas: Response[]) {
  const corpos: unknown[] = [];
  const rotas: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    rotas.push(new URL(url).pathname);
    corpos.push(JSON.parse(String(init?.body)));
    const r = respostas.shift();
    if (!r) throw new Error('chamada a mais');
    return r;
  }) as typeof fetch;
  return { fn, corpos, rotas };
}
const json = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200 });
const pagina = (messages: unknown[], hasMore: boolean, nextOffset?: number) =>
  json({ messages, pagination: { limit: messages.length, offset: 0, hasMore, ...(nextOffset === undefined ? {} : { nextOffset }) } });

describe('lerDias', () => {
  it('padrão 7; aceita 1 a 7; recusa o resto', () => {
    expect(lerDias([])).toBe(7);
    expect(lerDias(['--dias', '2'])).toBe(2);
    for (const argv of [['--dias'], ['--dias', '0'], ['--dias', '8'], ['--dias', '1.5'], ['--dias', 'x']]) {
      expect(() => lerDias(argv)).toThrow('--dias');
    }
  });
});

describe('buscarHistorico', () => {
  it('POST /message/find por chatid; pagina até a mais antiga passar da janela; pausa antes de cada chamada', async () => {
    const { fn, corpos, rotas } = fetchFalso([
      pagina([msg({ messageTimestamp: AG - DIA }), msg({ messageTimestamp: AG - 2 * DIA })], true, 2),
      pagina([msg({ messageTimestamp: AG - 6 * DIA }), msg({ messageTimestamp: AG - 8 * DIA })], true, 4),
    ]);
    const esperas: number[] = [];
    const h = await buscarHistorico(new ClienteUazapi('https://uazapi.teste', 'tk', fn), GRUPO, DESDE, {
      pagina: 2,
      pausaMs: 300,
      esperar: async (ms) => void esperas.push(ms),
    });
    expect(h.mensagens).toHaveLength(4);
    expect(h.noTeto).toBe(false);
    expect(rotas).toEqual(['/message/find', '/message/find']);
    expect(corpos).toEqual([
      { chatid: GRUPO, limit: 2, offset: 0 },
      { chatid: GRUPO, limit: 2, offset: 2 },
    ]);
    expect(esperas).toEqual([300, 300]);
  });

  it('para quando acaba o histórico (hasMore = false)', async () => {
    const { fn } = fetchFalso([pagina([msg()], false)]);
    const h = await buscarHistorico(new ClienteUazapi('https://u.teste', 'tk', fn), GRUPO, DESDE, { esperar: async () => {} });
    expect(h.mensagens).toHaveLength(1);
  });

  it('para no teto e avisa', async () => {
    const { fn, corpos } = fetchFalso([pagina([msg(), msg()], true, 2), pagina([msg()], true, 3)]);
    const h = await buscarHistorico(new ClienteUazapi('https://u.teste', 'tk', fn), GRUPO, DESDE, {
      pagina: 2,
      teto: 3,
      esperar: async () => {},
    });
    expect(h).toMatchObject({ noTeto: true });
    expect(h.mensagens).toHaveLength(3);
    expect(corpos[1]).toEqual({ chatid: GRUPO, limit: 1, offset: 2 });
  });

  it('429 espera o Retry-After e tenta de novo; erro definitivo sobe', async () => {
    const { fn } = fetchFalso([new Response('', { status: 429, headers: { 'retry-after': '7' } }), pagina([msg()], false)]);
    const esperas: number[] = [];
    await buscarHistorico(new ClienteUazapi('https://u.teste', 'tk', fn), GRUPO, DESDE, {
      pausaMs: 300,
      esperar: async (ms) => void esperas.push(ms),
    });
    expect(esperas).toEqual([300, 7000]);

    const falso = fetchFalso([new Response('', { status: 404 })]);
    const erro = await buscarHistorico(new ClienteUazapi('https://u.teste', 'tk', falso.fn), GRUPO, DESDE, { esperar: async () => {} }).catch((e) => e);
    expect(erro).toBeInstanceOf(ErroUazapi);
    expect(motivoFalha(erro)).toBe('HTTP 404');
    expect(motivoFalha(new Error(GRUPO))).toBe('outro erro');
  });
});

describe('autor do histórico', () => {
  const time = [{ numero: NUMERO_TIME, lid: LID_TIME }];

  it('mapa LID → número: time.lid e pares vistos no histórico', () => {
    const lids = mapaLids(time, [msg({ sender_lid: LID_APRENDIDO, sender_pn: `${NUMERO_APRENDIDO}@s.whatsapp.net` })]);
    expect(lids.get(LID_TIME)).toBe(NUMERO_TIME);
    expect(lids.get(LID_APRENDIDO)).toBe(NUMERO_APRENDIDO);
  });

  it('sender_pn primeiro; sem ele, LID (sender_lid ou sender @lid); sem achar, não identificado', () => {
    const lids = mapaLids(time, []);
    expect(resolverAutor(msg(), lids).identificado).toBe(true);
    expect(resolverAutor(msg({ fromMe: true, sender_pn: '' }), lids).identificado).toBe(true);
    const porLid = resolverAutor(msg({ sender_pn: null, sender_lid: LID_TIME }), lids);
    expect(porLid).toMatchObject({ identificado: true, mensagem: { sender_pn: `${NUMERO_TIME}@s.whatsapp.net` } });
    const porSender = resolverAutor(msg({ sender_pn: '', sender_lid: '', sender: LID_TIME }), lids);
    expect(porSender.identificado).toBe(true);
    expect(resolverAutor(msg({ sender_pn: null }), lids).identificado).toBe(false);
  });
});

describe('processarConversa', () => {
  const grupo: ConversaHistorico = { jid: GRUPO, tipo: 'grupo', chatid: GRUPO };
  const ctx = (): ContextoHistorico => ({
    instancia: 'roni_ramos',
    ehDoTime: (n) => n.replace(/\D/g, '') === NUMERO_TIME,
    lids: mapaLids([{ numero: NUMERO_TIME, lid: LID_TIME }], []),
    desde: DESDE,
    agora: AG,
  });

  it('mesmo normalizador do webhook: texto mascarado, regra de contar, fromMe da pessoa é time', () => {
    const r = processarConversa(
      grupo,
      [
        msg({ messageid: 'A1' }),
        msg({ messageid: 'A2', fromMe: true, sender_pn: '' }),
        msg({ messageid: 'A3', messageType: 'ReactionMessage', text: '👍' }),
        msg({ messageid: 'A4', messageType: 'ImageMessage', text: '' }),
      ],
      ctx(),
    );
    expect(r.validas.map((m) => [m.id_mensagem, m.autor_tipo, m.conta])).toEqual([
      ['A1', 'cliente', true],
      ['A2', 'time', true],
      ['A3', 'cliente', false],
      ['A4', 'cliente', false],
    ]);
    expect(r.validas[0]).toMatchObject({ jid: GRUPO, instancia: 'roni_ramos', autor_numero: null, texto: `[texto omitido: ${TEXTO.length} caracteres]` });
    expect(JSON.stringify(r)).not.toContain(TEXTO);
  });

  it('descarta sem data válida, mais antiga que a janela, de outra conversa e duplicada', () => {
    const r = processarConversa(
      grupo,
      [
        msg({ messageid: 'B1', messageTimestamp: 0 }),
        msg({ messageid: 'B2', messageTimestamp: 'x' }),
        msg({ messageid: 'B3', messageTimestamp: AG + 60 * MIN }), // no futuro
        msg({ messageid: 'B4', messageTimestamp: DESDE - 1 }),
        msg({ messageid: 'B5', chatid: '120363040002000@g.us' }),
        msg({ messageid: 'B6' }),
        msg({ messageid: 'B6' }),
      ],
      ctx(),
    );
    expect(r).toMatchObject({ lidas: 7, semData: 3, foraDaJanela: 1, outraConversa: 1 });
    expect(r.validas.map((m) => m.id_mensagem)).toEqual(['B6']);
  });

  it('autor pelo LID do time vira time com o número; sem identificar vira cliente e é contado', () => {
    const r = processarConversa(
      grupo,
      [msg({ messageid: 'C1', sender_pn: null, sender_lid: LID_TIME }), msg({ messageid: 'C2', sender_pn: null })],
      ctx(),
    );
    expect(r.validas.map((m) => [m.autor_tipo, m.autor_numero])).toEqual([
      ['time', NUMERO_TIME],
      ['cliente', null],
    ]);
    expect(r.naoIdentificados).toBe(1);
  });

  it('privada: grava com o jid privada:, nunca com o chatid', () => {
    const privada: ConversaHistorico = { jid: 'privada:abc', tipo: 'privada', chatid: CHAT_PRIVADO };
    const r = processarConversa(privada, [msg({ messageid: 'D1', chatid: CHAT_PRIVADO, isGroup: false })], ctx());
    expect(r.validas[0]?.jid).toBe('privada:abc');
    expect(JSON.stringify(r.validas)).not.toContain('5511944445555');
  });

  it('grupo sem mensagem do time que conta na janela', () => {
    const r = processarConversa(grupo, [msg({ messageid: 'E1' }), msg({ messageid: 'E2', fromMe: true, messageType: 'ReactionMessage' })], ctx());
    expect(semTimeNaJanela(grupo, r.validas)).toBe(true);
    const r2 = processarConversa(grupo, [msg({ messageid: 'E3', fromMe: true })], ctx());
    expect(semTimeNaJanela(grupo, r2.validas)).toBe(false);
    expect(semTimeNaJanela({ ...grupo, tipo: 'privada' }, r.validas)).toBe(false);
  });
});

describe('mudança de estado pelo motor', () => {
  const dados = (sobre: Partial<DadosRadar> = {}): DadosRadar => ({
    grupos: [
      { id_grupo: GRUPO, cliente: 'Cliente', especialista: 'Roni Ramos', gestor: 'G', ativo: true, observador_entrou_em: AG - 10 * MIN, tipo: 'grupo' },
      { id_grupo: 'privada:abc', cliente: '', especialista: 'Roni Ramos', gestor: 'G', ativo: true, observador_entrou_em: null, tipo: 'privada' },
    ],
    mensagens: [],
    calendario: {
      expediente: { hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
      feriados: new Set(),
    },
    prazo: { minutos_aviso: 20, minutos_gestor: 31 },
    ultimaMensagemEm: null,
    ...sobre,
  });
  const m = (id: string, jid: string, autor: 'cliente' | 'time', minutos: number) => ({
    id_mensagem: id,
    id_grupo: jid,
    autor_tipo: autor,
    enviada_em: AG - minutos * MIN,
  });

  it('ok → alerta: cliente sem resposta aparece no histórico', () => {
    expect(emAlerta(dados(), GRUPO, AG)).toBe(false);
    expect(emAlerta(dados(), GRUPO, AG, [m('x1', GRUPO, 'cliente', 60)])).toBe(true);
  });

  it('alerta → ok: resposta do time aparece no histórico', () => {
    const d = dados({ mensagens: [m('y1', GRUPO, 'cliente', 60)] });
    expect(emAlerta(d, GRUPO, AG)).toBe(true);
    expect(emAlerta(d, GRUPO, AG, [m('y2', GRUPO, 'time', 30)])).toBe(false);
  });

  it('privada conta pelo "sem resposta"; conversa fora dos dados nunca está em alerta', () => {
    expect(emAlerta(dados(), 'privada:abc', AG, [m('z1', 'privada:abc', 'cliente', 60)])).toBe(true);
    expect(emAlerta(dados(), 'outro@g.us', AG, [m('z2', 'outro@g.us', 'cliente', 600)])).toBe(false);
  });

  it('paraMotor só leva as que contam', () => {
    const r = processarConversa(
      { jid: GRUPO, tipo: 'grupo', chatid: GRUPO },
      [msg({ messageid: 'F1' }), msg({ messageid: 'F2', messageType: 'StickerMessage' })],
      { instancia: 'roni_ramos', ehDoTime: () => false, lids: new Map(), desde: DESDE, agora: AG },
    );
    expect(paraMotor(r.validas).map((x) => x.id_mensagem)).toEqual(['F1']);
  });
});

describe('formatarContagens', () => {
  it('só contagens, sem nome, número, jid ou texto', () => {
    const s = formatarContagens(
      {
        conversas: 3,
        lidas: 2,
        falhas: new Map([['HTTP 404', 1]]),
        noTeto: 0,
        mensagensLidas: 10,
        novas: 6,
        existentes: 2,
        semData: 1,
        foraDaJanela: 1,
        outraConversa: 0,
        naoIdentificados: 1,
        alertaParaOk: 1,
        okParaAlerta: 2,
        gruposSemTime: 1,
        gravadas: 6,
      },
      7,
      true,
    );
    expect(s).toContain('novas: 6 · já existentes: 2');
    expect(s).toContain('descartadas por data: 2');
    expect(s).toContain('alerta → ok: 1 · ok → alerta: 2');
    expect(s).toContain('grupos sem mensagem do time na janela: 1');
    expect(s).toContain('com falha: 1 (HTTP 404: 1)');
    expect(s).toContain('gravadas: 6');
    expect(s).not.toMatch(/\d{10,}|@g\.us|@lid|privada:/);
  });
});
