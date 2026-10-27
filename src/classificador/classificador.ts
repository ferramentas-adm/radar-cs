// Classificador das mensagens do cliente (passo 3b): Claude Haiku diz o nível de urgência e se a
// mensagem exige resposta. O texto só passa em memória: nunca é gravado nem vai para o log.
// Qualquer falha (rede, HTTP, JSON inválido) devolve null, e a mensagem vale médio e exige resposta
// (o relógio nunca deixa de correr por erro do classificador).
import { z } from 'zod';
import type { Urgencia } from '../motor/calcular.js';

export interface Classificacao {
  categoria: string;
  urgencia: Urgencia;
  exige_resposta: boolean;
}

export interface Classificador {
  /** null = falhou (vale médio). */
  classificar(entrada: { jid: string; texto: string }): Promise<Classificacao | null>;
  /** Guarda o texto, só em memória, para servir de contexto da próxima mensagem do mesmo grupo. */
  lembrar(jid: string, autor: 'cliente' | 'time', texto: string): void;
}

export interface LogClassificador {
  warn(obj: object, msg: string): void;
}

export interface OpcoesClassificador {
  chave: string;
  modelo: string;
  /** Conteúdo de prompts/classificador.md. */
  prompt: string;
  log: LogClassificador;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Chamadas à API ao mesmo tempo. */
  concorrencia?: number;
}

const URL_API = 'https://api.anthropic.com/v1/messages';
const CONTEXTO_MENSAGENS = 5;
const CONTEXTO_GRUPOS = 500;
const MAX_TEXTO = 2000;
const MAX_TEXTO_CONTEXTO = 300;

const resposta = z.object({
  categoria: z.string().trim().min(1).transform((c) => c.slice(0, 40)),
  urgencia: z.enum(['alto', 'medio', 'baixo']),
  exige_resposta: z.boolean(),
});

/** Primeiro objeto JSON do texto devolvido pelo modelo (ele pode envolvê-lo em ```). */
export function lerClassificacao(texto: string): Classificacao | null {
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try {
    const r = resposta.safeParse(JSON.parse(texto.slice(ini, fim + 1)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const cortar = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

export function montarEntrada(contexto: { autor: 'cliente' | 'time'; texto: string }[], texto: string): string {
  const anteriores =
    contexto.length === 0
      ? '(nenhuma)'
      : contexto.map((c) => `${c.autor === 'time' ? 'TIME' : 'CLIENTE'}: ${cortar(c.texto, MAX_TEXTO_CONTEXTO)}`).join('\n');
  return `Mensagens anteriores do grupo (contexto):\n${anteriores}\n\nMensagem do CLIENTE a classificar:\n<<<\n${cortar(texto, MAX_TEXTO)}\n>>>`;
}

export function criarClassificador(op: OpcoesClassificador): Classificador {
  const chamar = op.fetchImpl ?? fetch;
  const timeoutMs = op.timeoutMs ?? 8000;
  const limite = op.concorrencia ?? 4;
  const contextos = new Map<string, { autor: 'cliente' | 'time'; texto: string }[]>();

  // Semáforo simples: no máximo `limite` chamadas ao mesmo tempo.
  let ativas = 0;
  const espera: (() => void)[] = [];
  const entrar = async () => {
    if (ativas < limite) ativas++;
    else await new Promise<void>((r) => espera.push(r)); // a vaga passa direto de quem sai para quem espera
  };
  const sair = () => {
    const proximo = espera.shift();
    if (proximo) proximo();
    else ativas--;
  };

  return {
    lembrar(jid, autor, texto) {
      if (texto.trim() === '') return;
      const lista = contexto(jid);
      lista.push({ autor, texto });
      if (lista.length > CONTEXTO_MENSAGENS) lista.shift();
    },

    async classificar({ jid, texto }) {
      await entrar();
      try {
        const ctx = contextos.get(jid) ?? [];
        const r = await chamar(URL_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': op.chave, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: op.modelo,
            max_tokens: 120,
            system: op.prompt,
            messages: [{ role: 'user', content: montarEntrada(ctx, texto) }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) {
          op.log.warn({ status: r.status }, 'classificador: resposta HTTP de erro');
          return null;
        }
        const corpo = (await r.json()) as { content?: { type?: string; text?: string }[] };
        const saida = corpo.content?.find((b) => b.type === 'text')?.text ?? '';
        const c = lerClassificacao(saida);
        if (!c) op.log.warn({}, 'classificador: resposta fora do formato');
        return c;
      } catch (e) {
        // Só o nome do erro: a mensagem pode trazer o corpo da requisição.
        op.log.warn({ erro: (e as Error).name }, 'classificador: falha na chamada');
        return null;
      } finally {
        sair();
      }
    },
  };

  function contexto(jid: string) {
    let lista = contextos.get(jid);
    if (!lista) {
      lista = [];
      contextos.set(jid, lista);
      if (contextos.size > CONTEXTO_GRUPOS) contextos.delete(contextos.keys().next().value as string);
    }
    return lista;
  }
}
