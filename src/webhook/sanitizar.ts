// Limpa o payload do webhook antes de qualquer log ou gravação (função pura, devolve cópia).
// 1. Remove o token da instância em qualquer nível (regra inegociável 3).
// 2. Na fase de descoberta, mascara o texto das mensagens por padrão. Além de message.text e
//    message.content, mascara qualquer string sob chaves de texto (citações, legendas, prévia
//    da última mensagem do chat), para não vazar conversa por um caminho que ainda não conhecemos.

const CHAVES_SEGREDO = new Set(['token', 'admintoken']);

// Chave com valor string que carrega texto de conversa.
function eChaveDeTexto(chave: string): boolean {
  const c = chave.toLowerCase();
  return c === 'content' || c.includes('text') || c.includes('conversation') || c.includes('caption');
}

export function mascararTexto(texto: string): string {
  return `[texto omitido: ${texto.length} caracteres]`;
}

export function sanitizarPayload(payload: unknown, opcoes: { guardarTexto: boolean }): unknown {
  return limpar(payload, opcoes.guardarTexto);
}

function limpar(valor: unknown, guardarTexto: boolean): unknown {
  if (Array.isArray(valor)) return valor.map((v) => limpar(v, guardarTexto));
  if (valor === null || typeof valor !== 'object') return valor;

  const saida: Record<string, unknown> = {};
  for (const [chave, v] of Object.entries(valor)) {
    if (CHAVES_SEGREDO.has(chave.toLowerCase())) continue;
    if (!guardarTexto && typeof v === 'string' && eChaveDeTexto(chave)) {
      saida[chave] = mascararTexto(v);
    } else {
      saida[chave] = limpar(v, guardarTexto);
    }
  }
  return saida;
}
