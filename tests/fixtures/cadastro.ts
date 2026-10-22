// Cadastro em memória para os testes do receptor (sem banco).
import type { Cadastro, Responsavel } from '../../src/cadastro.js';
import type { ChavesConversa } from '../../src/conversas/chave.js';
import { chaveTelefone } from '../../src/grupos/exportar.js';

export const CHAVES: ChavesConversa = { conversa: Buffer.alloc(32, 1), cifra: Buffer.alloc(32, 2) };

export interface OpcoesCadastroFixo {
  ativas?: string[];
  bloqueadas?: string[];
  time?: string[];
  lidsTime?: string[];
  donos?: Record<string, Responsavel>;
}

export function cadastroFixo(o: OpcoesCadastroFixo = {}): Cadastro & { conversas: Map<string, boolean> } {
  const conversas = new Map<string, boolean>([
    ...(o.ativas ?? []).map((j) => [j, true] as const),
    ...(o.bloqueadas ?? []).map((j) => [j, false] as const),
  ]);
  const time = new Set((o.time ?? []).map(chaveTelefone));
  const lids = new Map<string, string>();
  const ehDoTime = (n: string) => time.has(chaveTelefone(n));
  return {
    conversas,
    estado: (jid) => {
      const a = conversas.get(jid);
      return a === undefined ? undefined : a ? 'ativa' : 'inativa';
    },
    ehDoTime,
    ehLidDoTime: (lid) => (o.lidsTime ?? []).includes(lid) || (lids.has(lid) && ehDoTime(lids.get(lid)!)),
    numeroDoLid: (lid) => lids.get(lid),
    aprenderLid: (lid, numero) => void lids.set(lid, chaveTelefone(numero)),
    responsavel: (instancia) => o.donos?.[instancia],
    registrar: (jid, ativo) => void conversas.set(jid, ativo),
  };
}
