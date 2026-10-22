import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// RLS ligado em tudo (CLAUDE.md): toda tabela criada numa migration liga o RLS.
const PASTA = join(import.meta.dirname, '..', 'supabase', 'migrations');
const sql = readdirSync(PASTA)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(PASTA, f), 'utf8'))
  .join('\n');

describe('migrations', () => {
  const tabelas = [...sql.matchAll(/create table public\.(\w+)/gi)].map((m) => m[1]!);

  it('toda tabela liga o RLS', () => {
    expect(tabelas.length).toBeGreaterThan(0);
    for (const t of tabelas) {
      expect(sql, t).toMatch(new RegExp(`alter table public\\.${t} enable row level security`, 'i'));
    }
  });

  it('time e grupos sem policy (só a service role)', () => {
    expect(sql).not.toMatch(/create policy \w+ on public\.(time|grupos)\b/i);
  });

  it('configuração: escrita só com eh_admin()', () => {
    const escrita = [...sql.matchAll(/create policy \w+ on public\.(\w+)\s+for (insert|update|delete)[^;]*;/gi)];
    expect(escrita.length).toBeGreaterThan(0);
    for (const [politica] of escrita) expect(politica).toContain('public.eh_admin()');
  });
});
