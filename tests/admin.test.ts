import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizarHora,
  validarExpediente,
  validarFeriado,
  validarPrazo,
  type ConfigAdmin,
  type ServicoAdmin,
} from '../src/api/admin.js';
import { CacheRadar } from '../src/api/cache.js';
import { ErroConfig, lerConfig } from '../src/config.js';
import { buildApp } from '../src/server.js';
import { calcular, type RespostaRadar } from '../src/motor/calcular.js';
import { cadastroFixo } from './fixtures/cadastro.js';
import { GRUPO, SEGREDO, TOKEN } from './fixtures/payloads.js';

const USUARIO = 'piloto';
const SENHA = 'senha-de-teste-bem-longa-123';
const ADMIN = 'chefe';
const SENHA_ADMIN = 'outra-senha-de-teste-longa-9';
const HTML = readFileSync(join(import.meta.dirname, '..', 'frontend', 'index.html'), 'utf8');
const HTML_ADMIN = readFileSync(join(import.meta.dirname, '..', 'frontend', 'admin.html'), 'utf8');
const basic = (u: string, s: string) => `Basic ${Buffer.from(`${u}:${s}`).toString('base64')}`;
const comum = { authorization: basic(USUARIO, SENHA) };
const admin = { authorization: basic(ADMIN, SENHA_ADMIN) };

