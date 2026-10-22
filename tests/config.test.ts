import { describe, expect, it } from 'vitest';
import { ErroConfig, lerConfig } from '../src/config.js';
import { SEGREDO, TOKEN, TOKEN_RONI } from './fixtures/payloads.js';

const base = { WEBHOOK_SEGREDO: SEGREDO, UAZAPI_INSTANCE_TOKEN: TOKEN };
const ler = (env: Record<string, string>, exigirBanco = false) => lerConfig(env, { exigirBanco });

describe('lerConfig', () => {
  it('valores padrão', () => {
    const c = ler(base);
    expect(c.porta).toBe(3000);
    expect(c.supabase).toBeUndefined();
  });

  it('segredo curto é recusado', () => {
    expect(() => ler({ ...base, WEBHOOK_SEGREDO: 'curto' })).toThrow(/WEBHOOK_SEGREDO/);
  });

  it('exige Supabase e login do painel quando há banco', () => {
    expect(() => ler(base, true)).toThrow(/SUPABASE_URL/);
    expect(() => ler(base, true)).toThrow(/PAINEL_SENHA/);
    const banco = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'chave' };
    expect(() => ler({ ...base, ...banco }, true)).toThrow(/PAINEL_USUARIO/);
    const c = ler({ ...base, ...banco, PAINEL_USUARIO: 'piloto', PAINEL_SENHA: 'senha-bem-longa-1234' }, true);
    expect(c.supabase).toEqual({ url: 'https://x.supabase.co', serviceRoleKey: 'chave' });
    expect(c.painel).toEqual({ usuario: 'piloto', senha: 'senha-bem-longa-1234' });
  });

  it('senha do painel curta ou usuário com ":" é recusado, sem mostrar o valor', () => {
    expect(() => ler({ ...base, PAINEL_USUARIO: 'piloto', PAINEL_SENHA: 'curta-XYZ' })).toThrow(/PAINEL_SENHA/);
    expect(() => ler({ ...base, PAINEL_USUARIO: 'pi:loto', PAINEL_SENHA: 'senha-bem-longa-1234' })).toThrow(
      /PAINEL_USUARIO/,
    );
    try {
      ler({ ...base, PAINEL_USUARIO: 'piloto', PAINEL_SENHA: 'curta-XYZ' });
    } catch (e) {
      expect((e as Error).message).not.toContain('curta-XYZ');
    }
  });

  it('sem banco, o painel é opcional', () => {
    expect(ler(base).painel).toBeUndefined();
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

describe('instâncias', () => {
  it('só o observador (UAZAPI_INSTANCE_TOKEN)', () => {
    expect(ler(base).instancias).toEqual([{ nome: 'observador', token: TOKEN, tipo: 'observador' }]);
  });

  it('RADAR_INSTANCIAS com token por instância; observador opcional', () => {
    const c = ler({
      WEBHOOK_SEGREDO: SEGREDO,
      RADAR_INSTANCIAS: ' Roni_Ramos , roni_ramos',
      UAZAPI_TOKEN_RONI_RAMOS: TOKEN_RONI,
    });
    expect(c.instancias).toEqual([{ nome: 'roni_ramos', token: TOKEN_RONI, tipo: 'pessoa' }]);
  });

  it('observador e pessoas juntos', () => {
    const c = ler({ ...base, RADAR_INSTANCIAS: 'roni_ramos', UAZAPI_TOKEN_RONI_RAMOS: TOKEN_RONI });
    expect(c.instancias.map((i) => `${i.nome}:${i.tipo}`)).toEqual(['observador:observador', 'roni_ramos:pessoa']);
  });

  it('token da instância faltando: erro com o nome da variável', () => {
    expect(() => ler({ ...base, RADAR_INSTANCIAS: 'roni_ramos' })).toThrow(/UAZAPI_TOKEN_RONI_RAMOS/);
  });

  it('nome inválido ou "observador" em RADAR_INSTANCIAS', () => {
    expect(() => ler({ ...base, RADAR_INSTANCIAS: '../x' })).toThrow(/RADAR_INSTANCIAS/);
    expect(() => ler({ ...base, RADAR_INSTANCIAS: 'observador' })).toThrow(/RADAR_INSTANCIAS/);
  });

  it('nenhuma instância: erro', () => {
    expect(() => ler({ WEBHOOK_SEGREDO: SEGREDO })).toThrow(ErroConfig);
    expect(() => ler({ WEBHOOK_SEGREDO: SEGREDO })).toThrow(/ao menos uma instância/);
  });
});
