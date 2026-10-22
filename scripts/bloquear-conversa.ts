// Bloqueia (ativo = false) ou desbloqueia uma conversa. Bloqueada, ela sai da análise e o receptor
// para de gravar mensagens novas dela; o histórico fica. Vale para o receptor na próxima recarga do
// cadastro (até 1 minuto).
// Uso: npm run conversas:bloquear -- --id N                 (simulação: mostra o que faria)
//      npm run conversas:bloquear -- --id N --gravar
//      npm run conversas:bloquear -- --id N --desbloquear --gravar
// O id vem de var/conversas.csv (npm run conversas:exportar). O terminal nunca mostra nome nem número.
import { lerId } from '../src/conversas/listar.js';
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';

let id: number;
try {
  id = lerId(process.argv);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const ativo = process.argv.includes('--desbloquear');
const gravar = process.argv.includes('--gravar');

carregarEnv();
const url = process.env.SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) {
  console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env.');
  process.exit(1);
}
const db = criarClienteSupabase({ url, serviceRoleKey: chave });

const r = await db.from('grupos').select('tipo, ativo').eq('id', id).maybeSingle();
if (r.error) throw new Error(`supabase: ${r.error.message}`);
if (!r.data) {
  console.error(`conversa ${id} não encontrada.`);
  process.exit(1);
}
const atual = r.data as { tipo: string; ativo: boolean };
const sim = (v: boolean) => (v ? 'sim' : 'não');
console.log(`modo: ${gravar ? 'gravação' : 'simulação (nada gravado; use --gravar)'}`);
console.log(`conversa ${id} (${atual.tipo}): ativa ${sim(atual.ativo)} → ${sim(ativo)}`);
if (atual.ativo === ativo) {
  console.log('nada a mudar.');
} else if (gravar) {
  const { error } = await db.from('grupos').update({ ativo }).eq('id', id);
  if (error) throw new Error(`supabase: ${error.message}`);
  console.log('gravado.');
}
