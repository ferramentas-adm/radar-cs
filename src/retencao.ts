// Retenção (LGPD, regra 6): apaga as mensagens das conversas bloqueadas há mais de 90 dias e os
// eventos brutos com mais de 90 dias (função public.limpar_retencao, migration 20261030120000).
// Apagar não tem volta: o serviço só roda isto com RETENCAO_ATIVA=true. Devolve só contagens.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResultadoRetencao {
  mensagens: number;
  eventos_brutos: number;
}

export async function limparRetencao(db: SupabaseClient): Promise<ResultadoRetencao> {
  const r = await db.rpc('limpar_retencao');
  if (r.error) {
    const codigo = typeof r.error.code === 'string' && r.error.code !== '' ? r.error.code : 'desconhecido';
    throw new Error(`supabase (limpar_retencao): código ${codigo}`);
  }
  const d = (r.data ?? {}) as Partial<ResultadoRetencao>;
  return { mensagens: Number(d.mensagens ?? 0), eventos_brutos: Number(d.eventos_brutos ?? 0) };
}
