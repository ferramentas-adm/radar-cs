import { describe, expect, it } from 'vitest';
import { Cadastrador, type DepsCadastrador, type NovaConversa } from '../src/conversas/cadastrador.js';
import { jidPrivada } from '../src/conversas/chave.js';
import { conversaDoEvento } from '../src/conversas/classificar.js';
import { ErroUazapi } from '../src/uazapi/cliente.js';
import { CHAVES, cadastroFixo } from './fixtures/cadastro.js';
import { GRUPO, NUMERO_CLIENTE, NUMERO_TIME, mensagemGrupo, mensagemPrivada } from './fixtures/payloads.js';

const RONI = { nome: 'roni_ramos', tipo: 'pessoa' } as const;
const FELIPE = { nome: 'felipe', tipo: 'pessoa' } as const;
const OBSERVADOR = { nome: 'observador', tipo: 'observador' } as const;
const ENVIADA = '2026-10-22T15:00:00.000Z';
const NOVO = '120363040009999@g.us';
const semLog = { info: () => {}, warn: () => {} };
const doTime = { chatid: NOVO, sender_pn: `${NUMERO_TIME}@s.whatsapp.net` };

function montar(extra: Partial<DepsCadastrador> = {}, participantes: () => Promise<{ PhoneNumber?: string }[]> = async () => [{ PhoneNumber: NUMERO_TIME }]) {
  const cadastradas: NovaConversa[] = [];
  const consultas: string[] = [];
  const cadastro = cadastroFixo({
    ativas: [GRUPO],
    time: [NUMERO_TIME],
    donos: { roni_ramos: { especialista: 'Roni Ramos', gestor: 'Gestora X' }, felipe: { especialista: 'Felipe', gestor: null } },
  });
  const c = new Cadastrador({
    cadastro,
    chaves: CHAVES,
    log: semLog,
    consultarParticipantes: async (_i, jid) => {
      consultas.push(jid);
      return participantes();
    },
    gravarConversa: async (n) => {
      cadastradas.push(n);
      return true;
    },
    ...extra,
  });
  const resolver = (payload: unknown, inst: typeof RONI | typeof FELIPE | typeof OBSERVADOR = RONI) =>
    c.resolver(conversaDoEvento(payload)!, inst, ENVIADA);
  return { c, cadastro, cadastradas, consultas, resolver };
}

describe('Cadastrador: conversa já cadastrada', () => {
  it('ativa grava; bloqueada descarta; nada é consultado', async () => {
    const { resolver, cadastro, consultas } = montar();
    expect(await resolver(mensagemGrupo())).toEqual({ acao: 'gravar', jid: GRUPO, nova: false });
    cadastro.registrar(GRUPO, false);
    expect(await resolver(mensagemGrupo())).toEqual({ acao: 'descartar', motivo: 'bloqueada' });
    expect(consultas).toEqual([]);
  });

  it('observador só aceita o que já está cadastrado', async () => {
    const { resolver, cadastradas } = montar();
    expect((await resolver(mensagemGrupo(), OBSERVADOR)).acao).toBe('gravar');
    expect(await resolver(mensagemGrupo({ chatid: NOVO }), OBSERVADOR)).toEqual({ acao: 'descartar', motivo: 'nao_cadastrada' });
    expect(await resolver(mensagemPrivada(), OBSERVADOR)).toEqual({ acao: 'descartar', motivo: 'privada_no_observador' });
    expect(cadastradas).toEqual([]);
  });
});

