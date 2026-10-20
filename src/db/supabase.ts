import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Cliente com a service role: só no servidor. O painel nunca fala direto com o banco.
export function criarClienteSupabase(cfg: { url: string; serviceRoleKey: string }): SupabaseClient {
  return createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
