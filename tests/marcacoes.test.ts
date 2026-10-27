import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { montarDadosRadar, type RadarDadosJson } from '../src/api/dados.js';
import {
  JANELA_MIN,
  encerrarMarcacoes,
  servicoMarcacoesSupabase,
  validarMarcacao,
  type ResultadoMarcar,
  type ServicoMarcacoes,
} from '../src/marcacoes/servico.js';
import { calcular, type EntradaMotor, type GrupoMotor, type MarcacaoMotor, type MensagemMotor } from '../src/motor/calcular.js';
import type { Calendario } from '../src/motor/expediente.js';
import { buildApp } from '../src/server.js';
import { cadastroFixo } from './fixtures/cadastro.js';
import { GRUPO, SEGREDO, TOKEN } from './fixtures/payloads.js';

const MIN = 60_000;
const sp = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00-03:00`);
const AG = sp('2026-10-20 15:00'); // terça, meio do expediente
const ago = (m: number) => AG - m * MIN;
const cal: Calendario = {
  expediente: { hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
  feriados: new Set(),
};

// ---------- motor ----------
function rodar(marcacao: Partial<MarcacaoMotor> | null, opcoes: { time?: number[]; cliente?: number[]; agora?: number } = {}) {
  const grupo: GrupoMotor = {
    id_grupo: GRUPO,
    cliente: 'Cliente',
    especialista: 'Esp',
    gestor: 'Gest',
    ativo: true,
    observador_entrou_em: null,
    ...(marcacao
      ? { marcacao: { como: 'ligacao', marcado_por: 'radar', marcado_em: ago(60), volta_em: ago(-120), ...marcacao } }
      : {}),
  };
  const mensagens: MensagemMotor[] = [
    ...(opcoes.time ?? [ago(300)]).map((t, i) => ({ id_mensagem: `t${i}`, id_grupo: GRUPO, autor_tipo: 'time' as const, enviada_em: t })),
    ...(opcoes.cliente ?? [ago(100)]).map((t, i) => ({ id_mensagem: `c${i}`, id_grupo: GRUPO, autor_tipo: 'cliente' as const, enviada_em: t })),
  ];
  const e: EntradaMotor = {
    agora: opcoes.agora ?? AG,
    grupos: [grupo],
    mensagens,
    calendario: cal,
    prazo: { minutos_aviso: 20, minutos_gestor: 31 },
    observador: { status: 'conectado', desde: null },
    ultimaMensagemEm: null,
    usuario: { nome: 'p', pode_marcar: true },
    recursos: { marcacoes: true },
  };
  return calcular(e);
}

describe('motor: ação feita por fora', () => {
  it('sem marcação o alerta fica em "Precisam de ação"', () => {
    const r = rodar(null);
    expect(r.alertas).toHaveLength(1);
    expect(r.resolvidos_por_fora).toEqual([]);
    expect(r.alertas[0]!.voltou_de_marcacao).toBeNull();
  });

  it('dentro da janela: sai dos alertas e entra em "ações feitas por fora", com a hora da volta', () => {
    const r = rodar({});
    expect(r.alertas).toHaveLength(0);
    expect(r.resolvidos_por_fora).toEqual([
      {
        id_grupo: GRUPO,
        cliente: 'Cliente',
        especialista: 'Esp',
        marcado_por: 'radar',
        como: 'ligacao',
        marcado_em: new Date(ago(60)).toISOString(),
        volta_em: new Date(ago(-120)).toISOString(),
      },
    ]);
    expect(r.por_especialista[0]!.clientes[0]!.estado).toBe('resolvido_por_fora');
    expect(r.resumo.em_alerta).toBe(0);
  });

  it('mensagem do time depois da ação encerra a marcação: nada de resolvido e alerta normal só se houver motivo', () => {
    const r = rodar({}, { time: [ago(300), ago(30)], cliente: [ago(100)] });
    // O time escreveu depois do cliente: sem "sem resposta"; sem contato ainda no prazo.
    expect(r.alertas).toHaveLength(0);
    expect(r.resolvidos_por_fora).toEqual([]);
  });

  it('resposta do time 1 minuto antes de a janela acabar encerra; sem resposta ela volta em gestor', () => {
    const volta = ago(-120);
    const aos2h59 = rodar({ volta_em: volta }, { agora: volta - MIN, time: [ago(300), volta - 2 * MIN], cliente: [ago(100)] });
    expect(aos2h59.alertas).toHaveLength(0);
    expect(aos2h59.resolvidos_por_fora).toEqual([]);

    const passou = rodar({ volta_em: ago(1) });
    expect(passou.resolvidos_por_fora).toEqual([]);
    expect(passou.alertas).toHaveLength(1);
    expect(passou.alertas[0]!.nivel).toBe('gestor');
    expect(passou.alertas[0]!.voltou_de_marcacao).toEqual({
      como: 'ligacao',
      marcado_por: 'radar',
      marcado_em: new Date(ago(60)).toISOString(),
    });
  });

  it('marcação desfeita não vale', () => {
    const r = rodar({ desfeita: true });
    expect(r.resolvidos_por_fora).toEqual([]);
    expect(r.alertas).toHaveLength(1);
    expect(r.alertas[0]!.voltou_de_marcacao).toBeNull();
  });

  it('sem motivo de alerta a marcação não aparece em lugar nenhum', () => {
    const r = rodar({}, { cliente: [] , time: [ago(10)] });
    expect(r.alertas).toHaveLength(0);
    expect(r.resolvidos_por_fora).toEqual([]);
  });

  it('o alerta que voltou de marcação vem antes dos outros de gestor', () => {
    // Dois grupos em gestor: o "outro" espera há 6 h (mais antigo), o outro voltou de marcação.
    const g = (id: string, marcacao?: MarcacaoMotor): GrupoMotor => ({
      id_grupo: id,
      cliente: id,
      especialista: 'Esp',
      gestor: 'G',
      ativo: true,
      observador_entrou_em: null,
      ...(marcacao ? { marcacao } : {}),
    });
    const msg = (id: string, t: number): MensagemMotor => ({ id_mensagem: `c-${id}`, id_grupo: id, autor_tipo: 'cliente', enviada_em: t });
    const r = calcular({
      agora: AG,
      grupos: [g('antigo@g.us'), g('voltou@g.us', { como: 'ligacao', marcado_por: 'radar', marcado_em: ago(240), volta_em: ago(1) })],
      mensagens: [
        { id_mensagem: 't1', id_grupo: 'antigo@g.us', autor_tipo: 'time', enviada_em: ago(1000) },
        { id_mensagem: 't2', id_grupo: 'voltou@g.us', autor_tipo: 'time', enviada_em: ago(1000) },
        msg('antigo@g.us', ago(360)),
        msg('voltou@g.us', ago(100)),
      ],
      calendario: cal,
      prazo: { minutos_aviso: 20, minutos_gestor: 31 },
      observador: { status: 'conectado', desde: null },
      ultimaMensagemEm: null,
      usuario: { nome: 'p', pode_marcar: true },
      recursos: { marcacoes: true },
    });
    expect(r.alertas.map((a) => a.id_grupo)).toEqual(['voltou@g.us', 'antigo@g.us']);
  });

  it('recursos.marcacoes só é true quando o banco tem o recurso', () => {
    expect(rodar(null).recursos.marcacoes).toBe(true);
    const sem = calcular({
      agora: AG,
      grupos: [],
      mensagens: [],
      calendario: cal,
      prazo: { minutos_aviso: 20, minutos_gestor: 31 },
      observador: { status: 'conectado', desde: null },
      ultimaMensagemEm: null,
      usuario: { nome: 'p', pode_marcar: true },
    });
    expect(sem.recursos.marcacoes).toBe(false);
  });
});

// ---------- janela de 3 h em tempo de expediente ----------
describe('janela de 3 horas', () => {
  it('JANELA_MIN = 180', () => expect(JANELA_MIN).toBe(180));
});

// ---------- serviço (banco falso) ----------
function dbFalso(respostas: Record<string, { data?: unknown; error?: { code?: string; message?: string } }>) {
  const chamadas: { fn: string; args: unknown }[] = [];
  const db = {
    rpc: async (fn: string, args?: unknown) => {
      chamadas.push({ fn, args });
      return { data: respostas[fn]?.data ?? null, error: respostas[fn]?.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { db, chamadas };
}

describe('servicoMarcacoesSupabase', () => {
  it('registra com o volta_em de 3 h de expediente: sexta 18h30 volta na segunda 11h30', async () => {
    const { db, chamadas } = dbFalso({ registrar_marcacao: { data: 'ok' } });
    let alterou = 0;
    const s = servicoMarcacoesSupabase(db, async () => cal, () => alterou++, () => sp('2026-10-23 18:30'));
    expect(await s.registrar('radar', GRUPO, 'reuniao')).toBe('ok');
    expect(chamadas).toEqual([
      {
        fn: 'registrar_marcacao',
        args: { p_jid: GRUPO, p_como: 'reuniao', p_por: 'radar', p_volta_em: new Date(sp('2026-10-26 11:30')).toISOString() },
      },
    ]);
    expect(alterou).toBe(1);
  });

  it('grupo inexistente e já existe não derrubam o cache do radar', async () => {
    for (const r of ['grupo_inexistente', 'ja_existe'] as ResultadoMarcar[]) {
      const { db } = dbFalso({ registrar_marcacao: { data: r } });
      let alterou = 0;
      const s = servicoMarcacoesSupabase(db, async () => cal, () => alterou++);
      expect(await s.registrar('radar', GRUPO, 'ligacao')).toBe(r);
      expect(alterou).toBe(0);
    }
  });

  it('erro do banco só leva o código (a mensagem pode trazer o jid)', async () => {
    const { db } = dbFalso({ registrar_marcacao: { error: { code: '42883', message: `função com ${GRUPO}` } } });
    const s = servicoMarcacoesSupabase(db, async () => cal, () => {});
    const erro = await s.registrar('radar', GRUPO, 'ligacao').catch((e: Error) => e);
    expect((erro as Error).message).toContain('42883');
    expect((erro as Error).message).not.toContain(GRUPO);
  });

  it('resposta inesperada do banco vira erro', async () => {
    const { db } = dbFalso({ registrar_marcacao: { data: 'talvez' } });
    const s = servicoMarcacoesSupabase(db, async () => cal, () => {});
    await expect(s.registrar('radar', GRUPO, 'ligacao')).rejects.toThrow('resposta inesperada');
  });

  it('desfazer: devolve quantas desfez e só derruba o cache quando desfez', async () => {
    for (const n of [0, 1]) {
      const { db, chamadas } = dbFalso({ desfazer_marcacao: { data: n } });
      let alterou = 0;
      const s = servicoMarcacoesSupabase(db, async () => cal, () => alterou++);
      expect(await s.desfazer(GRUPO)).toBe(n);
      expect(chamadas[0]).toEqual({ fn: 'desfazer_marcacao', args: { p_jid: GRUPO } });
      expect(alterou).toBe(n);
    }
  });

  it('encerrarMarcacoes chama a função do banco', async () => {
    const { db, chamadas } = dbFalso({ encerrar_marcacoes: { data: 2 } });
    expect(await encerrarMarcacoes(db)).toBe(2);
    expect(chamadas[0]!.fn).toBe('encerrar_marcacoes');
    const falha = dbFalso({ encerrar_marcacoes: { error: { code: 'PGRST202', message: 'x' } } });
    await expect(encerrarMarcacoes(falha.db)).rejects.toThrow('PGRST202');
  });
});

// ---------- validação ----------
describe('validarMarcacao', () => {
  it('aceita grupo e como válidos', () => {
    expect(validarMarcacao({ id_grupo: GRUPO, como: 'privado' })).toEqual({ ok: true, valor: { id_grupo: GRUPO, como: 'privado' } });
  });

  it('recusa corpo ruim, privada, como desconhecido e jid enorme', () => {
    for (const ruim of [
      null,
      'texto',
      {},
      { id_grupo: GRUPO },
      { como: 'ligacao' },
      { id_grupo: GRUPO, como: 'telepatia' },
      { id_grupo: 'privada:' + 'a'.repeat(64), como: 'ligacao' },
      { id_grupo: 123, como: 'ligacao' },
      { id_grupo: 'x'.repeat(200) + '@g.us', como: 'ligacao' },
    ]) {
      expect(validarMarcacao(ruim).ok, JSON.stringify(ruim)).toBe(false);
    }
  });
});

// ---------- rotas ----------
const HTML = readFileSync(join(import.meta.dirname, '..', 'frontend', 'index.html'), 'utf8');
const basic = (u: string, s: string) => `Basic ${Buffer.from(`${u}:${s}`).toString('base64')}`;
const login = { authorization: basic('piloto', 'senha-de-teste-bem-longa-123') };

async function montar(servico?: ServicoMarcacoes) {
  const pasta = await mkdtemp(join(tmpdir(), 'radar-cs-marc-'));
  const { app } = buildApp({
    segredo: SEGREDO,
    instancias: [{ nome: 'observador', token: TOKEN, tipo: 'observador' }],
    cadastro: cadastroFixo(),
    repo: { gravar: async () => {} },
    arquivoPendentes: join(pasta, 'pendentes.jsonl'),
    logger: false,
    painel: {
      usuario: 'piloto',
      senha: 'senha-de-teste-bem-longa-123',
      html: HTML,
      radar: async () => rodar(null),
      ...(servico ? { marcacoes: servico } : {}),
    },
  });
  return app;
}

describe('rotas /api/marcacoes', () => {
  const falso = (r: ResultadoMarcar = 'ok', n = 1) => {
    const chamadas: string[] = [];
    const servico: ServicoMarcacoes = {
      registrar: async (u, g, c) => (chamadas.push(`registrar:${u}:${g}:${c}`), r),
      desfazer: async (g) => (chamadas.push(`desfazer:${g}`), n),
    };
    return { servico, chamadas };
  };

  it('sem login: 401 e nada gravado', async () => {
    const { servico, chamadas } = falso();
    const app = await montar(servico);
    const p = await app.inject({ method: 'POST', url: '/api/marcacoes', payload: { id_grupo: GRUPO, como: 'ligacao' } });
    const d = await app.inject({ method: 'DELETE', url: `/api/marcacoes/${encodeURIComponent(GRUPO)}` });
    expect([p.statusCode, d.statusCode]).toEqual([401, 401]);
    expect(chamadas).toEqual([]);
  });

  it('POST: 201 e quem marcou vem da sessão, não do corpo', async () => {
    const { servico, chamadas } = falso();
    const app = await montar(servico);
    const r = await app.inject({
      method: 'POST',
      url: '/api/marcacoes',
      headers: login,
      payload: { id_grupo: GRUPO, como: 'ligacao', marcado_por: 'Outra Pessoa' },
    });
    expect(r.statusCode).toBe(201);
    expect(chamadas).toEqual([`registrar:piloto:${GRUPO}:ligacao`]);
  });

  it('POST: 400 corpo inválido, 404 grupo inexistente, 409 já existe', async () => {
    const ruim = await (await montar(falso().servico)).inject({ method: 'POST', url: '/api/marcacoes', headers: login, payload: { id_grupo: GRUPO, como: 'x' } });
    expect(ruim.statusCode).toBe(400);
    const nao = await (await montar(falso('grupo_inexistente').servico)).inject({ method: 'POST', url: '/api/marcacoes', headers: login, payload: { id_grupo: GRUPO, como: 'ligacao' } });
    expect(nao.statusCode).toBe(404);
    const ja = await (await montar(falso('ja_existe').servico)).inject({ method: 'POST', url: '/api/marcacoes', headers: login, payload: { id_grupo: GRUPO, como: 'ligacao' } });
    expect(ja.statusCode).toBe(409);
  });

  it('POST: falha do banco vira 500 genérico, sem detalhe', async () => {
    const servico: ServicoMarcacoes = {
      registrar: async () => {
        throw new Error(`supabase com ${GRUPO}`);
      },
      desfazer: async () => 0,
    };
    const r = await (await montar(servico)).inject({ method: 'POST', url: '/api/marcacoes', headers: login, payload: { id_grupo: GRUPO, como: 'ligacao' } });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain(GRUPO);
  });

  it('DELETE: 204 quando desfez, 404 quando não havia, 400 para jid inválido', async () => {
    const url = `/api/marcacoes/${encodeURIComponent(GRUPO)}`;
    const { servico, chamadas } = falso('ok', 1);
    expect((await (await montar(servico)).inject({ method: 'DELETE', url, headers: login })).statusCode).toBe(204);
    expect(chamadas).toEqual([`desfazer:${GRUPO}`]);
    expect((await (await montar(falso('ok', 0).servico)).inject({ method: 'DELETE', url, headers: login })).statusCode).toBe(404);
    expect((await (await montar(falso().servico)).inject({ method: 'DELETE', url: '/api/marcacoes/qualquer', headers: login })).statusCode).toBe(400);
  });

  it('sem o serviço (recurso desligado) as rotas nem existem', async () => {
    const app = await montar();
    const r = await app.inject({ method: 'POST', url: '/api/marcacoes', headers: login, payload: { id_grupo: GRUPO, como: 'ligacao' } });
    expect(r.statusCode).toBe(404);
  });
});

// ---------- carregamento ----------
describe('montarDadosRadar com marcações', () => {
  const base: RadarDadosJson = {
    conversas: [
      {
        jid: GRUPO,
        tipo: 'grupo',
        nome: 'G',
        especialista: 'E',
        gestor: 'X',
        observador_entrou_em: null,
        principal_definido_em: null,
        ultima_time: null,
        pendentes: [],
        ultima_atividade_em: null,
        marcacao: {
          como: 'reuniao',
          marcado_por: 'radar',
          marcado_em: '2026-10-20T17:00:00Z',
          volta_em: '2026-10-20T20:00:00Z',
          encerrada_por: null,
        },
      },
    ],
    expediente: { hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
    feriados: [],
    prazo: { minutos_aviso: 20, minutos_gestor: 31 },
    ultima_mensagem_em: null,
    presencas: [],
    time: [],
    varreduras: [],
    recursos: { marcacoes: true },
  };

  it('leva a marcação do grupo e marca a desfeita', () => {
    const d = montarDadosRadar(base);
    expect(d.recursos).toEqual({ marcacoes: true });
    expect(d.grupos[0]!.marcacao).toEqual({
      como: 'reuniao',
      marcado_por: 'radar',
      marcado_em: Date.parse('2026-10-20T17:00:00Z'),
      volta_em: Date.parse('2026-10-20T20:00:00Z'),
    });
    const desfeita = montarDadosRadar({
      ...base,
      conversas: [{ ...base.conversas[0]!, marcacao: { ...base.conversas[0]!.marcacao!, encerrada_por: 'desfeita' } }],
    });
    expect(desfeita.grupos[0]!.marcacao?.desfeita).toBe(true);
  });

  it('banco sem a migration (sem recursos nem marcacao): recurso desligado', () => {
    const { recursos: _r, ...semRecursos } = base;
    const d = montarDadosRadar({ ...semRecursos, conversas: [{ ...base.conversas[0]!, marcacao: undefined as never }] });
    expect(d.recursos).toBeUndefined();
    expect(d.grupos[0]!.marcacao).toBeUndefined();
  });
});
