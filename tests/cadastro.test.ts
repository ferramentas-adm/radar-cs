import { describe, expect, it } from 'vitest';
import { CacheCadastro, type DadosCadastro, type MembroCadastro } from '../src/cadastro.js';
import type { NovaConversa } from '../src/conversas/cadastrador.js';
import { gravarConversaSupabase, RepositorioSupabase, type EventoBruto } from '../src/repositorio.js';
import { instanciaDoPayload } from '../src/webhook/validar.js';

const semLog = { info: () => {}, warn: () => {} };
const membro = (o: Partial<MembroCadastro> = {}): MembroCadastro => ({
  nome: 'Roni Ramos',
  numero: '5511977776666',
  lid: null,
  instancia: null,
  gestor_padrao: null,
  ...o,
});
const dados = (o: Partial<DadosCadastro> = {}): DadosCadastro => ({ conversas: [], time: [], ...o });

describe('CacheCadastro', () => {
  it('antes da primeira carga, nenhuma conversa é conhecida', () => {
    const c = new CacheCadastro(async () => dados({ conversas: [{ jid: '1@g.us', ativo: true }] }), semLog);
    expect(c.pronto).toBe(false);
    expect(c.estado('1@g.us')).toBeUndefined();
  });

  it('conversas ativas e bloqueadas; números do time (com e sem o nono dígito, com sufixo)', async () => {
    const c = new CacheCadastro(
      async () =>
        dados({
          conversas: [
            { jid: '1@g.us', ativo: true },
            { jid: '3@g.us', ativo: false },
          ],
          time: [membro()],
        }),
      semLog,
    );
    await c.atualizar();
    expect(c.estado('1@g.us')).toBe('ativa');
    expect(c.estado('3@g.us')).toBe('inativa');
    expect(c.estado('2@g.us')).toBeUndefined();
    expect(c.ehDoTime('5511977776666@s.whatsapp.net')).toBe(true);
    expect(c.ehDoTime('551177776666')).toBe(true);
    expect(c.ehDoTime('5511988887777')).toBe(false);
    expect(c.ehDoTime('')).toBe(false);
  });

  it('dono da instância e gestor padrão; registrar entra no cache na hora', async () => {
    const c = new CacheCadastro(
      async () => dados({ time: [membro({ instancia: 'roni_ramos', gestor_padrao: 'Gestora' }), membro({ nome: 'Gestora', numero: '5511955554444' })] }),
      semLog,
    );
    await c.atualizar();
    expect(c.responsavel('roni_ramos')).toEqual({ especialista: 'Roni Ramos', gestor: 'Gestora' });
    expect(c.responsavel('outra')).toBeUndefined();
    c.registrar('9@g.us', true);
    expect(c.estado('9@g.us')).toBe('ativa');
  });

  it('LID do time: o da tabela e o aprendido dos eventos (que sobrevive à recarga)', async () => {
    const c = new CacheCadastro(async () => dados({ time: [membro({ lid: '1@lid' })] }), semLog);
    await c.atualizar();
    expect(c.ehLidDoTime('1@lid')).toBe(true);
    expect(c.ehLidDoTime('2@lid')).toBe(false);
    c.aprenderLid('2@lid', '5511977776666@s.whatsapp.net');
    c.aprenderLid('3@lid', '5511988887777');
    await c.atualizar();
    expect(c.ehLidDoTime('2@lid')).toBe(true);
    expect(c.ehLidDoTime('3@lid')).toBe(false);
    expect(c.numeroDoLid('3@lid')).toBe('551188887777');
    c.aprenderLid('sem-sufixo', '5511988887777');
    expect(c.numeroDoLid('sem-sufixo')).toBeUndefined();
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
        return dados({ conversas: [{ jid: '1@g.us', ativo: true }] });
      },
      { info: () => {}, warn: (_o, m) => void avisos.push(m) },
    );
    await c.atualizar();
    falhar = true;
    await c.atualizar();
    expect(c.estado('1@g.us')).toBe('ativa');
    expect(avisos).toHaveLength(1);
  });

  it('o log da carga tem só contagens', async () => {
    const logs: object[] = [];
    const c = new CacheCadastro(
      async () =>
        dados({
          conversas: [
            { jid: '120363000000000001@g.us', ativo: true },
            { jid: `privada:${'a'.repeat(64)}`, ativo: false },
          ],
          time: [membro({ instancia: 'roni_ramos' })],
        }),
      { info: (o) => void logs.push(o), warn: () => {} },
    );
    await c.atualizar();
    expect(logs).toEqual([{ conversas_ativas: 1, conversas_bloqueadas: 1, time: 1, instancias_com_dono: 1 }]);
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

describe('gravarConversaSupabase', () => {
  const nova: NovaConversa = {
    jid: '1@g.us',
    tipo: 'grupo',
    nome: 'Cliente',
    especialista: 'Roni Ramos',
    gestor: null,
    instancia: 'roni_ramos',
    origem: 'automatico',
    ativo: true,
    observador_entrou_em: '2026-10-22T12:00:00.000Z',
    chat_cifrado: null,
  };

  it('insere sem sobrescrever (ignoreDuplicates) e devolve o ativo que ficou no banco', async () => {
    const chamadas: unknown[] = [];
    const db = {
      from: () => ({
        upsert: async (_d: unknown, opcoes: unknown) => {
          chamadas.push(opcoes);
          return { error: null };
        },
        select: () => ({ eq: () => ({ single: async () => ({ data: { ativo: false }, error: null }) }) }),
      }),
    };
    expect(await gravarConversaSupabase(db as never)(nova)).toBe(false); // já existia, bloqueada
    expect(chamadas).toEqual([{ onConflict: 'jid', ignoreDuplicates: true }]);
  });
});
