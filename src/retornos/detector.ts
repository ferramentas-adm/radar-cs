// IA dos retornos prometidos (passo 7). O texto das mensagens não é guardado, então a promessa é
// detectada na chegada de cada mensagem de texto do time num grupo, com as mensagens anteriores do
// grupo como contexto (só em memória, até 10). Prompt versionado em prompts/retornos.md.
// O que fica no banco é só o resumo (até 10 palavras) e o prazo. Falha da IA = nenhuma promessa
// registrada (e um aviso no log, só com o código); nunca o texto no log.
import { z } from 'zod';
import { formatarLocal, instanteLocal } from '../motor/expediente.js';

export const FUSO = 'America/Sao_Paulo';
const URL_API = 'https://api.anthropic.com/v1/messages';
const CONTEXTO = 10;
const CONTEXTO_GRUPOS = 500;
const MAX_TEXTO = 1500;

export interface MensagemContexto {
  id: string;
  autor: 'cliente' | 'time';
  texto: string;
  em: number; // ms
}

export interface PromessaDetectada {
  id_mensagem: string;
  promessa: string;
  prazo: number; // ms
}

export interface DetectorRetornos {
  /** Promessas feitas na mensagem `alvo` (do time). Lista vazia também em falha. */
  detectar(jid: string, alvo: MensagemContexto): Promise<PromessaDetectada[]>;
  /** Guarda a mensagem (só em memória) para servir de contexto às próximas do mesmo grupo. */
  lembrar(jid: string, m: MensagemContexto): void;
}

export interface OpcoesDetector {
  chave: string;
  modelo: string;
  /** Conteúdo de prompts/retornos.md, com {agora} e {mensagens}. */
  prompt: string;
  log: { warn(obj: object, msg: string): void };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  agora?: () => number;
}

const resposta = z.array(
  z.object({
    id_mensagem: z.string(),
    promessa: z.string().trim().min(1),
    prazo: z.string(),
  }),
);

const cortar = (t: string) => (t.length > MAX_TEXTO ? `${t.slice(0, MAX_TEXTO)}…` : t);

export function montarPrompt(prompt: string, agora: number, contexto: MensagemContexto[], alvo: MensagemContexto): string {
  const linha = (m: MensagemContexto, marca: string) =>
    `${marca}[${m.id}] ${formatarLocal(m.em, FUSO)} ${m.autor === 'time' ? 'TIME' : 'CLIENTE'}: ${cortar(m.texto)}`;
  const mensagens = [...contexto.map((m) => linha(m, '    ')), linha(alvo, '>>> ')].join('\n');
  return prompt.replace('{agora}', formatarLocal(agora, FUSO)).replace('{mensagens}', mensagens);
}

/**
 * Lê a lista devolvida pela IA. Só vale promessa da mensagem alvo, com prazo válido; o resumo é
 * cortado em 10 palavras (120 caracteres). JSON inválido = null.
 */
export function lerPromessas(texto: string, idAlvo: string): PromessaDetectada[] | null {
  const ini = texto.indexOf('[');
  const fim = texto.lastIndexOf(']');
  if (ini < 0 || fim < ini) return null;
  let r;
  try {
    r = resposta.safeParse(JSON.parse(texto.slice(ini, fim + 1)));
  } catch {
    return null;
  }
  if (!r.success) return null;
  const saida: PromessaDetectada[] = [];
  for (const p of r.data) {
    if (p.id_mensagem !== idAlvo) continue;
    const prazo = instanteLocal(p.prazo, FUSO);
    if (prazo === undefined) continue;
    const promessa = p.promessa.split(/\s+/).slice(0, 10).join(' ').slice(0, 120);
    saida.push({ id_mensagem: p.id_mensagem, promessa, prazo });
  }
  return saida;
}

export function criarDetectorRetornos(op: OpcoesDetector): DetectorRetornos {
  const chamar = op.fetchImpl ?? fetch;
  const agora = op.agora ?? Date.now;
  const contextos = new Map<string, MensagemContexto[]>();

  return {
    lembrar(jid, m) {
      if (m.texto.trim() === '') return;
      let lista = contextos.get(jid);
      if (!lista) {
        lista = [];
        contextos.set(jid, lista);
        if (contextos.size > CONTEXTO_GRUPOS) contextos.delete(contextos.keys().next().value as string);
      }
      lista.push(m);
      if (lista.length > CONTEXTO) lista.shift();
    },

    async detectar(jid, alvo) {
      try {
        const r = await chamar(URL_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': op.chave, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: op.modelo,
            max_tokens: 300,
            messages: [{ role: 'user', content: montarPrompt(op.prompt, agora(), contextos.get(jid) ?? [], alvo) }],
          }),
          signal: AbortSignal.timeout(op.timeoutMs ?? 15_000),
        });
        if (!r.ok) {
          op.log.warn({ status: r.status }, 'retornos: resposta HTTP de erro');
          return [];
        }
        const corpo = (await r.json()) as { content?: { type?: string; text?: string }[] };
        const lidas = lerPromessas(corpo.content?.find((b) => b.type === 'text')?.text ?? '', alvo.id);
        if (lidas === null) {
          op.log.warn({}, 'retornos: resposta fora do formato');
          return [];
        }
        return lidas;
      } catch (e) {
        op.log.warn({ erro: (e as Error).name }, 'retornos: falha na chamada');
        return [];
      }
    },
  };
}
