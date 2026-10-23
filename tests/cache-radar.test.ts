import { describe, expect, it } from 'vitest';
import { CACHE_RADAR_MS, CacheRadar } from '../src/api/cache.js';

function montar(falhar: () => boolean = () => false) {
  let relogio = 0;
  let consultas = 0;
  let soltar: (() => void) | undefined;
  let segurar = false;
  const cache = new CacheRadar(
    async () => {
      consultas++;
      if (segurar) await new Promise<void>((r) => (soltar = r));
      if (falhar()) throw new Error('banco fora');
      return { versao: consultas };
    },
    CACHE_RADAR_MS,
    () => relogio,
  );
  return {
    cache,
    avancar: (ms: number) => void (relogio += ms),
    consultas: () => consultas,
    segurar: () => void (segurar = true),
    soltar: () => soltar?.(),
  };
}

describe('CacheRadar (dados do GET /api/radar)', () => {
  it('30 s por padrão', () => expect(CACHE_RADAR_MS).toBe(30_000));

  it('dentro do prazo não consulta de novo; vencido consulta', async () => {
    const c = montar();
    expect(await c.cache.obter()).toEqual({ versao: 1 });
    c.avancar(29_999);
    expect(await c.cache.obter()).toEqual({ versao: 1 });
    c.avancar(1);
    expect(await c.cache.obter()).toEqual({ versao: 2 });
    expect(c.consultas()).toBe(2);
  });

  it('vários painéis ao mesmo tempo com o cache vencido: uma consulta só', async () => {
    const c = montar();
    c.segurar();
    const pedidos = Array.from({ length: 5 }, () => c.cache.obter());
    c.soltar();
    expect(await Promise.all(pedidos)).toEqual(Array(5).fill({ versao: 1 }));
    expect(c.consultas()).toBe(1);
  });

  it('erro não fica guardado: o próximo pedido tenta de novo', async () => {
    let falhar = true;
    const c = montar(() => falhar);
    await expect(c.cache.obter()).rejects.toThrow('banco fora');
    falhar = false;
    expect(await c.cache.obter()).toEqual({ versao: 2 });
    expect(c.consultas()).toBe(2);
  });

  it('erro depois de um dado bom: não serve o dado vencido e tenta de novo depois', async () => {
    let falhar = false;
    const c = montar(() => falhar);
    await c.cache.obter();
    c.avancar(CACHE_RADAR_MS);
    falhar = true;
    await expect(c.cache.obter()).rejects.toThrow('banco fora');
    falhar = false;
    expect(await c.cache.obter()).toEqual({ versao: 3 });
  });
});
