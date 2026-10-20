import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EventoBruto, RepositorioEventos } from '../src/repositorio.js';
import { buildApp } from '../src/server.js';
import { SEGREDO, TEXTO, TOKEN, eventoConexao, mensagemTexto } from './fixtures/payloads.js';

const proximoTique = () => new Promise<void>((r) => setImmediate(r));

class RepoMemoria implements RepositorioEventos {
  gravados: EventoBruto[] = [];
  async gravar(e: EventoBruto) {
    this.gravados.push(e);
  }
}

async function montar(repo: RepositorioEventos, guardarTexto = false) {
  const pasta = await mkdtemp(join(tmpdir(), 'radar-cs-'));
  const arquivoPendentes = join(pasta, 'pendentes.jsonl');
  const { app, fila } = buildApp({
    segredo: SEGREDO,
    tokenInstancia: TOKEN,
    guardarTexto,
    repo,
    arquivoPendentes,
    esperaBaseMs: 1,
    logger: false,
  });
  return { app, fila, arquivoPendentes };
}

const post = (app: Awaited<ReturnType<typeof montar>>['app'], segredo: string, corpo: unknown) =>
  app.inject({
    method: 'POST',
    url: `/hooks/whatsapp/${segredo}`,
    headers: { 'content-type': 'application/json' },
    payload: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });

describe('POST /hooks/whatsapp/<segredo>', () => {
  it('segredo errado: 404 e nada gravado', async () => {
    const repo = new RepoMemoria();
    const { app, fila } = await montar(repo);
    const r = await post(app, 'segredo-errado', mensagemTexto());
    expect(r.statusCode).toBe(404);
    await proximoTique();
    await fila.esvaziar();
    expect(repo.gravados).toHaveLength(0);
  });

  it('segredo errado com JSON inválido: 404 (não revela a rota)', async () => {
    const { app } = await montar(new RepoMemoria());
    expect((await post(app, 'segredo-errado', '{ruim')).statusCode).toBe(404);
  });

  it('JSON inválido com segredo certo: 400, sem ecoar o corpo', async () => {
    const { app } = await montar(new RepoMemoria());
    const r = await post(app, SEGREDO, `{"token":"${TOKEN}", quebrado`);
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain(TOKEN);
  });

  it('token ausente: 401', async () => {
    const repo = new RepoMemoria();
    const { app } = await montar(repo);
    const { token: _, ...semToken } = mensagemTexto();
    expect((await post(app, SEGREDO, semToken)).statusCode).toBe(401);
  });

  it('token de outra instância: 401 e nada gravado', async () => {
    const repo = new RepoMemoria();
    const { app, fila } = await montar(repo);
    const r = await post(app, SEGREDO, { ...mensagemTexto(), token: 'outra-instancia' });
    expect(r.statusCode).toBe(401);
    await proximoTique();
    await fila.esvaziar();
    expect(repo.gravados).toHaveLength(0);
  });

  it('payload válido: 200 e grava sem token e com texto mascarado', async () => {
    const repo = new RepoMemoria();
    const { app, fila } = await montar(repo);
    const r = await post(app, SEGREDO, mensagemTexto());
    expect(r.statusCode).toBe(200);
    await proximoTique();
    await fila.esvaziar();

    expect(repo.gravados).toHaveLength(1);
    const g = repo.gravados[0]!;
    expect(g.evento).toBe('messages');
    expect(g.id_mensagem).toBe('3EB0AAAA0001');
    expect(Number.isNaN(Date.parse(g.recebido_em))).toBe(false);
    const gravado = JSON.stringify(g.payload);
    expect(gravado).not.toContain(TOKEN);
    expect(gravado).not.toContain(TEXTO);
    expect(gravado).toContain(`[texto omitido: ${TEXTO.length} caracteres]`);
  });

  it('com DESCOBERTA_GUARDAR_TEXTO=true grava o texto, mas nunca o token', async () => {
    const repo = new RepoMemoria();
    const { app, fila } = await montar(repo, true);
    await post(app, SEGREDO, mensagemTexto());
    await proximoTique();
    await fila.esvaziar();
    const gravado = JSON.stringify(repo.gravados[0]!.payload);
    expect(gravado).toContain(TEXTO);
    expect(gravado).not.toContain(TOKEN);
  });

  it('evento de conexão também é gravado, sem id_mensagem', async () => {
    const repo = new RepoMemoria();
    const { app, fila } = await montar(repo);
    expect((await post(app, SEGREDO, eventoConexao())).statusCode).toBe(200);
    await proximoTique();
    await fila.esvaziar();
    expect(repo.gravados[0]).toMatchObject({ evento: 'connection', id_mensagem: null });
  });

  it('responde 200 antes de a gravação terminar', async () => {
    let liberar!: () => void;
    let chamadas = 0;
    const lento: RepositorioEventos = {
      gravar: () => {
        chamadas++;
        return new Promise<void>((r) => (liberar = r));
      },
    };
    const { app, fila } = await montar(lento);
    const r = await post(app, SEGREDO, mensagemTexto());
    expect(r.statusCode).toBe(200);
    await proximoTique();
    expect(chamadas).toBe(1);
    expect(fila.pendentes).toBe(1); // ainda gravando
    liberar();
    await fila.esvaziar();
    expect(fila.pendentes).toBe(0);
  });

  it('banco fora: tenta 3 vezes, salva em pendentes (sanitizado) e reenvia depois', async () => {
    let tentativas = 0;
    const fora: RepositorioEventos = {
      gravar: async () => {
        tentativas++;
        throw new Error('sem conexão');
      },
    };
    const { app, fila, arquivoPendentes } = await montar(fora);
    expect((await post(app, SEGREDO, mensagemTexto())).statusCode).toBe(200);
    await proximoTique();
    await fila.esvaziar();
    expect(tentativas).toBe(3);

    const conteudo = await readFile(arquivoPendentes, 'utf8');
    expect(conteudo.trim().split('\n')).toHaveLength(1);
    expect(conteudo).not.toContain(TOKEN);
    expect(conteudo).not.toContain(TEXTO);

    // Banco voltou: o mesmo arquivo é reenviado por outra fila.
    const repo = new RepoMemoria();
    const { fila: filaNova } = buildApp({
      segredo: SEGREDO,
      tokenInstancia: TOKEN,
      guardarTexto: false,
      repo,
      arquivoPendentes,
      logger: false,
    });
    expect(await filaNova.reenviarPendentes()).toBe(1);
    expect(repo.gravados[0]!.id_mensagem).toBe('3EB0AAAA0001');
    expect(await filaNova.reenviarPendentes()).toBe(0); // arquivo consumido
  });
});

describe('GET /saude', () => {
  it('responde ok', async () => {
    const { app } = await montar(new RepoMemoria());
    const r = await app.inject({ method: 'GET', url: '/saude' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
  });
});
