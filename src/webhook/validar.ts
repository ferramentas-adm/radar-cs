import { createHash, timingSafeEqual } from 'node:crypto';

// O webhook da uazapi não tem assinatura documentada: conferimos o segredo do caminho
// e o token da instância que vem no payload. Comparação em tempo constante.

export function iguaisSeguro(a: string, b: string): boolean {
  // Hash antes de comparar: timingSafeEqual exige o mesmo tamanho e não pode vazar o tamanho.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function tokenDoPayload(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const token = (payload as Record<string, unknown>).token;
  return typeof token === 'string' ? token : undefined;
}

export function tokenValido(payload: unknown, tokenInstancia: string): boolean {
  const token = tokenDoPayload(payload);
  return token !== undefined && iguaisSeguro(token, tokenInstancia);
}

/**
 * Qual instância mandou o evento, pelo token do payload (nunca pelo instanceName, que não é segredo).
 * Compara com todas as instâncias, sem parar na primeira, para o tempo não depender de qual bateu.
 */
export function instanciaDoPayload<T extends { token: string }>(payload: unknown, instancias: T[]): T | undefined {
  const token = tokenDoPayload(payload);
  if (token === undefined) return undefined;
  let achada: T | undefined;
  for (const i of instancias) if (iguaisSeguro(token, i.token) && achada === undefined) achada = i;
  return achada;
}
