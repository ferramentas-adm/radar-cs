// Passo 2b: importa var/time.csv (nome;numero, e opcionais instancia;gestor;funcao) para a tabela time.
// instancia = nome da instância uazapi do número corporativo da pessoa (como em RADAR_INSTANCIAS);
// gestor = gestor padrão das conversas que essa instância cadastrar sozinha;
// funcao = especialista, gestor ou observador (só especialista conta para decidir o dono de um grupo).
// Uso: npm run time:importar               (simulação: lê o banco, não grava)
//      npm run time:importar -- --gravar
// O terminal só mostra contagens e erros por número de linha (nunca nomes nem telefones).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';
import { planejarTime, type MembroTimeBanco } from '../src/importar/time.js';

const ARQUIVO = join(import.meta.dirname, '..', 'var', 'time.csv');
const gravar = process.argv.includes('--gravar');

carregarEnv();
const url = process.env.SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) {
  console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env.');
  process.exit(1);
}
const db = criarClienteSupabase({ url, serviceRoleKey: chave });

let texto: string;
try {
  texto = await readFile(ARQUIVO, 'utf8');
} catch {
  console.error('var/time.csv não encontrado.');
  process.exit(1);
}

const { data, error } = await db.from('time').select('nome, numero, instancia, gestor_padrao, funcao');
if (error) throw new Error(`supabase: ${error.message}`);
const plano = planejarTime(texto, (data ?? []) as MembroTimeBanco[]);

console.log(`modo: ${gravar ? 'gravação' : 'simulação (nada gravado; use --gravar)'}`);
console.log(
  `novos: ${plano.novos} · atualizados: ${plano.atualizados} · sem mudança: ${plano.semMudanca} · ` +
    `com erro: ${plano.erros.length}`,
);
console.log(`com função especialista (no arquivo): ${plano.especialistas}`);
for (const e of plano.erros) console.log(`  ${e}`);

if (gravar && plano.gravar.length > 0) {
  const { error: erroGravar } = await db.from('time').upsert(plano.gravar, { onConflict: 'nome' });
  if (erroGravar) throw new Error(`supabase: ${erroGravar.message}`);
  console.log(`gravados: ${plano.gravar.length}`);
}
