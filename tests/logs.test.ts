import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jidPrivada } from '../src/conversas/chave.js';
import type { RepositorioEventos } from '../src/repositorio.js';
import { buildApp, opcoesLogger, type DepsApp } from '../src/server.js';
import { CHAVES, cadastroFixo } from './fixtures/cadastro.js';
import {
  CHAT_PRIVADO,
  GRUPO,
  LID_CLIENTE,
  NUMERO_CLIENTE,
  NUMERO_TIME,
  SEGREDO,
  TEXTO,
  TOKEN,
  TOKEN_RONI,
  mensagemGrupo,
  mensagemPrivada,
  mensagemTexto,
} from './fixtures/payloads.js';

// Regra inegociável 3: nunca logar o payload (ele carrega o token). Nem o segredo da URL.
// E nenhum log leva número, JID (de grupo ou de privada), hash da privada nem texto.

async function montarComLog(repo: RepositorioEventos, extra: Partial<DepsApp> = {}) {
  const linhas: string[] = [];
  const stream = { write: (s: string) => void linhas.push(s) };
  const pasta = await mkdtemp(join(tmpdir(), 'radar-cs-log-'));
  const { app, fila } = buildApp({
    segredo: SEGREDO,
    instancias: [{ nome: 'observador', token: TOKEN, tipo: 'observador' }],
    cadastro: cadastroFixo({ ativas: ['120363040001000@g.us'] }),
    repo,
    arquivoPendentes: join(pasta, 'pendentes.jsonl'),
    esperaBaseMs: 1,
    // debug: os descartes também entram na verificação.
    logger: opcoesLogger({ stream, level: 'debug' }),
    ...extra,
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

  it('conversas (privada, interna, grupo novo, consulta e cadastro falhando, bloqueio): nem número, nem JID, nem hash, nem texto', async () => {
    const GRUPO_NOVO = '120363040009999@g.us';
    const GRUPO_BLOQUEADO = '120363040008888@g.us';
    let falharCadastro = false;
    const { app, fila, linhas } = await montarComLog(
      {
        gravar: async () => {
          throw new Error('sem conexão');
        },
      },
      {
        instancias: [
          { nome: 'observador', token: TOKEN, tipo: 'observador' },
          { nome: 'roni_ramos', token: TOKEN_RONI, tipo: 'pessoa' },
        ],
        cadastro: cadastroFixo({
          ativas: [GRUPO],
          bloqueadas: [GRUPO_BLOQUEADO],
          time: [NUMERO_TIME],
          donos: { roni_ramos: { especialista: 'Roni Ramos', gestor: null } },
        }),
        conversas: {
          chaves: CHAVES,
          consultarParticipantes: async () => {
            throw new Error('uazapi /group/info: HTTP 500');
          },
          gravarConversa: async () => {
            if (falharCadastro) throw new Error('supabase (grupos): falhou');
            return true;
          },
        },
      },
    );
    const doTime = `${NUMERO_TIME}@s.whatsapp.net`;
    const eventos = [
      mensagemPrivada(), // privada de cliente: cadastra e tenta gravar (o banco falha)
      mensagemPrivada({ messageid: 'P2', chatid: doTime, sender_pn: doTime }), // privada interna
      mensagemPrivada({ messageid: 'P3' }, TOKEN), // privada no observador
      mensagemGrupo({ messageid: 'G1', chatid: GRUPO_NOVO }), // grupo novo de cliente
      mensagemGrupo({ messageid: 'G2', chatid: '120363040007777@g.us', sender_pn: doTime }), // consulta falha
      mensagemGrupo({ messageid: 'G3', chatid: GRUPO_BLOQUEADO }), // bloqueado
    ];
    for (const e of eventos) await enviar(app, SEGREDO, JSON.stringify(e));
    falharCadastro = true;
    await enviar(app, SEGREDO, JSON.stringify(mensagemPrivada({ messageid: 'P4', chatid: '5511911112222@s.whatsapp.net', sender_pn: '' })));
    await new Promise<void>((r) => setImmediate(r));
    await fila.esvaziar();

    const log = linhas.join('');
    expect(log).toContain('conversa cadastrada');
    expect(log).toContain('falha ao consultar participantes');
    expect(log).toContain('falha ao cadastrar conversa');
    semVazamento(log);
    const hash = jidPrivada('roni_ramos', `pn:${'551188887777'}`, CHAVES.conversa);
    for (const proibido of [
      NUMERO_CLIENTE,
      '551188887777', // sem o nono dígito
      NUMERO_TIME,
      '5511911112222',
      CHAT_PRIVADO,
      LID_CLIENTE,
      '111111111111111',
      GRUPO,
      GRUPO_NOVO,
      GRUPO_BLOQUEADO,
      'privada:',
      hash.slice('privada:'.length),
      'Contato Cliente',
      'Cliente Teste',
    ]) {
      expect(log, proibido).not.toContain(proibido);
    }
    expect(log).not.toMatch(/[0-9a-f]{64}/); // nenhum hash
  });
});
