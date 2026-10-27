// Gravação das promessas detectadas (tabela promessas, migration 20261031120000). Insert sem
// sobrescrever: a mesma mensagem vista por duas instâncias não duplica a promessa.
// Erros só com o código (a mensagem do PostgREST pode trazer a linha).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PromessaDetectada } from './detector.js';

const codigo = (erro: { code?: string }) => (typeof erro.code === 'string' && erro.code !== '' ? erro.code : 'desconhecido');

export type GravarPromessas = (jid: string, feitaEm: number, lista: PromessaDetectada[]) => Promise<void>;

/** Uma linha por promessa; a segunda da mesma mensagem em diante ganha "#2", "#3"... no id de origem. */
export function linhasPromessas(jid: string, feitaEm: number, lista: PromessaDetectada[]) {
  return lista.map((p, i) => ({
    jid,
    promessa: p.promessa,
    prazo: new Date(p.prazo).toISOString(),
    feita_em: new Date(feitaEm).toISOString(),
    id_mensagem_origem: i === 0 ? p.id_mensagem : `${p.id_mensagem}#${i + 1}`,
  }));
}

export function gravarPromessasSupabase(db: SupabaseClient): GravarPromessas {
  return async (jid, feitaEm, lista) => {
    if (lista.length === 0) return;
    const { error } = await db
      .from('promessas')
      .upsert(linhasPromessas(jid, feitaEm, lista), { onConflict: 'id_mensagem_origem', ignoreDuplicates: true });
    if (error) throw new Error(`supabase (promessas): código ${codigo(error)}`);
  };
}

/** Marca como cumpridas as promessas com mensagem do time depois delas (histórico). */
export async function cumprirPromessas(db: SupabaseClient): Promise<number> {
  const r = await db.rpc('cumprir_promessas');
  if (r.error) throw new Error(`supabase (cumprir_promessas): código ${codigo(r.error)}`);
  return Number(r.data);
}
