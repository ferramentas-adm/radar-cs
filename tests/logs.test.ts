import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepositorioEventos } from '../src/repositorio.js';
import { buildApp, opcoesLogger } from '../src/server.js';
import { GRUPO, SEGREDO, TEXTO, TOKEN, mensagemTexto } from './fixtures/payloads.js';

// Regra inegociável 3: nunca logar o payload (ele carrega o token). Nem o segredo da URL.

async function montarComLog(repo: RepositorioEventos) {
  const linhas: string[] = [];
  const stream = { write: (s: string) => void linhas.push(s) };
  const pasta = await mkdtemp(join(tmpdir(), 'radar-cs-log-'));
  const { app, fila } = buildApp({
    segredo: SEGREDO,
    instancias: [{ nome: 'observador', token: TOKEN, tipo: 'observador' }],
    cadastro: { grupoAtivo: (jid) => jid === GRUPO, ehDoTime: () => false },
    repo,
    arquivoPendentes: join(pasta, 'pendentes.jsonl'),
    esperaBaseMs: 1,
    logger: opcoesLogger({ stream }),
  });
  return { app, fila, linhas };
}

const enviar = (app: Awaited<ReturnType<typeof montarComLog>>['app'], segredo: string, corpo: string) =>
  app.inject({
    method: 'POST',
    url: `/hooks/whatsapp/${segredo}`,
    headers: { 'content-type': 'application/json' },
    payload: corpo,
  });

function semVazamento(log: string) {
  expect(log).not.toContain(TOKEN);
  expect(log).not.toContain(SEGREDO);
  expect(log).not.toContain(TEXTO);
  expect(log).not.toContain('boleto');
}

describe('logs', () => {
  it('requisição válida: o log registra a rota com *** e nada do payload', async () => {
    const { app, fila, linhas } = await montarComLog({ gravar: async () => {} });
    await enviar(app, SEGREDO, JSON.stringify(mensagemTexto()));
    await new Promise<void>((r) => setImmediate(r));
    await fila.esvaziar();
    const log = linhas.join('');
    expect(log).toContain('/hooks/whatsapp/***');
    semVazamento(log);
  });

  it('rejeições (token errado, JSON inválido, segredo errado) não vazam nada', async () => {
    const { app, linhas } = await montarComLog({ gravar: async () => {} });
    await enviar(app, SEGREDO, JSON.stringify({ ...mensagemTexto(), token: 'outra' }));
    await enviar(app, SEGREDO, `{"token":"${TOKEN}","message":{"text":"${TEXTO}"} quebrado`);
    await enviar(app, 'tentativa-de-segredo', JSON.stringify(mensagemTexto()));
    const log = linhas.join('');
    expect(log.length).toBeGreaterThan(0);
    semVazamento(log);
    expect(log).not.toContain('tentativa-de-segredo');
  });

  it('falha do banco: o log tem só metadados', async () => {
    const { app, fila, linhas } = await montarComLog({
      gravar: async () => {
        throw new Error('sem conexão');
      },
    });
    await enviar(app, SEGREDO, JSON.stringify(mensagemTexto()));
    await new Promise<void>((r) => setImmediate(r));
    await fila.esvaziar();
    const log = linhas.join('');
    expect(log).toContain('falha ao gravar evento');
    expect(log).toContain('3EB0AAAA0001');
    semVazamento(log);
  });
});
