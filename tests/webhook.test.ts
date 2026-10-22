import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Cadastro } from '../src/cadastro.js';
import type { InstanciaConfig } from '../src/config.js';
import type { EventoBruto, RepositorioEventos } from '../src/repositorio.js';
import { buildApp } from '../src/server.js';
import {
  GRUPO,
  NUMERO_CLIENTE,
  NUMERO_TIME,
  SEGREDO,
  TEXTO,
  TOKEN,
  TOKEN_RONI,
  eventoConexao,
  mensagemGrupo,
} from './fixtures/payloads.js';

const proximoTique = () => new Promise<void>((r) => setImmediate(r));

const INSTANCIAS: InstanciaConfig[] = [
  { nome: 'observador', token: TOKEN, tipo: 'observador' },
  { nome: 'roni_ramos', token: TOKEN_RONI, tipo: 'pessoa' },
];

const CADASTRO: Cadastro = {
  grupoAtivo: (jid) => jid === GRUPO,
  ehDoTime: (n) => n.replace(/\D/g, '') === NUMERO_TIME,
};

class RepoMemoria implements RepositorioEventos {
  gravados: EventoBruto[] = [];
  async gravar(e: EventoBruto) {
    this.gravados.push(e);
  }
}

async function montar(repo: RepositorioEventos) {
  const pasta = await mkdtemp(join(tmpdir(), 'radar-cs-'));
  const arquivoPendentes = join(pasta, 'pendentes.jsonl');
  const { app, fila } = buildApp({
    segredo: SEGREDO,
    instancias: INSTANCIAS,
    cadastro: CADASTRO,
    repo,
    arquivoPendentes,
    esperaBaseMs: 1,
    logger: false,
  });
  return { app, fila, arquivoPendentes };
}

type App = Awaited<ReturnType<typeof montar>>['app'];

const post = (app: App, segredo: string, corpo: unknown) =>
  app.inject({
    method: 'POST',
    url: `/hooks/whatsapp/${segredo}`,
    headers: { 'content-type': 'application/json' },
    payload: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });

/** Envia e espera a fila terminar. Devolve o status HTTP e o que foi gravado. */
async function enviar(corpo: unknown) {
  const repo = new RepoMemoria();
  const { app, fila } = await montar(repo);
  const r = await post(app, SEGREDO, corpo);
  await proximoTique();
  await fila.esvaziar();
  return { status: r.statusCode, gravados: repo.gravados };
}

describe('POST /hooks/whatsapp/<segredo>: autenticação', () => {
  it('segredo errado: 404 e nada gravado', async () => {
    const repo = new RepoMemoria();
    const { app, fila } = await montar(repo);
    expect((await post(app, 'segredo-errado', mensagemGrupo())).statusCode).toBe(404);
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
    const { token: _, ...semToken } = mensagemGrupo();
    expect((await enviar(semToken)).status).toBe(401);
  });

  it('token de instância desconhecida: 401 e nada gravado', async () => {
    expect(await enviar(mensagemGrupo({}, 'outra-instancia'))).toEqual({ status: 401, gravados: [] });
  });

  it('a instância vem do token, não do instanceName', async () => {
    const r = await enviar({ ...mensagemGrupo({}, TOKEN), instanceName: 'roni_ramos' });
    expect(r.gravados[0]?.instancia).toBe('observador');
  });
});

describe('filtro na chegada', () => {
  it('grupo cadastrado: grava com a instância e a mensagem normalizada, sem token e com texto mascarado', async () => {
    const { status, gravados } = await enviar(mensagemGrupo());
    expect(status).toBe(200);
    expect(gravados).toHaveLength(1);
    const g = gravados[0]!;
    expect(g).toMatchObject({ evento: 'messages', id_mensagem: '3EB0BBBB0001', instancia: 'roni_ramos' });
    expect(g.mensagem).toMatchObject({ jid: GRUPO, autor_tipo: 'cliente', autor_numero: null, conta: true });
    const tudo = JSON.stringify(g);
    expect(tudo).not.toContain(TOKEN_RONI);
    expect(tudo).not.toContain(TEXTO);
    expect(tudo).toContain(`[texto omitido: ${TEXTO.length} caracteres]`);
  });

  it('conversa privada: 200 e nada gravado', async () => {
    const privada = mensagemGrupo({ isGroup: false, chatid: `${NUMERO_CLIENTE}@s.whatsapp.net` });
    expect(await enviar(privada)).toEqual({ status: 200, gravados: [] });
  });

  it('grupo não cadastrado (ou inativo, ou interno): 200 e nada gravado', async () => {
    expect(await enviar(mensagemGrupo({ chatid: '120363999999999@g.us' }))).toEqual({ status: 200, gravados: [] });
  });

  it('chatid de grupo com isGroup false não passa', async () => {
    expect((await enviar(mensagemGrupo({ isGroup: false }))).gravados).toEqual([]);
  });

  it('evento de conexão: 200 e nada gravado (status fica para a fase B)', async () => {
    expect(await enviar({ ...eventoConexao(), token: TOKEN_RONI })).toEqual({ status: 200, gravados: [] });
  });

  it('mensagem do próprio observador: nada gravado', async () => {
    expect((await enviar(mensagemGrupo({ fromMe: true }, TOKEN))).gravados).toEqual([]);
  });

  it('fromMe na instância de uma pessoa: mensagem do time', async () => {
    const r = await enviar(mensagemGrupo({ fromMe: true, sender_pn: `${NUMERO_TIME}@s.whatsapp.net` }));
    expect(r.gravados[0]?.mensagem).toMatchObject({ autor_tipo: 'time', autor_numero: NUMERO_TIME });
  });
});

describe('fila', () => {
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
    expect((await post(app, SEGREDO, mensagemGrupo())).statusCode).toBe(200);
    await proximoTique();
    expect(chamadas).toBe(1);
    expect(fila.pendentes).toBe(1); // ainda gravando
    liberar();
    await fila.esvaziar();
    expect(fila.pendentes).toBe(0);
  });

  it('banco fora: tenta 3 vezes, salva em pendentes (sem token e sem texto) e reenvia depois', async () => {
    let tentativas = 0;
    const fora: RepositorioEventos = {
      gravar: async () => {
        tentativas++;
        throw new Error('sem conexão');
      },
    };
    const { app, fila, arquivoPendentes } = await montar(fora);
    expect((await post(app, SEGREDO, mensagemGrupo())).statusCode).toBe(200);
    await proximoTique();
    await fila.esvaziar();
    expect(tentativas).toBe(3);

    const conteudo = await readFile(arquivoPendentes, 'utf8');
    expect(conteudo.trim().split('\n')).toHaveLength(1);
    expect(conteudo).not.toContain(TOKEN_RONI);
    expect(conteudo).not.toContain(TEXTO);

    // Banco voltou: o mesmo arquivo é reenviado por outra fila, com a mensagem normalizada junto.
    const repo = new RepoMemoria();
    const { fila: filaNova } = buildApp({
      segredo: SEGREDO,
      instancias: INSTANCIAS,
      cadastro: CADASTRO,
      repo,
      arquivoPendentes,
      logger: false,
    });
    expect(await filaNova.reenviarPendentes()).toBe(1);
    expect(repo.gravados[0]?.mensagem?.id_mensagem).toBe('3EB0BBBB0001');
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
