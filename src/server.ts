import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { RepositorioEventos } from './repositorio.js';
import { FilaGravacao } from './webhook/fila.js';
import { PREFIXO_WEBHOOK, registrarWebhook } from './webhook/rota.js';

// Monta o app HTTP. Dependências injetáveis para testar sem banco.

export type OpcoesLogger = Exclude<FastifyServerOptions['logger'], undefined>;

export interface DepsApp {
  segredo: string;
  tokenInstancia: string;
  guardarTexto: boolean;
  repo: RepositorioEventos;
  arquivoPendentes: string;
  esperaBaseMs?: number;
  logger?: OpcoesLogger;
}

/** Troca o segredo da URL do webhook por *** antes de qualquer log. */
export function mascararUrl(url: string): string {
  return url.startsWith(PREFIXO_WEBHOOK) ? `${PREFIXO_WEBHOOK}***` : url;
}

export function opcoesLogger(extra: Record<string, unknown> = {}): OpcoesLogger {
  return {
    level: 'info',
    ...extra,
    // Nunca logar corpo, headers ou o segredo do caminho.
    serializers: {
      req: (req: { method: string; url: string }) => ({ method: req.method, url: mascararUrl(req.url) }),
    },
  };
}

export function buildApp(deps: DepsApp): { app: FastifyInstance; fila: FilaGravacao } {
  const app = Fastify({ logger: deps.logger ?? opcoesLogger() });

  const fila = new FilaGravacao(deps.repo, {
    arquivoPendentes: deps.arquivoPendentes,
    log: app.log,
    ...(deps.esperaBaseMs !== undefined ? { esperaBaseMs: deps.esperaBaseMs } : {}),
  });

  // Erros sem a mensagem original: a de JSON inválido ecoa um trecho do corpo (e do token).
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) {
      req.log.info({ codigo: err.code }, 'requisição recusada');
      return reply.code(status).send({ erro: status === 400 ? 'requisição inválida' : 'recusada' });
    }
    req.log.error({ codigo: err.code, erro: err.name }, 'erro interno');
    return reply.code(500).send({ erro: 'erro interno' });
  });

  app.get('/saude', async () => ({ ok: true, gravacoes_em_andamento: fila.pendentes }));

  registrarWebhook(app, {
    segredo: deps.segredo,
    tokenInstancia: deps.tokenInstancia,
    guardarTexto: deps.guardarTexto,
    fila,
  });

  return { app, fila };
}
