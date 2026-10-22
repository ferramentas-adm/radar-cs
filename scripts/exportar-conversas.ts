// Grava var/conversas.csv com todas as conversas do Radar (grupos e privadas) para o CS revisar e
// escolher quais bloquear (npm run conversas:bloquear). Só leitura no banco.
// Uso: npm run conversas:exportar
// O CSV tem nomes de grupos de clientes: fica em var/ (no .gitignore). Não tem JID nem número; a
// privada aparece sem nome. O terminal só mostra contagens.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gerarCsvConversas, resumoConversas, type ConversaBanco } from '../src/conversas/listar.js';
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';

const PASTA = join(import.meta.dirname, '..', 'var');
const PAGINA = 1000;

carregarEnv();
const url = process.env.SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) {
  console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env.');
  process.exit(1);
}
const db = criarClienteSupabase({ url, serviceRoleKey: chave });

const conversas: ConversaBanco[] = [];
for (let de = 0; ; de += PAGINA) {
  const r = await db
    .from('grupos')
    .select('id, tipo, nome, especialista, gestor, instancia, origem, ativo')
    .order('id')
    .range(de, de + PAGINA - 1);
  if (r.error) throw new Error(`supabase: ${r.error.message}`);
  conversas.push(...((r.data ?? []) as ConversaBanco[]));
  if ((r.data ?? []).length < PAGINA) break;
}

await mkdir(PASTA, { recursive: true });
await writeFile(join(PASTA, 'conversas.csv'), gerarCsvConversas(conversas), 'utf8');
console.log(resumoConversas(conversas));
console.log('gravado em var/conversas.csv');
