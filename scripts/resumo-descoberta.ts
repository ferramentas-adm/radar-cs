// Resume eventos_brutos para responder às dúvidas do passo 1 (sender número x LID, messageType).
// Uso:
//   npm run descoberta:resumo                       (lê do Supabase, últimos 2000 eventos)
//   npm run descoberta:resumo -- --arquivo var/eventos-dev.jsonl
// Mostra só estrutura: nada de texto, números de telefone ou IDs.
import { readFile } from 'node:fs/promises';
import { criarClienteSupabase } from '../src/db/supabase.js';
import { resumirPayloads } from '../src/descoberta.js';
import { carregarEnv } from '../src/env.js';

async function lerDoArquivo(caminho: string): Promise<unknown[]> {
  const linhas = (await readFile(caminho, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  return linhas.map((l) => (JSON.parse(l) as { payload: unknown }).payload);
}

async function lerDoSupabase(): Promise<unknown[]> {
  carregarEnv();
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env');
  const db = criarClienteSupabase({ url, serviceRoleKey: chave });
  const { data, error } = await db
    .from('eventos_brutos')
    .select('payload')
    .order('recebido_em', { ascending: false })
    .limit(2000);
  if (error) throw new Error(`supabase: ${error.message}`);
  return (data ?? []).map((l: { payload: unknown }) => l.payload);
}

const i = process.argv.indexOf('--arquivo');
const arquivo = i === -1 ? undefined : process.argv[i + 1];
const payloads = arquivo ? await lerDoArquivo(arquivo) : await lerDoSupabase();
console.log(JSON.stringify(resumirPayloads(payloads), null, 2));
