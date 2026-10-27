import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Banco dedicado só ao radar-cs (Supabase Cloud): tudo em "public", sem schema à parte.
export type BancoRadar = SupabaseClient;

// Cliente com a service role: só no servidor. O painel nunca fala direto com o banco.
export function criarClienteSupabase(cfg: { url: string; serviceRoleKey: string }): BancoRadar {
  return createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
