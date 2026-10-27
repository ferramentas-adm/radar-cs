import type { FastifyInstance } from 'fastify';
import type { Cadastro } from '../cadastro.js';
import type { InstanciaConfig } from '../config.js';
import type { Cadastrador } from '../conversas/cadastrador.js';
import { conversaDoEvento } from '../conversas/classificar.js';
import type { Classificacao, Classificador } from '../classificador/classificador.js';
import { statusDoEventoConexao } from '../instancias/estado.js';
import { normalizarMensagem, textoDaMensagem } from '../mensagens/normalizar.js';
import type { EventoBruto } from '../repositorio.js';
import { sanitizarPayload, sanitizarPayloadPrivada } from './sanitizar.js';
import { iguaisSeguro, instanciaDoPayload } from './validar.js';

// POST /hooks/whatsapp/<segredo>: recebe o webhook da uazapi, responde 200 na hora
// e deixa a classificação e a gravação para depois (receptor lento atrasa a fila da instância).
// Passa toda conversa de cliente (grupo ou privada) que não esteja bloqueada; o cadastrador cadastra
// a conversa nova. Conversa interna, bloqueada ou que não deu para classificar é descartada na
// chegada, sem gravar nada. Os logs nunca levam número, JID, hash nem texto.

export const PREFIXO_WEBHOOK = '/hooks/whatsapp/';

export interface DepsWebhook {
  segredo: string;
  instancias: InstanciaConfig[];
  cadastro: Cadastro;
  conversas: Pick<Cadastrador, 'resolver'>;
  fila: { enfileirar(evento: EventoBruto): void; acompanhar(trabalho: Promise<void>): void };
  /** Classifica a urgência das mensagens do cliente (só grupos). Sem isto, tudo vale médio. */
  classificador?: Classificador;
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

      const processar = async () => {
        const conexao = statusDoEventoConexao(payload);
        if (conexao !== undefined) {
          deps.estado?.registrar(instancia.nome, conexao, Date.now());
          req.log.info({ instancia: instancia.nome, status: conexao }, 'status da instância');
          return;
        }
        const conversa = conversaDoEvento(payload);
        if (!conversa) return;
        // LID ↔ número de quem escreveu (só em memória): ajuda a reconhecer o time e a privada por @lid.
        if (conversa.autorLid !== '' && conversa.autorNumero !== '') {
          deps.cadastro.aprenderLid(conversa.autorLid, conversa.autorNumero);
        }
        // Normaliza antes de cadastrar: evento sem messageid ou do próprio observador não cadastra nada.
        const ehDoTime = (n: string) => deps.cadastro.ehDoTime(n);
        const previa = normalizarMensagem(payload, instancia, ehDoTime, recebido_em, 'previa');
        if (!previa) return;
        const r = await deps.conversas.resolver(conversa, instancia, previa.enviada_em);
        if (r.acao === 'descartar') {
          req.log.debug({ instancia: instancia.nome, tipo: conversa.tipo, motivo: r.motivo }, 'evento descartado');
          return;
        }
        // Urgência: só mensagem de texto do cliente em grupo (a privada não sai do servidor; o áudio
        // ainda não é transcrito). Falha = sem classificação, que vale médio. O texto fica em memória.
        let classificacao: Classificacao | null = null;
        if (deps.classificador && conversa.tipo === 'grupo') {
          const corpo = textoDaMensagem(payload);
          if (previa.autor_tipo === 'cliente' && previa.conta && previa.tipo !== 'audio' && corpo.trim() !== '') {
            classificacao = await deps.classificador.classificar({ jid: r.jid, texto: corpo });
          }
          deps.classificador.lembrar(r.jid, previa.autor_tipo, corpo);
        }
        deps.fila.enfileirar({
          recebido_em,
          evento: 'messages',
          id_mensagem: previa.id_mensagem,
          instancia: instancia.nome,
          // Texto sempre mascarado; na privada, sem o chatid nem os números (os brutos são só do piloto).
          payload:
            conversa.tipo === 'privada'
              ? sanitizarPayloadPrivada(payload)
              : sanitizarPayload(payload, { guardarTexto: false }),
          mensagem: { ...previa, jid: r.jid, ...(classificacao ?? {}) },
        });
      };

      setImmediate(() => {
        deps.fila.acompanhar(
          processar().catch((e: unknown) => {
            req.log.error({ erro: (e as Error).name }, 'falha ao processar evento');
          }),
        );
      });
      return reply;
    },
  );
}
