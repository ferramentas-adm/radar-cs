import { describe, expect, it } from 'vitest';
import { ErroConfig, lerConfig } from '../src/config.js';
import { SEGREDO, TOKEN } from './fixtures/payloads.js';

const base = { WEBHOOK_SEGREDO: SEGREDO, UAZAPI_INSTANCE_TOKEN: TOKEN };
const ler = (env: Record<string, string>, exigirBanco = false) => lerConfig(env, { exigirBanco });

describe('lerConfig', () => {
  it('DESCOBERTA_GUARDAR_TEXTO: ausente, vazio ou "false" = false', () => {
    expect(ler(base).guardarTexto).toBe(false);
    expect(ler({ ...base, DESCOBERTA_GUARDAR_TEXTO: '' }).guardarTexto).toBe(false);
    expect(ler({ ...base, DESCOBERTA_GUARDAR_TEXTO: 'false' }).guardarTexto).toBe(false);
  });

  it('DESCOBERTA_GUARDAR_TEXTO: só "true" liga', () => {
    expect(ler({ ...base, DESCOBERTA_GUARDAR_TEXTO: 'true' }).guardarTexto).toBe(true);
  });

  it('DESCOBERTA_GUARDAR_TEXTO com valor estranho é erro, não liga em silêncio', () => {
    expect(() => ler({ ...base, DESCOBERTA_GUARDAR_TEXTO: 'sim' })).toThrow(ErroConfig);
  });

  it('valores padrão', () => {
    const c = ler(base);
    expect(c.porta).toBe(3000);
    expect(c.supabase).toBeUndefined();
  });

  it('segredo curto é recusado', () => {
    expect(() => ler({ ...base, WEBHOOK_SEGREDO: 'curto' })).toThrow(/WEBHOOK_SEGREDO/);
  });

  it('exige Supabase quando pedido', () => {
    expect(() => ler(base, true)).toThrow(/SUPABASE_URL/);
    const c = ler({ ...base, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'chave' }, true);
    expect(c.supabase).toEqual({ url: 'https://x.supabase.co', serviceRoleKey: 'chave' });
  });

  it('o erro cita as variáveis, nunca os valores', () => {
    const segredoCurto = 'valor-secreto-curto';
    try {
      ler({ WEBHOOK_SEGREDO: segredoCurto, UAZAPI_BASE_URL: 'nao-e-url-SECRETA', SUPABASE_SERVICE_ROLE_KEY: 'chave-XYZ' }, true);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('WEBHOOK_SEGREDO');
      expect(msg).toContain('UAZAPI_INSTANCE_TOKEN');
      expect(msg).toContain('UAZAPI_BASE_URL');
      expect(msg).not.toContain(segredoCurto);
      expect(msg).not.toContain('SECRETA');
      expect(msg).not.toContain('chave-XYZ');
    }
  });
});
