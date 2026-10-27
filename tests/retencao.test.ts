import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { lerConfig } from '../src/config.js';
import { limparRetencao } from '../src/retencao.js';
import { SEGREDO, TOKEN } from './fixtures/payloads.js';

const SQL = readFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', '20261030120000_retencao.sql'), 'utf8');

const db = (data: unknown, error: { code?: string; message?: string } | null = null) => {
  const chamadas: string[] = [];
  const cliente = { rpc: async (fn: string) => (chamadas.push(fn), { data, error }) } as unknown as SupabaseClient;
  return { cliente, chamadas };
};

describe('limparRetencao', () => {
  it('chama a função do banco e devolve só contagens', async () => {
    const { cliente, chamadas } = db({ mensagens: 12, eventos_brutos: 3 });
    expect(await limparRetencao(cliente)).toEqual({ mensagens: 12, eventos_brutos: 3 });
    expect(chamadas).toEqual(['limpar_retencao']);
  });

  it('erro do banco: só o código', async () => {
    const { cliente } = db(null, { code: 'PGRST202', message: 'detalhe com dado' });
    const e = await limparRetencao(cliente).catch((x: Error) => x);
    expect((e as Error).message).toContain('PGRST202');
    expect((e as Error).message).not.toContain('detalhe');
  });
});

describe('migration de retenção', () => {
  it('apaga só mensagens de conversa bloqueada há mais de 90 dias', () => {
    expect(SQL).toMatch(/not g\.ativo\s+and g\.desativado_em is not null\s+and g\.desativado_em < now\(\) - interval '90 days'/);
  });

  it('conversas já bloqueadas começam a contar na migration, nunca antes', () => {
    expect(SQL).toContain('update public.grupos set desativado_em = now() where not ativo;');
  });

  it('reativar zera a data; bloquear marca agora', () => {
    expect(SQL).toMatch(/if new\.ativo and not old\.ativo then\s+new\.desativado_em := null;/);
    expect(SQL).toMatch(/elsif not new\.ativo and old\.ativo then\s+new\.desativado_em := now\(\);/);
  });

  it('só a service role executa a limpeza', () => {
    expect(SQL).toContain('revoke execute on function public.limpar_retencao() from public, anon, authenticated;');
    expect(SQL).toContain('grant execute on function public.limpar_retencao() to service_role;');
  });
});

describe('RETENCAO_ATIVA', () => {
  const env = { WEBHOOK_SEGREDO: SEGREDO, UAZAPI_INSTANCE_TOKEN: TOKEN };
  it('desligada por padrão (apagar não tem volta)', () => {
    expect(lerConfig(env, { exigirBanco: false }).retencaoAtiva).toBe(false);
    expect(lerConfig({ ...env, RETENCAO_ATIVA: 'true' }, { exigirBanco: false }).retencaoAtiva).toBe(true);
  });
});
