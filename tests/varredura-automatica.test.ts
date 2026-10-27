import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { lerConfig } from '../src/config.js';
import { ErroBancoVarredura, varrerInstancia } from '../src/grupos/varredura.js';
import type { ClienteUazapi, Grupo } from '../src/uazapi/cliente.js';
import { SEGREDO, TOKEN } from './fixtures/payloads.js';

// Banco falso: tabelas em memória para select().eq().order().range() e rpc com registro das chamadas.
function dbFalso(tabelas: Record<string, Record<string, unknown>[]>, rpcs: Record<string, unknown> = {}, erroEm?: string) {
  const chamadas: { fn: string; args: Record<string, unknown> }[] = [];
  const inseridos: Record<string, unknown>[] = [];
  const consulta = (tabela: string) => {
    let filtro: [string, unknown] | undefined;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => ((filtro = [c, v]), q),
      order: () => q,
      range: async (de: number, ate: number) => {
        if (erroEm === tabela) return { data: null, error: { code: '42501', message: `linha com segredo ${tabela}` } };
        const linhas = (tabelas[tabela] ?? []).filter((l) => !filtro || l[filtro[0]] === filtro[1]);
        return { data: linhas.slice(de, ate + 1), error: null };
      },
      upsert: async (linha: Record<string, unknown>) => {
        inseridos.push(linha);
        (tabelas.grupos ??= []).push({ ...linha, principal_definido_em: null });
        return { error: null };
      },
      single: async () => ({ data: { ativo: true }, error: null }),
    };
    return q;
  };
  const db = {
    from: (t: string) => {
      const q = consulta(t);
      // gravarConversaSupabase: upsert e depois select('ativo').eq('jid').single()
      return { ...q, select: () => ({ ...q, eq: () => q }) };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      chamadas.push({ fn, args });
      return { data: rpcs[fn] ?? null, error: null };
    },
  } as unknown as SupabaseClient;
  return { db, chamadas, inseridos };
}

const TIME = [
  { nome: 'Roni Ramos', numero: '5515936181722', lid: null, instancia: 'roni_ramos', gestor_padrao: 'Antonio CS', funcao: 'especialista', ativo: true },
  { nome: 'Antonio CS', numero: '554892053515', lid: null, instancia: null, gestor_padrao: null, funcao: 'gestor', ativo: true },
];
const cliente = (jid: string, numero: string): Grupo => ({
  JID: jid,
  Name: 'Grupo',
  Participants: [{ JID: `${numero}@s.whatsapp.net`, PhoneNumber: `${numero}@s.whatsapp.net` } as never],
});

function uazapiFalsa(grupos: Grupo[], status = 'connected') {
  return {
    instanceStatus: async () => ({ status }),
    listarGrupos: async () => ({ groups: grupos, pagination: { hasMore: false } }),
    participantesDoGrupo: async () => [],
  } as unknown as ClienteUazapi;
}

describe('varrerInstancia', () => {
  it('instância sem dono em time.instancia: não faz nada', async () => {
    const { db, chamadas } = dbFalso({ time: TIME });
    const r = await varrerInstancia(db, { nome: 'outra', uazapi: uazapiFalsa([]), gravar: true });
    expect(r).toEqual({ ok: false, motivo: 'sem_dono' });
    expect(chamadas).toEqual([]);
  });

  it('com gravar: cadastra o grupo de cliente novo, ignora o interno e troca a presença', async () => {
    const { db, chamadas, inseridos } = dbFalso({ time: TIME, grupos: [], presencas: [], varreduras: [] }, { substituir_presencas: 2 });
    const r = await varrerInstancia(db, {
      nome: 'roni_ramos',
      uazapi: uazapiFalsa([cliente('1@g.us', '5511988887777'), cliente('2@g.us', '554892053515')]),
      gravar: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contagens.cadastrados).toBe(1);
    expect(r.contagens.classificacao?.internos).toBe(1);
    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]).toMatchObject({ jid: '1@g.us', especialista: 'Roni Ramos', gestor: 'Antonio CS', origem: 'automatico' });
    expect(chamadas.map((c) => c.fn)).toContain('substituir_presencas');
  });

  it('simulação não grava nada', async () => {
    const { db, chamadas, inseridos } = dbFalso({ time: TIME, grupos: [], presencas: [], varreduras: [] });
    const r = await varrerInstancia(db, { nome: 'roni_ramos', uazapi: uazapiFalsa([cliente('1@g.us', '5511988887777')]), gravar: false });
    expect(r.ok && r.contagens.classificacao?.aCadastrar.length).toBe(1);
    expect(inseridos).toEqual([]);
    expect(chamadas).toEqual([]);
  });

  it('instância desconectada: não cadastra nem mexe na presença', async () => {
    const { db, chamadas, inseridos } = dbFalso({ time: TIME, grupos: [], presencas: [], varreduras: [] });
    const r = await varrerInstancia(db, {
      nome: 'roni_ramos',
      uazapi: uazapiFalsa([cliente('1@g.us', '5511988887777')], 'disconnected'),
      gravar: true,
    });
    expect(r.ok && r.contagens.listagem).toEqual({ ok: false, motivo: 'desconectada' });
    expect(inseridos).toEqual([]);
    expect(chamadas.map((c) => c.fn)).not.toContain('substituir_presencas');
  });

  it('erro do banco vira ErroBancoVarredura só com a tabela e o código', async () => {
    const { db } = dbFalso({ time: TIME }, {}, 'time');
    const erro = await varrerInstancia(db, { nome: 'roni_ramos', uazapi: uazapiFalsa([]), gravar: false }).catch((e: Error) => e);
    expect(erro).toBeInstanceOf(ErroBancoVarredura);
    expect((erro as Error).message).toContain('42501');
    expect((erro as Error).message).not.toContain('segredo');
  });
});

describe('VARREDURA_AUTOMATICA', () => {
  const env = { WEBHOOK_SEGREDO: SEGREDO, UAZAPI_INSTANCE_TOKEN: TOKEN };
  it('desligada por padrão; só true liga', () => {
    expect(lerConfig(env, { exigirBanco: false }).varreduraAutomatica).toBe(false);
    expect(lerConfig({ ...env, VARREDURA_AUTOMATICA: 'false' }, { exigirBanco: false }).varreduraAutomatica).toBe(false);
    expect(lerConfig({ ...env, VARREDURA_AUTOMATICA: 'true' }, { exigirBanco: false }).varreduraAutomatica).toBe(true);
    expect(() => lerConfig({ ...env, VARREDURA_AUTOMATICA: 'sim' }, { exigirBanco: false })).toThrow(/VARREDURA_AUTOMATICA/);
  });
});
