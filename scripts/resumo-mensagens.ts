// Contagem das mensagens gravadas nas últimas 24 horas, por grupo, autor e "conta" (sim/não).
// Uso: npm run mensagens:resumo
// Só contagens: nunca texto, JID, nome de grupo nem número (os grupos aparecem numerados).
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';
import { formatarResumo, resumirMensagens, type LinhaResumo } from '../src/mensagens/resumo.js';

const PAGINA = 1000;

carregarEnv();
const url = process.env.SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) {
  console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env.');
  process.exit(1);
}
const db = criarClienteSupabase({ url, serviceRoleKey: chave });

const grupos = await db.from('grupos').select('jid').eq('ativo', true).order('id');
if (grupos.error) throw new Error(`supabase: ${grupos.error.message}`);

const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
const linhas: LinhaResumo[] = [];
for (let de = 0; ; de += PAGINA) {
  const r = await db
    .from('mensagens')
    .select('jid, autor_tipo, conta')
    .gte('enviada_em', desde)
    .order('id')
    .range(de, de + PAGINA - 1);
  if (r.error) throw new Error(`supabase: ${r.error.message}`);
  linhas.push(...((r.data ?? []) as LinhaResumo[]));
  if ((r.data ?? []).length < PAGINA) break;
}

console.log(`mensagens das últimas 24 horas: ${linhas.length}`);
console.log(formatarResumo(resumirMensagens((grupos.data ?? []).map((g: { jid: string }) => g.jid), linhas)));
