// Resumo dos payloads de eventos_brutos para responder às dúvidas do passo 1:
// sender chega como número (@s.whatsapp.net) ou LID (@lid)? Quais messageType existem?
// Só estrutura: nunca devolve texto, números de telefone nem IDs.

export interface ResumoDescoberta {
  total: number;
  porEvento: Record<string, number>;
  porMessageType: Record<string, number>;
  /** Sufixo do identificador (ex.: "@lid", "@s.whatsapp.net") por campo do message que parece identificar o autor. */
  formatoAutor: Record<string, Record<string, number>>;
  fromMe: Record<string, number>;
  isGroup: Record<string, number>;
  /** Por messageType: quantas vezes cada chave apareceu em message (mostra onde fica a citação, a reação etc.). */
  chavesPorMessageType: Record<string, Record<string, number>>;
}

const somar = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

function objeto(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function sufixoJid(v: unknown): string {
  if (typeof v !== 'string' || v === '') return '(vazio)';
  const i = v.indexOf('@');
  return i === -1 ? '(sem @)' : v.slice(i);
}

// Campos do message que podem identificar quem escreveu.
const CAMPOS_AUTOR = /^(sender|participant|author|from)/i;

export function resumirPayloads(payloads: unknown[]): ResumoDescoberta {
  const r: ResumoDescoberta = {
    total: payloads.length,
    porEvento: {},
    porMessageType: {},
    formatoAutor: {},
    fromMe: {},
    isGroup: {},
    chavesPorMessageType: {},
  };
  for (const p of payloads) {
    const raiz = objeto(p);
    somar(r.porEvento, String(raiz?.EventType ?? '(sem EventType)'));
    const msg = objeto(raiz?.message);
    if (!msg) continue;

    const tipo = String(msg.messageType ?? '(sem messageType)');
    somar(r.porMessageType, tipo);
    somar(r.fromMe, String(msg.fromMe));
    somar(r.isGroup, String(msg.isGroup));

    for (const [chave, valor] of Object.entries(msg)) {
      if (typeof valor === 'string' && CAMPOS_AUTOR.test(chave) && !/name/i.test(chave)) {
        r.formatoAutor[chave] ??= {};
        somar(r.formatoAutor[chave], sufixoJid(valor));
      }
    }

    r.chavesPorMessageType[tipo] ??= {};
    for (const chave of Object.keys(msg)) somar(r.chavesPorMessageType[tipo], chave);
  }
  return r;
}
