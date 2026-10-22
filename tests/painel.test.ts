import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autenticar, injetarConfig } from '../src/api/painel.js';
import { calcular, type RespostaRadar } from '../src/motor/calcular.js';
import { buildApp } from '../src/server.js';
import { cadastroFixo } from './fixtures/cadastro.js';
import { GRUPO, SEGREDO, TOKEN } from './fixtures/payloads.js';

const USUARIO = 'piloto';
const SENHA = 'senha-de-teste-bem-longa-123';
const HTML = readFileSync(join(import.meta.dirname, '..', 'frontend', 'index.html'), 'utf8');
const basic = (u: string, s: string) => `Basic ${Buffer.from(`${u}:${s}`).toString('base64')}`;

const RESPOSTA: RespostaRadar = calcular({
  agora: Date.parse('2026-10-20T15:00:00-03:00'),
  grupos: [{ id_grupo: GRUPO, cliente: 'Cliente Teste', especialista: 'Esp A', gestor: 'Gestor X', ativo: true, observador_entrou_em: null }],
  mensagens: [{ id_mensagem: 'm1', id_grupo: GRUPO, autor_tipo: 'cliente', enviada_em: Date.parse('2026-10-20T14:00:00-03:00') }],
  calendario: {
    expediente: { hora_inicio: '09:00', hora_fim: '19:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
    feriados: new Set(),
  },
  prazo: { minutos_aviso: 20, minutos_gestor: 31 },
  observador: { status: 'conectado', desde: null },
  ultimaMensagemEm: null,
  usuario: { nome: USUARIO, pode_marcar: false },
});

async function montar(radar: (u: string) => Promise<RespostaRadar> = async () => RESPOSTA) {
  const pasta = await mkdtemp(join(tmpdir(), 'radar-cs-painel-'));
  const { app } = buildApp({
    segredo: SEGREDO,
    instancias: [{ nome: 'observador', token: TOKEN, tipo: 'observador' }],
    cadastro: cadastroFixo(),
    repo: { gravar: async () => {} },
    arquivoPendentes: join(pasta, 'pendentes.jsonl'),
    logger: false,
    painel: { usuario: USUARIO, senha: SENHA, html: HTML, radar },
  });
  return app;
}

describe('autenticação básica', () => {
  for (const url of ['/', '/api/radar']) {
    it(`${url} sem credencial: 401 com WWW-Authenticate`, async () => {
      const r = await (await montar()).inject({ method: 'GET', url });
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toContain('Basic realm="Radar CS"');
      expect(r.body).not.toContain('RADAR_CONFIG');
    });

    it(`${url} com senha errada ou usuário errado: 401`, async () => {
      const app = await montar();
      for (const auth of [basic(USUARIO, 'errada'), basic('outro', SENHA), 'Basic !!!', `Bearer ${SENHA}`]) {
        expect((await app.inject({ method: 'GET', url, headers: { authorization: auth } })).statusCode).toBe(401);
      }
    });
  }

  it('autenticar: senha com ":" funciona; só usuário e senha exatos', () => {
    expect(autenticar(basic('u', 'a:b:c-senha'), 'u', 'a:b:c-senha')).toBe('u');
    expect(autenticar(basic('u', SENHA + ' '), 'u', SENHA)).toBeUndefined();
    expect(autenticar(undefined, 'u', SENHA)).toBeUndefined();
  });

  it('o webhook e /saude não pedem login (o webhook tem o segredo do caminho)', async () => {
    const app = await montar();
    expect((await app.inject({ method: 'GET', url: '/saude' })).statusCode).toBe(200);
    const r = await app.inject({
      method: 'POST',
      url: `/hooks/whatsapp/${SEGREDO}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: TOKEN, EventType: 'messages' }),
    });
    expect(r.statusCode).toBe(200);
  });
});

describe('GET /', () => {
  it('serve o index.html com RADAR_CONFIG em modo api, sem cache', async () => {
    const r = await (await montar()).inject({ method: 'GET', url: '/', headers: { authorization: basic(USUARIO, SENHA) } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain(`window.RADAR_CONFIG = {"modo":"api","apiBase":"/api","pollMs":60000};`);
    // A configuração vem antes do script do painel.
    expect(r.body.indexOf('window.RADAR_CONFIG =')).toBeLessThan(r.body.indexOf('// <engine>'));
  });

  it('injetarConfig não altera o resto da página', () => {
    const saida = injetarConfig(HTML);
    expect(saida.replace(/<script>window\.RADAR_CONFIG = .*?<\/script>\n/, '')).toBe(HTML);
    expect(() => injetarConfig('<html><body></body></html>')).toThrow('</head>');
  });
});

describe('GET /api/radar', () => {
  it('devolve a resposta do motor para o usuário autenticado, sem cache', async () => {
    let pedidoPor = '';
    const app = await montar(async (u) => {
      pedidoPor = u;
      return RESPOSTA;
    });
    const r = await app.inject({ method: 'GET', url: '/api/radar', headers: { authorization: basic(USUARIO, SENHA) } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(pedidoPor).toBe(USUARIO);
    const corpo = r.json() as RespostaRadar;
    expect(corpo.alertas[0]).toMatchObject({ id_grupo: GRUPO, nivel: 'gestor' });
    expect(corpo.usuario.pode_marcar).toBe(false);
    expect(corpo.por_especialista[0]).toMatchObject({
      conversas_privadas_sem_resposta: 0,
      conversas_privadas_7d: 0,
      conversas_privadas_mes: 0,
    });
    expect(r.body).not.toMatch(/texto/i);
  });

  it('falha ao montar: 500 sem detalhes (o painel mantém os últimos dados)', async () => {
    const app = await montar(async () => {
      throw new Error('supabase (mensagens): conexão recusada');
    });
    const r = await app.inject({ method: 'GET', url: '/api/radar', headers: { authorization: basic(USUARIO, SENHA) } });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('supabase');
  });

  it('marcações não existem nesta fatia', async () => {
    const r = await (await montar()).inject({
      method: 'POST',
      url: '/api/marcacoes',
      headers: { authorization: basic(USUARIO, SENHA), 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(404);
  });
});
