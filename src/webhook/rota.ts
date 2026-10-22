import type { FastifyInstance } from 'fastify';
import type { Cadastro } from '../cadastro.js';
import type { InstanciaConfig } from '../config.js';
import { statusDoEventoConexao } from '../instancias/estado.js';
import { jidDoGrupo, normalizarMensagem } from '../mensagens/normalizar.js';
import type { EventoBruto } from '../repositorio.js';
import { sanitizarPayload } from './sanitizar.js';
import { iguaisSeguro, instanciaDoPayload } from './validar.js';

// POST /hooks/whatsapp/<segredo>: recebe o webhook da uazapi, responde 200 na hora
// e deixa a gravação para a fila (receptor lento atrasa a fila da instância).
// Só passa mensagem de grupo ativo cadastrado em public.grupos. O resto (conversa privada, grupo
// interno, grupo não cadastrado, outros eventos) é descartado na chegada, sem gravar nada.

export const PREFIXO_WEBHOOK = '/hooks/whatsapp/';

export interface DepsWebhook {
  segredo: string;
  instancias: InstanciaConfig[];
  cadastro: Cadastro;
  fila: { enfileirar(evento: EventoBruto): void };
  /** Recebe o status dos eventos "connection" (não grava nada). */
  estado?: { registrar(nome: string, statusUazapi: string, agora: number): void };
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
      const instancia = instanciaDoPayload(payload, deps.instancias);
      if (!instancia) {
        req.log.warn('webhook recusado: token ausente ou de instância desconhecida');
        return reply.code(401).send({ erro: 'não autorizado' });
      }

      reply.code(200).send({ ok: true });

      setImmediate(() => {
        try {
          const conexao = statusDoEventoConexao(payload);
          if (conexao !== undefined) {
            deps.estado?.registrar(instancia.nome, conexao, Date.now());
            req.log.info({ instancia: instancia.nome, status: conexao }, 'status da instância');
            return;
          }
          // Filtro antes de qualquer gravação. O log não leva o jid (identifica o cliente).
          const jid = jidDoGrupo(payload);
          if (!jid || !deps.cadastro.grupoAtivo(jid)) {
            req.log.debug({ instancia: instancia.nome }, 'evento descartado: fora dos grupos cadastrados');
            return;
          }
          const mensagem = normalizarMensagem(payload, instancia, (n) => deps.cadastro.ehDoTime(n), recebido_em);
          if (!mensagem) return;
          deps.fila.enfileirar({
            recebido_em,
            evento: 'messages',
            id_mensagem: mensagem.id_mensagem,
            instancia: instancia.nome,
            // Texto sempre mascarado: os brutos são só para depurar o piloto.
            payload: sanitizarPayload(payload, { guardarTexto: false }),
            mensagem,
          });
        } catch (e) {
          req.log.error({ erro: (e as Error).name }, 'falha ao enfileirar evento');
        }
      });
      return reply;
    },
  );
}
