import { describe, expect, it } from 'vitest';
import type { QuemEhDoTime } from '../src/conversas/classificar.js';
import { chaveTelefone } from '../src/grupos/exportar.js';
import {
  classificarListados,
  formatarVarredura,
  listarComSeguranca,
  novaConversaDeGrupo,
  simularPresencas,
  simularVarreduras,
} from '../src/grupos/varrer.js';
import { ClienteUazapi, ErroUazapi, type Grupo, type ParticipanteGrupo } from '../src/uazapi/cliente.js';

const TIME = '5511988887777';
const CLIENTE = '551133334444';
const daTime = { JID: '111@lid', LID: '111@lid', PhoneNumber: `${TIME}@s.whatsapp.net` };
const doCliente = { JID: '222@lid', LID: '222@lid', PhoneNumber: `${CLIENTE}@s.whatsapp.net` };

const quem: QuemEhDoTime = {
  ehDoTime: (n) => chaveTelefone(n) === chaveTelefone(TIME),
  ehLidDoTime: (l) => l === '111@lid',
};

function fetchFalso(respostas: Response[]) {
  const rotas: string[] = [];
  const fn = (async (url: string) => {
    rotas.push(new URL(url).pathname);
    const r = respostas.shift();
    if (!r) throw new Error('chamada a mais');
    return r;
  }) as typeof fetch;
  return { fn, rotas };
}
const json = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200 });
const conectada = () => json({ instance: { status: 'connected' } });
const pagina = (groups: Grupo[], hasMore = false, nextOffset?: number) =>
  json({ groups, pagination: { hasMore, ...(nextOffset === undefined ? {} : { nextOffset }) } });
const semEspera = async () => {};
const cliente = (respostas: Response[]) => {
  const f = fetchFalso(respostas);
  return { uazapi: new ClienteUazapi('https://u.teste', 'tk', f.fn), rotas: f.rotas };
};

const G = (n: number, participantes: ParticipanteGrupo[] = [daTime, doCliente]): Grupo => ({ JID: `12036300000000${n}@g.us`, Name: `Cliente ${n}`, Participants: participantes });

describe('listarComSeguranca', () => {
  it('conectada e todas as páginas: ok', async () => {
    const { uazapi, rotas } = cliente([conectada(), pagina([G(1)], true, 1), pagina([G(2)])]);
    const l = await listarComSeguranca(uazapi, undefined, semEspera);
    expect(l.ok && l.grupos.map((g) => g.JID)).toHaveLength(2);
    expect(rotas).toEqual(['/instance/status', '/group/list', '/group/list']);
  });

  it('desconectada: não lista', async () => {
    const { uazapi, rotas } = cliente([json({ instance: { status: 'disconnected' } })]);
    expect(await listarComSeguranca(uazapi, 10, semEspera)).toEqual({ ok: false, motivo: 'desconectada' });
    expect(rotas).toEqual(['/instance/status']);
  });

  it('erro numa página ou 429 que não passa: erro (lista parcial nunca vale)', async () => {
    const quebra = cliente([conectada(), pagina([G(1)], true, 1), new Response('', { status: 500 })]);
    expect(await listarComSeguranca(quebra.uazapi, undefined, semEspera)).toEqual({ ok: false, motivo: 'erro', detalhe: 'HTTP 500' });
    const r429 = () => new Response('', { status: 429, headers: { 'retry-after': '1' } });
    const limite = cliente([conectada(), r429(), r429(), r429(), r429()]);
    expect(await listarComSeguranca(limite.uazapi, undefined, semEspera)).toEqual({ ok: false, motivo: 'erro', detalhe: 'HTTP 429' });
  });

  it('lista vazia ou com menos da metade da última varredura: suspeita', async () => {
    expect(await listarComSeguranca(cliente([conectada(), pagina([])]).uazapi, undefined, semEspera)).toEqual({ ok: false, motivo: 'vazia' });
    const poucos = cliente([conectada(), pagina([G(1), G(2)])]);
    expect(await listarComSeguranca(poucos.uazapi, 5, semEspera)).toEqual({ ok: false, motivo: 'queda' });
    const metade = cliente([conectada(), pagina([G(1), G(2)])]);
    expect((await listarComSeguranca(metade.uazapi, 4, semEspera)).ok).toBe(true);
  });
});