describe('Cadastrador: grupo novo', () => {
  it('cliente escreveu: grupo de cliente, cadastrado com o dono da instância', async () => {
    const { resolver, cadastradas, consultas, cadastro } = montar();
    expect(await resolver(mensagemGrupo({ chatid: NOVO }))).toEqual({ acao: 'gravar', jid: NOVO, nova: true });
    expect(consultas).toEqual([]);
    expect(cadastradas).toEqual([
      {
        jid: NOVO,
        tipo: 'grupo',
        nome: 'Cliente Teste | Grupo Silva',
        especialista: 'Roni Ramos',
        gestor: 'Gestora X',
        instancia: 'roni_ramos',
        origem: 'automatico',
        ativo: true,
        observador_entrou_em: ENVIADA,
        chat_cifrado: null,
      },
    ]);
    expect(cadastro.estado(NOVO)).toBe('ativa');
  });

  it('a primeira instância que vê fica dona: a segunda encontra o grupo já cadastrado', async () => {
    const { resolver, cadastradas } = montar();
    await resolver(mensagemGrupo({ chatid: NOVO }), FELIPE);
    expect(await resolver(mensagemGrupo({ chatid: NOVO, messageid: 'X2' }), RONI)).toMatchObject({ acao: 'gravar', nova: false });
    expect(cadastradas.map((c) => c.especialista)).toEqual(['Felipe']);
  });

  it('time escreveu e há alguém de fora: consulta e cadastra', async () => {
    const { resolver, consultas, cadastradas } = montar({}, async () => [{ PhoneNumber: NUMERO_TIME }, { PhoneNumber: NUMERO_CLIENTE }]);
    expect((await resolver(mensagemGrupo(doTime))).acao).toBe('gravar');
    expect(consultas).toEqual([NOVO]);
    expect(cadastradas).toHaveLength(1);
  });

  it('só o time: interna, em cache; cai quando alguém de fora escreve', async () => {
    let agora = 0;
    const { resolver, consultas, cadastradas } = montar({ agora: () => agora, validadeInternaMs: 1000 });
    expect(await resolver(mensagemGrupo(doTime))).toEqual({ acao: 'descartar', motivo: 'interna' });
    expect(await resolver(mensagemGrupo({ ...doTime, messageid: 'X2' }))).toEqual({ acao: 'descartar', motivo: 'interna' });
    expect(consultas).toHaveLength(1);
    agora = 1001; // venceu: consulta de novo
    await resolver(mensagemGrupo({ ...doTime, messageid: 'X3' }));
    expect(consultas).toHaveLength(2);
    // Um cliente entrou e escreveu: grupo de cliente na hora, sem consultar.
    expect((await resolver(mensagemGrupo({ chatid: NOVO, messageid: 'X4' }))).acao).toBe('gravar');
    expect(consultas).toHaveLength(2);
    expect(cadastradas).toHaveLength(1);
  });

  it('fromMe ou LID do time também contam como "time escreveu"', async () => {
    const { resolver, consultas } = montar();
    await resolver(mensagemGrupo({ chatid: NOVO, fromMe: true, sender_pn: '' }));
    expect(consultas).toHaveLength(1);
  });

  it('falha ou lista vazia na consulta: não cadastra; a próxima tenta de novo', async () => {
    let resposta: () => Promise<{ PhoneNumber?: string }[]> = async () => {
      throw new Error('uazapi /group/info: HTTP 500');
    };
    const { resolver, consultas, cadastradas } = montar({}, () => resposta());
    expect(await resolver(mensagemGrupo(doTime))).toEqual({ acao: 'descartar', motivo: 'falha_consulta' });
    resposta = async () => [];
    expect(await resolver(mensagemGrupo(doTime))).toEqual({ acao: 'descartar', motivo: 'falha_consulta' });
    resposta = async () => [{ PhoneNumber: NUMERO_CLIENTE }];
    expect((await resolver(mensagemGrupo(doTime))).acao).toBe('gravar');
    expect(consultas).toHaveLength(3);
    expect(cadastradas).toHaveLength(1);
  });

  it('429: espera o Retry-After antes de consultar de novo pela mesma instância', async () => {
    let agora = 0;
    let chamadas = 0;
    const { resolver } = montar({ agora: () => agora }, async () => {
      chamadas++;
      throw new ErroUazapi(429, '/group/info', 10);
    });
    await resolver(mensagemGrupo(doTime));
    agora = 9_999;
    expect(await resolver(mensagemGrupo(doTime))).toEqual({ acao: 'descartar', motivo: 'falha_consulta' });
    expect(chamadas).toBe(1);
    agora = 10_001;
    await resolver(mensagemGrupo(doTime));
    expect(chamadas).toBe(2);
  });

  it('mensagens simultâneas da mesma conversa nova: uma consulta e um cadastro', async () => {
    let liberar!: () => void;
    const { resolver, consultas, cadastradas } = montar({}, () =>
      new Promise((r) => (liberar = () => r([{ PhoneNumber: NUMERO_CLIENTE }]))),
    );
    const a = resolver(mensagemGrupo(doTime));
    const b = resolver(mensagemGrupo({ ...doTime, messageid: 'X2' }));
    await new Promise((r) => setImmediate(r));
    liberar();
    expect((await Promise.all([a, b])).map((r) => r.acao)).toEqual(['gravar', 'gravar']);
    expect([consultas.length, cadastradas.length]).toEqual([1, 1]);
  });

  it('sem UAZAPI_BASE_URL (sem consulta): grupo em que o time escreveu primeiro não cadastra', async () => {
    const { resolver } = montar({ consultarParticipantes: undefined });
    expect(await resolver(mensagemGrupo(doTime))).toEqual({ acao: 'descartar', motivo: 'falha_consulta' });
  });
});