const CONFIG: ConfigAdmin = {
  expediente: { hora_inicio: '09:00', hora_fim: '19:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
  prazos: [
    { urgencia: 'alto', minutos_aviso: 10, minutos_gestor: 15 },
    { urgencia: 'medio', minutos_aviso: 20, minutos_gestor: 31 },
    { urgencia: 'baixo', minutos_aviso: 60, minutos_gestor: 90 },
  ],
  feriados: [{ data: '2026-12-25', descricao: 'Natal' }],
};

function servicoFalso() {
  const chamadas: string[] = [];
  const servico: ServicoAdmin = {
    ler: async () => CONFIG,
    salvarExpediente: async (e) => (chamadas.push('expediente'), e),
    salvarPrazo: async (p) => (chamadas.push(`prazo:${p.urgencia}`), p),
    salvarFeriado: async (f) => (chamadas.push(`feriado:${f.data}`), f),
    removerFeriado: async (d) => void chamadas.push(`remover:${d}`),
  };
  return { servico, chamadas };
}

const RESPOSTA: RespostaRadar = calcular({
  agora: Date.parse('2026-10-20T15:00:00-03:00'),
  grupos: [{ id_grupo: GRUPO, cliente: 'Cliente Teste', especialista: 'Esp A', gestor: 'Gestor X', ativo: true, observador_entrou_em: null }],
  mensagens: [],
  calendario: {
    expediente: { hora_inicio: '09:00', hora_fim: '19:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
    feriados: new Set(),
  },
  prazo: { minutos_aviso: 20, minutos_gestor: 31 },
  observador: { status: 'conectado', desde: null },
  ultimaMensagemEm: null,
  usuario: { nome: USUARIO, pode_marcar: false },
});

async function montar(opcoes: { comAdmin?: boolean; servico?: ServicoAdmin; radar?: (u: string, a: boolean) => Promise<RespostaRadar> } = {}) {
  const pasta = await mkdtemp(join(tmpdir(), 'radar-cs-admin-'));
  const { app } = buildApp({
    segredo: SEGREDO,
    instancias: [{ nome: 'observador', token: TOKEN, tipo: 'observador' }],
    cadastro: cadastroFixo(),
    repo: { gravar: async () => {} },
    arquivoPendentes: join(pasta, 'pendentes.jsonl'),
    logger: false,
    painel: {
      usuario: USUARIO,
      senha: SENHA,
      html: HTML,
      radar: opcoes.radar ?? (async () => RESPOSTA),
      ...(opcoes.comAdmin === false
        ? {}
        : { admin: { usuario: ADMIN, senha: SENHA_ADMIN, html: HTML_ADMIN, servico: opcoes.servico ?? servicoFalso().servico } }),
    },
  });
  return app;
}

describe('validação', () => {
  it('normalizarHora aceita 9:00, 09:00 e 09:00:00', () => {
    expect(normalizarHora('9:00')).toBe('09:00');
    expect(normalizarHora('09:30:00')).toBe('09:30');
    for (const ruim of ['24:00', '9', '09:60', '', 'ab:cd', 900, null]) expect(normalizarHora(ruim)).toBeUndefined();
  });

  it('expediente válido é normalizado (dias ordenados, sem repetição)', () => {
    const r = validarExpediente({ hora_inicio: '9:00', hora_fim: '18:30', dias_uteis: [5, 1, 1, 3], fuso: ' America/Sao_Paulo ' });
    expect(r).toEqual({ ok: true, valor: { hora_inicio: '09:00', hora_fim: '18:30', dias_uteis: [1, 3, 5], fuso: 'America/Sao_Paulo' } });
  });

  it('expediente inválido: fim antes do início, sem dia, dia fora de 1-7, fuso falso, corpo ruim', () => {
    const ok = { hora_inicio: '09:00', hora_fim: '19:00', dias_uteis: [1], fuso: 'America/Sao_Paulo' };
    for (const ruim of [
      { ...ok, hora_fim: '09:00' },
      { ...ok, hora_fim: '08:00' },
      { ...ok, dias_uteis: [] },
      { ...ok, dias_uteis: [0] },
      { ...ok, dias_uteis: [8] },
      { ...ok, dias_uteis: [1.5] },
      { ...ok, fuso: 'Marte/Olimpo' },
      { ...ok, fuso: '' },
      { ...ok, hora_inicio: 'x' },
      null,
      [],
      'texto',
    ]) {
      expect(validarExpediente(ruim).ok, JSON.stringify(ruim)).toBe(false);
    }
  });

  it('prazo: gestor maior que aviso, inteiros de 1 a 10080, nível conhecido', () => {
    expect(validarPrazo('medio', { minutos_aviso: 20, minutos_gestor: 31 })).toEqual({
      ok: true,
      valor: { urgencia: 'medio', minutos_aviso: 20, minutos_gestor: 31 },
    });
    for (const [u, c] of [
      ['medio', { minutos_aviso: 20, minutos_gestor: 20 }],
      ['medio', { minutos_aviso: 20, minutos_gestor: 10 }],
      ['medio', { minutos_aviso: 0, minutos_gestor: 10 }],
      ['medio', { minutos_aviso: 1.5, minutos_gestor: 10 }],
      ['medio', { minutos_aviso: '20', minutos_gestor: 31 }],
      ['medio', { minutos_aviso: 20, minutos_gestor: 99999 }],
      ['critico', { minutos_aviso: 20, minutos_gestor: 31 }],
      ['medio', null],
    ] as const) {
      expect(validarPrazo(u, c).ok, `${u} ${JSON.stringify(c)}`).toBe(false);
    }
  });

  it('feriado: data real, descrição de 1 a 120 caracteres', () => {
    expect(validarFeriado('2026-12-25', { descricao: ' Natal ' })).toEqual({ ok: true, valor: { data: '2026-12-25', descricao: 'Natal' } });
    for (const [d, c] of [
      ['2026-02-30', { descricao: 'x' }],
      ['25/12/2026', { descricao: 'x' }],
      ['2026-12-25', { descricao: '   ' }],
      ['2026-12-25', { descricao: 'x'.repeat(121) }],
      ['2026-12-25', {}],
      ['2026-12-25', null],
    ] as const) {
      expect(validarFeriado(d, c).ok, `${d} ${JSON.stringify(c)}`).toBe(false);
    }
  });
});

describe('rotas de administração', () => {
  const rotas: [string, string][] = [
    ['GET', '/api/admin/config'],
    ['PUT', '/api/admin/expediente'],
    ['PUT', '/api/admin/prazos/medio'],
    ['PUT', '/api/admin/feriados/2026-12-25'],
    ['DELETE', '/api/admin/feriados/2026-12-25'],
  ];

  it('sem a conta de administrador no .env, a tela e a API nem existem (404)', async () => {
    const app = await montar({ comAdmin: false });
    for (const [method, url] of [['GET', '/admin'], ...rotas] as [string, string][]) {
      expect((await app.inject({ method: method as 'GET', url, headers: admin })).statusCode, url).toBe(404);
    }
  });

  it('API sem login: 401; com a conta comum: 403 (não grava nada); senha errada: 401', async () => {
    const { servico, chamadas } = servicoFalso();
    const app = await montar({ servico });
    for (const [method, url] of rotas) {
      const sem = await app.inject({ method: method as 'GET', url });
      expect(sem.statusCode, `sem login ${url}`).toBe(401);
      const errada = await app.inject({ method: method as 'GET', url, headers: { authorization: basic(ADMIN, 'errada') } });
      expect(errada.statusCode, `senha errada ${url}`).toBe(401);
      const c = await app.inject({
        method: method as 'GET',
        url,
        headers: comum,
        ...(method === 'PUT' ? { payload: { descricao: 'x', minutos_aviso: 1, minutos_gestor: 2 } } : {}),
      });
      expect(c.statusCode, `conta comum ${method} ${url}`).toBe(403);
      expect(c.json().erro).toContain('administrador');
    }
    expect(chamadas).toEqual([]);
  });

  it('página /admin: só a conta de administrador; a comum pede o login de novo (401 com WWW-Authenticate)', async () => {
    const app = await montar();
    const semLogin = await app.inject({ method: 'GET', url: '/admin' });
    expect(semLogin.statusCode).toBe(401);
    const c = await app.inject({ method: 'GET', url: '/admin', headers: comum });
    expect(c.statusCode).toBe(401);
    expect(c.headers['www-authenticate']).toContain('Basic realm="Radar CS"');
    expect(c.body).not.toContain('Configurações');
    const a = await app.inject({ method: 'GET', url: '/admin', headers: admin });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toContain('text/html');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.body).toContain('Configurações');
  });

  it('administrador lê a configuração e grava (resposta 200 com o valor salvo; feriado removido: 204)', async () => {
    const { servico, chamadas } = servicoFalso();
    const app = await montar({ servico });
    const h = { ...admin, 'content-type': 'application/json' };
    expect((await app.inject({ method: 'GET', url: '/api/admin/config', headers: admin })).json()).toEqual(CONFIG);
    const e = await app.inject({
      method: 'PUT',
      url: '/api/admin/expediente',
      headers: h,
      payload: { hora_inicio: '8:00', hora_fim: '18:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
    });
    expect(e.statusCode).toBe(200);
    expect(e.json().hora_inicio).toBe('08:00');
    const p = await app.inject({ method: 'PUT', url: '/api/admin/prazos/alto', headers: h, payload: { minutos_aviso: 5, minutos_gestor: 12 } });
    expect(p.json()).toEqual({ urgencia: 'alto', minutos_aviso: 5, minutos_gestor: 12 });
    const f = await app.inject({ method: 'PUT', url: '/api/admin/feriados/2026-11-20', headers: h, payload: { descricao: 'Consciência Negra' } });
    expect(f.json()).toEqual({ data: '2026-11-20', descricao: 'Consciência Negra' });
    const d = await app.inject({ method: 'DELETE', url: '/api/admin/feriados/2026-11-20', headers: admin });
    expect(d.statusCode).toBe(204);
    expect(chamadas).toEqual(['expediente', 'prazo:alto', 'feriado:2026-11-20', 'remover:2026-11-20']);
  });

  it('entrada inválida: 400 com mensagem em português e nada é gravado', async () => {
    const { servico, chamadas } = servicoFalso();
    const app = await montar({ servico });
    const h = { ...admin, 'content-type': 'application/json' };
    const casos: [string, string, unknown][] = [
      ['PUT', '/api/admin/expediente', { hora_inicio: '19:00', hora_fim: '09:00', dias_uteis: [1], fuso: 'America/Sao_Paulo' }],
      ['PUT', '/api/admin/prazos/medio', { minutos_aviso: 30, minutos_gestor: 30 }],
      ['PUT', '/api/admin/prazos/critico', { minutos_aviso: 1, minutos_gestor: 2 }],
      ['PUT', '/api/admin/feriados/2026-02-30', { descricao: 'x' }],
      ['PUT', '/api/admin/feriados/2026-12-25', { descricao: '' }],
    ];
    for (const [method, url, payload] of casos) {
      const r = await app.inject({ method: method as 'PUT', url, headers: h, payload: payload as object });
      expect(r.statusCode, url).toBe(400);
      expect(typeof r.json().erro).toBe('string');
    }
    const del = await app.inject({ method: 'DELETE', url: '/api/admin/feriados/nao-e-data', headers: admin });
    expect(del.statusCode).toBe(400);
    expect(chamadas).toEqual([]);
  });

  it('falha do banco: 500 genérico, sem vazar a mensagem', async () => {
    const servico: ServicoAdmin = { ...servicoFalso().servico, ler: async () => { throw new Error('linha secreta do banco'); } };
    const r = await (await montar({ servico })).inject({ method: 'GET', url: '/api/admin/config', headers: admin });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('secreta');
  });

  it('/api/radar manda admin=true só para a conta de administrador (as duas contas entram no painel)', async () => {
    const vistos: [string, boolean][] = [];
    const app = await montar({ radar: async (u, a) => (vistos.push([u, a]), RESPOSTA) });
    expect((await app.inject({ method: 'GET', url: '/api/radar', headers: comum })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/radar', headers: admin })).statusCode).toBe(200);
    expect(vistos).toEqual([[USUARIO, false], [ADMIN, true]]);
  });

  it('a conta de administrador também abre o painel (/)', async () => {
    const r = await (await montar()).inject({ method: 'GET', url: '/', headers: admin });
    expect(r.statusCode).toBe(200);
  });
});

describe('CacheRadar.invalidar', () => {
  it('depois de invalidar, a próxima leitura vai ao banco; consulta velha em andamento não vira cache', async () => {
    let n = 0;
    let liberar: (() => void) | undefined;
    const cache = new CacheRadar(async () => {
      const v = ++n;
      if (v === 1) await new Promise<void>((ok) => (liberar = ok));
      return v;
    });
    const primeira = cache.obter(); // consulta 1, ainda esperando
    cache.invalidar(); // a configuração mudou no meio
    expect(await cache.obter()).toBe(2); // consulta nova, não espera a velha
    liberar?.();
    expect(await primeira).toBe(1);
    expect(await cache.obter()).toBe(2); // continua o dado novo (a velha não sobrescreveu)
    expect(n).toBe(2);
  });
});

describe('config: conta de administrador', () => {
  const base = {
    WEBHOOK_SEGREDO: SEGREDO,
    UAZAPI_INSTANCE_TOKEN: TOKEN,
    PAINEL_USUARIO: USUARIO,
    PAINEL_SENHA: SENHA,
  };
  const ler = (env: Record<string, string>) => lerConfig(env, { exigirBanco: false });

  it('opcional: sem as variáveis, painel.admin não existe', () => {
    expect(ler(base).painel).toEqual({ usuario: USUARIO, senha: SENHA });
  });

  it('com as duas, vira painel.admin', () => {
    const c = ler({ ...base, PAINEL_ADMIN_USUARIO: ADMIN, PAINEL_ADMIN_SENHA: SENHA_ADMIN });
    expect(c.painel?.admin).toEqual({ usuario: ADMIN, senha: SENHA_ADMIN });
  });

  it('só uma das duas, senha curta, ":" no usuário ou igual à conta comum: recusado sem mostrar o valor', () => {
    const casos: Record<string, string>[] = [
      { PAINEL_ADMIN_USUARIO: ADMIN },
      { PAINEL_ADMIN_SENHA: SENHA_ADMIN },
      { PAINEL_ADMIN_USUARIO: ADMIN, PAINEL_ADMIN_SENHA: 'curta' },
      { PAINEL_ADMIN_USUARIO: 'a:b', PAINEL_ADMIN_SENHA: SENHA_ADMIN },
      { PAINEL_ADMIN_USUARIO: USUARIO, PAINEL_ADMIN_SENHA: SENHA_ADMIN },
      { PAINEL_ADMIN_USUARIO: ADMIN, PAINEL_ADMIN_SENHA: SENHA },
    ];
    for (const extra of casos) {
      let erro: unknown;
      try {
        ler({ ...base, ...extra });
      } catch (e) {
        erro = e;
      }
      expect(erro, JSON.stringify(Object.keys(extra))).toBeInstanceOf(ErroConfig);
      for (const v of Object.values(extra)) expect((erro as Error).message).not.toContain(v);
    }
  });
});