describe('classificarListados', () => {
  it('já cadastrados, internos e de cliente; lista vazia consulta /group/info com pausa', async () => {
    const esperas: number[] = [];
    const consultas: string[] = [];
    const c = await classificarListados(
      [G(1), G(2, [daTime]), G(3, []), G(4)],
      new Set([G(4).JID]),
      quem,
      async (jid) => {
        consultas.push(jid);
        return [daTime, doCliente];
      },
      { pausaMs: 300, esperar: async (ms) => void esperas.push(ms) },
    );
    expect(c.aCadastrar.map((g) => g.JID)).toEqual([G(1).JID, G(3).JID]);
    expect([c.listados, c.jaCadastrados, c.internos, c.falhas]).toEqual([4, 1, 1, 0]);
    expect(consultas).toEqual([G(3).JID]);
    expect(esperas).toEqual([300]);
  });

  it('consulta que falha ou volta sem participantes: falha, nunca cadastra', async () => {
    const c = await classificarListados([G(1, []), G(2, [])], new Set(), quem, async (jid) => {
      if (jid === G(1).JID) throw new ErroUazapi(500, '/group/info', undefined);
      return [];
    }, { esperar: semEspera });
    expect([c.falhas, c.aCadastrar.length]).toEqual([2, 0]);
  });

  it('participante só com LID desconhecido conta como de fora', async () => {
    const c = await classificarListados([G(1, [daTime, { JID: '999@lid', LID: '999@lid' }])], new Set(), quem, async () => [], { esperar: semEspera });
    expect(c.aCadastrar).toHaveLength(1);
  });
});

describe('novaConversaDeGrupo e simulação', () => {
  it('grupo provisório do dono (automático, sem principal definido)', () => {
    expect(novaConversaDeGrupo(G(1), { especialista: 'Ana', gestor: 'Julia' }, 'ana', '2026-10-23T15:00:00.000Z')).toEqual({
      jid: G(1).JID,
      tipo: 'grupo',
      nome: 'Cliente 1',
      especialista: 'Ana',
      gestor: 'Julia',
      instancia: 'ana',
      origem: 'automatico',
      ativo: true,
      observador_entrou_em: '2026-10-23T15:00:00.000Z',
      chat_cifrado: null,
    });
  });

  it('presença simulada: troca só a desta instância e só grupos cadastrados', () => {
    const p = simularPresencas(
      [
        { jid: 'a@g.us', instancia: 'ana' },
        { jid: 'b@g.us', instancia: 'bruno' },
      ],
      'ana',
      ['c@g.us', 'x@g.us', 'c@g.us'],
      new Set(['a@g.us', 'b@g.us', 'c@g.us']),
    );
    expect(p).toEqual([
      { jid: 'b@g.us', instancia: 'bruno' },
      { jid: 'c@g.us', instancia: 'ana' },
    ]);
    expect(simularVarreduras([{ instancia: 'ana', concluida_em: 'x' }], 'ana', 'agora')).toEqual([{ instancia: 'ana', concluida_em: 'agora' }]);
  });
});

describe('formatarVarredura', () => {
  const responsaveis = { trocas: [], sugeridas: 2, aguardando: 1, aguardandoLista: [], semVarreduraRecente: [] };

  it('só contagens: sem nome de grupo, número ou jid', async () => {
    const grupos = [G(1), G(2)];
    const s = formatarVarredura(
      {
        listagem: { ok: true, grupos },
        classificacao: { listados: 2, jaCadastrados: 0, internos: 1, aCadastrar: [G(1)], falhas: 0 },
        cadastrados: 1,
        falhasCadastro: 0,
        presencasGravadas: 1,
        responsaveis,
        trocasGravadas: 0,
      },
      true,
    );
    expect(s).toContain('listados: 2 · já cadastrados: 0 · internos: 1 · de cliente a cadastrar: 1 · falhas: 0');
    expect(s).toContain('trocas automáticas: 0 · sugeridas: 2 · aguardando definição: 1');
    expect(s).not.toMatch(/Cliente|@g\.us|\d{10,}/);
  });

  it('listagem ruim e instâncias sem varredura recente', () => {
    const s = formatarVarredura(
      {
        listagem: { ok: false, motivo: 'erro', detalhe: 'HTTP 429' },
        classificacao: undefined,
        responsaveis: { trocas: [], sugeridas: 0, aguardando: 0, aguardandoLista: [], semVarreduraRecente: ['bruno', 'caio'] },
      },
      false,
    );
    expect(s).toContain('listagem não confiável: erro na listagem (HTTP 429)');
    expect(s).toContain('presença anterior mantida');
    expect(s).toContain('2 instância(s) de especialista sem varredura boa nas últimas 24 h: bruno, caio');
    expect(s).not.toContain('trocas automáticas');
  });
});
