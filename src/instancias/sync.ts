// Estado de sincronização por instância (radar.sync_estado): até onde a reconciliação já leu e o
// último status visto. Sobrevive a reinício do backend.
import type { BancoRadar } from '../db/supabase.js';

export interface SyncEstado {
  ultima_mensagem_em: number | null; // epoch ms
  ultimo_status: string | null;
}

const codigoErro = (erro: { code?: string }) => (typeof erro.code === 'string' && erro.code !== '' ? erro.code : 'desconhecido');

/** undefined = instância ainda sem linha (primeira vez). */
export async function lerSyncEstado(db: BancoRadar, instancia: string): Promise<SyncEstado | undefined> {
  const r = await db
    .from('sync_estado')
    .select('ultima_mensagem_em, ultimo_status')
    .eq('instancia', instancia)
    .maybeSingle();
  if (r.error) throw new Error(`falha ao ler sync_estado (código ${codigoErro(r.error)})`);
  if (!r.data) return undefined;
  const d = r.data as { ultima_mensagem_em: string | null; ultimo_status: string | null };
  return { ultima_mensagem_em: d.ultima_mensagem_em ? Date.parse(d.ultima_mensagem_em) : null, ultimo_status: d.ultimo_status };
}

/** Só avança: nunca grava uma data mais antiga que a já guardada. */
export async function registrarUltimaMensagem(db: BancoRadar, instancia: string, quando: number): Promise<void> {
  const atual = await lerSyncEstado(db, instancia);
  if (atual?.ultima_mensagem_em !== null && atual?.ultima_mensagem_em !== undefined && atual.ultima_mensagem_em >= quando) return;
  const { error } = await db
    .from('sync_estado')
    .upsert(
      { instancia, ultima_mensagem_em: new Date(quando).toISOString(), atualizado_em: new Date().toISOString() },
      { onConflict: 'instancia' },
    );
  if (error) throw new Error(`falha ao gravar sync_estado (código ${codigoErro(error)})`);
}

export async function registrarStatus(db: BancoRadar, instancia: string, status: string): Promise<void> {
  const { error } = await db
    .from('sync_estado')
    .upsert({ instancia, ultimo_status: status, atualizado_em: new Date().toISOString() }, { onConflict: 'instancia' });
  if (error) throw new Error(`falha ao gravar sync_estado (código ${codigoErro(error)})`);
}