describe('Cadastrador: privada e casos de borda', () => {
  it('privada de cliente: cadastra sem nome e sem observador_entrou_em', async () => {
    const { resolver, cadastradas } = montar();
    const r = await resolver(mensagemPrivada());
    const jid = jidPrivada('roni_ramos', 'pn:551188887777', CHAVES.conversa);
    expect(r).toEqual({ acao: 'gravar', jid, nova: true });
    expect(cadastradas[0]).toMatchObject({ jid, tipo: 'privada', nome: null, observador_entrou_em: null, especialista: 'Roni Ramos' });
  });

  it('privada interna (número ou LID do time): descarta sem cadastrar', async () => {
    const { resolver, cadastro, cadastradas } = montar();
    const chat = `${NUMERO_TIME}@s.whatsapp.net`;
    expect(await resolver(mensagemPrivada({ chatid: chat, sender_pn: chat }))).toEqual({ acao: 'descartar', motivo: 'interna' });
    cadastro.aprenderLid('5@lid', NUMERO_TIME);
    expect(await resolver(mensagemPrivada({ chatid: '5@lid', chatlid: '', fromMe: true, sender_pn: '' }))).toEqual({
      acao: 'descartar',
      motivo: 'interna',
    });
    expect(cadastradas).toEqual([]);
  });

  it('privada sem número nem LID: descarta', async () => {
    const { resolver } = montar();
    const r = await resolver(mensagemPrivada({ chatid: '@lid', chatlid: '', fromMe: true }));
    expect(r).toEqual({ acao: 'descartar', motivo: 'sem_identificador' });
  });

  it('privada sem as chaves: descarta (nunca guarda o número em claro)', async () => {
    const { resolver } = montar({ chaves: undefined });
    expect(await resolver(mensagemPrivada())).toEqual({ acao: 'descartar', motivo: 'nao_cadastrada' });
  });

  it('instância sem dono em time.instancia: não cadastra', async () => {
    const { resolver } = montar();
    const r = await resolver(mensagemGrupo({ chatid: NOVO }), { nome: 'sem_dono', tipo: 'pessoa' } as never);
    expect(r).toEqual({ acao: 'descartar', motivo: 'instancia_sem_dono' });
  });

  it('conversa que já existia no banco bloqueada (corrida com a recarga): descarta e fica no cache', async () => {
    const { resolver, cadastro } = montar({ gravarConversa: async () => false });
    expect(await resolver(mensagemGrupo({ chatid: NOVO }))).toEqual({ acao: 'descartar', motivo: 'bloqueada' });
    expect(cadastro.estado(NOVO)).toBe('inativa');
  });

  it('falha ao gravar a conversa: descarta e tenta de novo na próxima', async () => {
    let falhar = true;
    const { resolver } = montar({
      gravarConversa: async () => {
        if (falhar) throw new Error('supabase (grupos): falhou');
        return true;
      },
    });
    expect(await resolver(mensagemGrupo({ chatid: NOVO }))).toEqual({ acao: 'descartar', motivo: 'falha_cadastro' });
    falhar = false;
    expect((await resolver(mensagemGrupo({ chatid: NOVO }))).acao).toBe('gravar');
  });
});
