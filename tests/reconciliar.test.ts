import { describe, expect, it } from 'vitest';
import { carregarTime, reconciliarInstancia } from '../src/instancias/reconciliar.js';

/** Fake mínimo do BancoRadar: uma tabela por nome, cada uma com seu próprio encadeamento. */
function criarFakeDb(tabelas: Record<string, unknown>) {
  return { from: (tabela: string) => tabelas[tabela] };
}

const GRUPO = { jid: '1@g.us', tipo: 'grupo' as const, chat_cifrado: null };

function fakeGrupos(linhas: unknown[]) {
  return { select: () => ({ eq: () => ({ eq: async () => ({ data: linhas, error: null }) }) }) };
}

function fakeTime(linhas: unknown[]) {
  return { select: () => ({ eq: async () => ({ data: linhas, error: null }) }) };
}

function fakeMensagens(existentesIds: string[], chamadas: { upserts: unknown[] }) {
  return {
    select: () => ({ in: async () => ({ data: existentesIds.map((id_mensagem) => ({ id_mensagem })), error: null }) }),
    upsert: async (linhas: unknown, opcoes: unknown) => {
      chamadas.upserts.push({ linhas, opcoes });
      return { error: null };
    },
  };
}

function fakeSyncEstado(linhaInicial: { ultima_mensagem_em: string | null; ultimo_status: string | null } | null, chamadas: { upserts: unknown[] }) {
  return {
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linhaInicial, error: null }) }) }),
    upsert: async (linha: unknown) => {
      chamadas.upserts.push(linha);
      return { error: null };
    },
  };
}

const bruta = (over: Partial<Record<string, unknown>> = {}) => ({
  chatid: '1@g.us',
  messageid: 'm1',
  messageType: 'Conversation',
  text: 'oi',
  messageTimestamp: Date.now() - 60_000,
  fromMe: false,
  sender_pn: '5511999999999@s.whatsapp.net',
  ...over,
});

describe('carregarTime', () => {
  it('ehDoTime reconhece só dígitos, ignorando formatação', async () => {
    const db = criarFakeDb({ time: fakeTime([{ numero: '(55) 11 99999-9999', lid: null }]) });
    const { ehDoTime } = await carregarTime(db as never);
    expect(ehDoTime('5511999999999')).toBe(true);
    expect(ehDoTime('5511888888888')).toBe(false);
  });
});

describe('reconciliarInstancia', () => {
  it('grava só a mensagem nova (dedupe por messageid) e avança o marcador', async () => {
    const mensagensChamadas = { upserts: [] as unknown[] };
    const syncChamadas = { upserts: [] as unknown[] };
    const db = criarFakeDb({
      sync_estado: fakeSyncEstado(null, syncChamadas),
      grupos: fakeGrupos([GRUPO]),
      time: fakeTime([]),
      mensagens: fakeMensagens([], mensagensChamadas),
    });
    const uazapi = { buscarMensagens: async () => ({ messages: [bruta()], pagination: { hasMore: false } }) };

    const r = await reconciliarInstancia(db as never, 'roni_ramos', uazapi, undefined);

    expect(r).toEqual({ instancia: 'roni_ramos', conversas: 1, falhas: 0, novas: 1 });
    expect(mensagensChamadas.upserts).toHaveLength(1);
    expect(syncChamadas.upserts).toHaveLength(1); // avançou o marcador
  });

  it('mensagem já existente: não grava de novo, mas avança o marcador', async () => {
    const mensagensChamadas = { upserts: [] as unknown[] };
    const syncChamadas = { upserts: [] as unknown[] };
    const db = criarFakeDb({
      sync_estado: fakeSyncEstado(null, syncChamadas),
      grupos: fakeGrupos([GRUPO]),
      time: fakeTime([]),
      mensagens: fakeMensagens(['m1'], mensagensChamadas),
    });
    const uazapi = { buscarMensagens: async () => ({ messages: [bruta()], pagination: { hasMore: false } }) };

    const r = await reconciliarInstancia(db as never, 'roni_ramos', uazapi, undefined);

    expect(r.novas).toBe(0);
    expect(mensagensChamadas.upserts).toHaveLength(0);
    expect(syncChamadas.upserts).toHaveLength(1);
  });

  it('falha ao buscar a conversa: não avança o marcador (tenta de novo na próxima rodada)', async () => {
    const mensagensChamadas = { upserts: [] as unknown[] };
    const syncChamadas = { upserts: [] as unknown[] };
    const db = criarFakeDb({
      sync_estado: fakeSyncEstado(null, syncChamadas),
      grupos: fakeGrupos([GRUPO]),
      time: fakeTime([]),
      mensagens: fakeMensagens([], mensagensChamadas),
    });
    const uazapi = {
      buscarMensagens: async () => {
        throw new Error('uazapi fora do ar');
      },
    };

    const r = await reconciliarInstancia(db as never, 'roni_ramos', uazapi, undefined);

    expect(r).toEqual({ instancia: 'roni_ramos', conversas: 1, falhas: 1, novas: 0 });
    expect(syncChamadas.upserts).toHaveLength(0); // não avançou
  });

  it('nenhuma conversa desta instância: não falha, não grava nada', async () => {
    const mensagensChamadas = { upserts: [] as unknown[] };
    const syncChamadas = { upserts: [] as unknown[] };
    const db = criarFakeDb({
      sync_estado: fakeSyncEstado(null, syncChamadas),
      grupos: fakeGrupos([]),
      time: fakeTime([]),
      mensagens: fakeMensagens([], mensagensChamadas),
    });
    const uazapi = { buscarMensagens: async () => ({ messages: [], pagination: { hasMore: false } }) };

    const r = await reconciliarInstancia(db as never, 'roni_ramos', uazapi, undefined);

    expect(r).toEqual({ instancia: 'roni_ramos', conversas: 0, falhas: 0, novas: 0 });
    expect(syncChamadas.upserts).toHaveLength(1);
  });
});
