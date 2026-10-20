import type { FastifyInstance } from 'fastify';
import type { EventoBruto } from '../repositorio.js';
import { sanitizarPayload } from './sanitizar.js';
import { iguaisSeguro, tokenValido } from './validar.js';

// POST /hooks/whatsapp/<segredo>: recebe o webhook da uazapi, responde 200 na hora
// e deixa a gravação para a fila (receptor lento atrasa a fila da instância).

export const PREFIXO_WEBHOOK = '/hooks/whatsapp/';

export interface DepsWebhook {
  segredo: string;
  tokenInstancia: string;
  guardarTexto: boolean;
  fila: { enfileirar(evento: EventoBruto): void };
}

function campo(obj: unknown, chave: string): unknown {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  return (obj as Record<string, unknown>)[chave];
}

function campoTexto(obj: unknown, chave: string): string | null {
  const v = campo(obj, chave);
  return typeof v === 'string' ? v : null;
}

export function registrarWebhook(app: FastifyInstance, deps: DepsWebhook): void {
  app.post<{ Params: { segredo: string } }>(
    `${PREFIXO_WEBHOOK}:segredo`,
    {
      bodyLimit: 5 * 1024 * 1024,
      // Antes de ler o corpo: segredo errado não descobre nem que a rota existe.
      onRequest: async (req, reply) => {
        if (!iguaisSeguro(req.params.segredo, deps.segredo)) {
          return reply.code(404).send({ erro: 'não encontrado' });
        }
      },
    },
    async (req, reply) => {
      const recebido_em = new Date().toISOString();
      const payload = req.body;
      if (!tokenValido(payload, deps.tokenInstancia)) {
        req.log.warn('webhook recusado: token ausente ou de outra instância');
        return reply.code(401).send({ erro: 'não autorizado' });
      }

      reply.code(200).send({ ok: true });

      setImmediate(() => {
        try {
          deps.fila.enfileirar({
            recebido_em,
            evento: campoTexto(payload, 'EventType'),
            id_mensagem: campoTexto(campo(payload, 'message'), 'messageid'),
            payload: sanitizarPayload(payload, { guardarTexto: deps.guardarTexto }),
          });
        } catch (e) {
          req.log.error({ erro: (e as Error).name }, 'falha ao enfileirar evento');
        }
      });
      return reply;
    },
  );
}
