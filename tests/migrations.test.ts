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

  it('time, grupos e mensagens sem policy (só a service role)', () => {
    expect(sql).not.toMatch(/create policy \w+ on public\.(time|grupos|mensagens)\b/i);
  });

  it('mensagens: o banco só aceita o texto mascarado e número só de quem é do time', () => {
    expect(sql).toContain("texto ~ '^\\[texto omitido: [0-9]+ caracteres\\]$'");
    expect(sql).toContain("check (autor_tipo = 'time' or autor_numero is null)");
  });

  it('grupos: privada só com jid opaco, chatid cifrado e sem nome', () => {
    expect(sql).toContain("jid ~ '^privada:[0-9a-f]{64}$'");
    expect(sql).toMatch(/tipo = 'privada'[\s\S]*chat_cifrado is not null[\s\S]*nome is null/);
  });

  it('configuração: escrita só com eh_admin()', () => {
    const escrita = [...sql.matchAll(/create policy \w+ on public\.(\w+)\s+for (insert|update|delete)[^;]*;/gi)];
    expect(escrita.length).toBeGreaterThan(0);
    for (const [politica] of escrita) expect(politica).toContain('public.eh_admin()');
  });
});
