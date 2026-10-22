import { describe, expect, it } from 'vitest';
import { CacheCadastro, type DadosCadastro } from '../src/cadastro.js';
import { RepositorioSupabase, type EventoBruto } from '../src/repositorio.js';
import { instanciaDoPayload } from '../src/webhook/validar.js';

const semLog = { info: () => {}, warn: () => {} };

describe('CacheCadastro', () => {
  it('antes da primeira carga, nenhum grupo passa', () => {
    const c = new CacheCadastro(async () => ({ gruposAtivos: ['1@g.us'], numerosTime: [] }), semLog);
    expect(c.pronto).toBe(false);
    expect(c.grupoAtivo('1@g.us')).toBe(false);
  });

  it('grupos ativos e números do time (com e sem o nono dígito, com sufixo)', async () => {
    const c = new CacheCadastro(
      async () => ({ gruposAtivos: ['1@g.us'], numerosTime: ['5511977776666'] }),
      semLog,
    );
    await c.atualizar();
    expect(c.grupoAtivo('1@g.us')).toBe(true);
    expect(c.grupoAtivo('2@g.us')).toBe(false);
    expect(c.ehDoTime('5511977776666@s.whatsapp.net')).toBe(true);
    expect(c.ehDoTime('551177776666')).toBe(true);
    expect(c.ehDoTime('5511988887777')).toBe(false);
    expect(c.ehDoTime('')).toBe(false);
  });

  it('primeira carga com erro: o erro sobe (o receptor não sobe sem cadastro)', async () => {
    const c = new CacheCadastro(async () => Promise.reject(new Error('banco fora')), semLog);
    await expect(c.atualizar()).rejects.toThrow('banco fora');
  });

  it('recarga com erro: mantém a última lista boa', async () => {
    let falhar = false;
    const avisos: string[] = [];
    const c = new CacheCadastro(
      async (): Promise<DadosCadastro> => {
        if (falhar) throw new Error('banco fora');
        return { gruposAtivos: ['1@g.us'], numerosTime: [] };
      },
      { info: () => {}, warn: (_o, m) => void avisos.push(m) },
    );
    await c.atualizar();
    falhar = true;
    await c.atualizar();
    expect(c.grupoAtivo('1@g.us')).toBe(true);
    expect(avisos).toHaveLength(1);
  });

  it('o log da carga tem só contagens', async () => {
    const logs: object[] = [];
    const c = new CacheCadastro(
      async () => ({ gruposAtivos: ['120363000000000001@g.us'], numerosTime: ['5511977776666'] }),
      { info: (o) => void logs.push(o), warn: () => {} },
    );
    await c.atualizar();
    expect(logs).toEqual([{ grupos_ativos: 1, time: 1 }]);
  });
});

describe('instanciaDoPayload', () => {
  const instancias = [
    { nome: 'observador', token: 'tok-a' },
    { nome: 'roni_ramos', token: 'tok-b' },
  ];
  it('identifica pelo token', () => {
    expect(instanciaDoPayload({ token: 'tok-b' }, instancias)?.nome).toBe('roni_ramos');
    expect(instanciaDoPayload({ token: 'tok-a' }, instancias)?.nome).toBe('observador');
  });
  it('token ausente, vazio ou desconhecido: nenhuma', () => {
    expect(instanciaDoPayload({}, instancias)).toBeUndefined();
    expect(instanciaDoPayload({ token: '' }, instancias)).toBeUndefined();
    expect(instanciaDoPayload({ token: 'tok-c' }, instancias)).toBeUndefined();
    expect(instanciaDoPayload('tok-a', instancias)).toBeUndefined();
  });
});

describe('RepositorioSupabase', () => {
  // Cliente falso: registra as chamadas, sem banco.
  function dbFalso(erroEm?: string) {
    const chamadas: { tabela: string; op: string; dados: unknown; opcoes?: unknown }[] = [];
    const db = {
      from: (tabela: string) => ({
        upsert: async (dados: unknown, opcoes: unknown) => {
          chamadas.push({ tabela, op: 'upsert', dados, opcoes });
          return { error: erroEm === tabela ? { message: 'falhou' } : null };
        },
        insert: async (dados: unknown) => {
          chamadas.push({ tabela, op: 'insert', dados });
          return { error: erroEm === tabela ? { message: 'falhou' } : null };
        },
      }),
    };
    return { db: db as never, chamadas };
  }

  const evento: EventoBruto = {
    recebido_em: '2026-10-22T12:00:00.000Z',
    evento: 'messages',
    id_mensagem: 'm1',
    instancia: 'roni_ramos',
    payload: { message: { messageid: 'm1' } },
    mensagem: {
      id_mensagem: 'm1',
      jid: '1@g.us',
      instancia: 'roni_ramos',
      autor_tipo: 'cliente',
      autor_numero: null,
      tipo: 'texto',
      conta: true,
      texto: '[texto omitido: 3 caracteres]',
      enviada_em: '2026-10-22T11:59:00.000Z',
    },
  };

  it('grava a mensagem (dedupe por id_mensagem) e depois o bruto, sem o campo mensagem', async () => {
    const { db, chamadas } = dbFalso();
    await new RepositorioSupabase(db).gravar(evento);
    expect(chamadas.map((c) => `${c.op}:${c.tabela}`)).toEqual(['upsert:mensagens', 'insert:eventos_brutos']);
    expect(chamadas[0]!.opcoes).toEqual({ onConflict: 'id_mensagem', ignoreDuplicates: true });
    expect(chamadas[1]!.dados).not.toHaveProperty('mensagem');
    expect(chamadas[1]!.dados).toMatchObject({ instancia: 'roni_ramos', id_mensagem: 'm1' });
  });

  it('falha em mensagens: erro e o bruto não é gravado (a fila tenta de novo)', async () => {
    const { db, chamadas } = dbFalso('mensagens');
    await expect(new RepositorioSupabase(db).gravar(evento)).rejects.toThrow('mensagens');
    expect(chamadas).toHaveLength(1);
  });
});
