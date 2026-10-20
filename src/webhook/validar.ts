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
