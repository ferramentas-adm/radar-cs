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

  it('presença, varreduras e histórico: sem acesso para anon e authenticated e sem policy', () => {
    for (const t of ['presencas', 'varreduras', 'responsaveis_historico']) {
      expect(sql, t).toMatch(new RegExp(`revoke all on table public\\.${t} from anon, authenticated;`, 'i'));
      expect(sql, t).not.toMatch(new RegExp(`create policy \\w+ on public\\.${t}\\b`, 'i'));
    }
  });

  it('funcao do time só com os três valores; grupos importados nascem definidos por pessoa', () => {
    expect(sql).toContain("check (funcao in ('especialista', 'gestor', 'observador'))");
    expect(sql).toContain("update public.grupos set principal_definido_em = now() where origem = 'importado';");
  });

  describe('funções rpc (troca de presença e de responsável)', () => {
    const funcoes = [...sql.matchAll(/create (?:or replace )?function public\.(\w+)\(([^)]*)\)([\s\S]*?)\$\$;/gi)];
    const rpc = funcoes.filter((f) => ['substituir_presencas', 'trocar_responsavel'].includes(f[1]!));

    it('existem as duas', () => {
      expect(rpc.map((f) => f[1])).toEqual(['substituir_presencas', 'trocar_responsavel']);
    });

    it('toda função tem search_path fixo', () => {
      expect(funcoes.length).toBeGreaterThan(rpc.length);
      for (const [, nome, , corpo] of funcoes) expect(corpo, nome).toMatch(/set search_path = ''/);
    });

    it('execute só para service_role (revoke de public, anon e authenticated)', () => {
      for (const [, nome] of rpc) {
        expect(sql, nome).toMatch(
          new RegExp(`revoke execute on function public\\.${nome}\\([^)]*\\)\\s+from public, anon, authenticated;`, 'i'),
        );
        const grants = [...sql.matchAll(new RegExp(`grant execute on function public\\.${nome}\\([^)]*\\) to (\\w+);`, 'gi'))];
        expect(grants.map((g) => g[1]), nome).toEqual(['service_role']);
      }
    });

    it('não são security definer (rodam com o papel de quem chama)', () => {
      for (const [, nome, , corpo] of rpc) expect(corpo, nome).toContain('security invoker');
    });

    const corpo = (nome: string) => rpc.find((f) => f[1] === nome)![3]!;

    it('substituir_presencas: parâmetro nulo ou listados negativo levanta 22023 antes de apagar', () => {
      const c = corpo('substituir_presencas');
      const checagem = c.search(
        /if p_instancia is null or p_jids is null or p_concluida_em is null\s+or p_listados is null or p_listados < 0 then\s+raise exception '[^']+' using errcode = '22023';/,
      );
      expect(checagem).toBeGreaterThan(-1);
      expect(checagem).toBeLessThan(c.indexOf('delete from public.presencas'));
    });

    it('trocar_responsavel: pessoa com o especialista atual trava o grupo, grava histórico e devolve true', () => {
      const c = corpo('trocar_responsavel');
      const ramo = c.match(/if p_motivo = 'pessoa' and atual\.especialista is not distinct from p_especialista then([\s\S]*?)end if;/);
      expect(ramo).not.toBeNull();
      expect(ramo![1]).toContain('set principal_definido_em = now()');
      expect(ramo![1]).toContain('insert into public.responsaveis_historico');
      expect(ramo![1]).toContain('return true;');
      // vem antes da conferência do esperado (que devolve false)
      expect(c.indexOf(ramo![0])).toBeLessThan(c.indexOf('if atual.especialista is distinct from p_esperado'));
    });

    it("as duas só tratam grupo (tipo = 'grupo', o valor da migration de conversas)", () => {
      expect(sql).toContain("check (tipo in ('grupo', 'privada'))");
      expect(corpo('substituir_presencas')).toContain("g.tipo = 'grupo'");
      expect(corpo('trocar_responsavel')).toContain("tipo = 'grupo'");
    });
  });

  it('configuração: escrita só com eh_admin()', () => {
    const escrita = [...sql.matchAll(/create policy \w+ on public\.(\w+)\s+for (insert|update|delete)[^;]*;/gi)];
    expect(escrita.length).toBeGreaterThan(0);
    for (const [politica] of escrita) expect(politica).toContain('public.eh_admin()');
  });
});
