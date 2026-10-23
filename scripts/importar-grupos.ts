// Passo 2b: importa o CSV de grupos preenchido pelo CS para a tabela grupos (upsert por jid).
// Uso: npm run grupos:importar -- --arquivo var/grupos-roni_ramos.csv --instancia roni_ramos
//        [--entrou-em AAAA-MM-DD] [--gravar]
// Sem --gravar é simulação: lê o banco e não grava nada. --entrou-em vale só para grupo novo
// (meia-noite em America/Sao_Paulo); sem ele, grupo novo recebe a data e hora de agora.
// Importar marca o especialista como definido por pessoa (principal_definido_em): a varredura não
// troca mais sozinha esses grupos.
// O terminal só mostra contagens e erros por número de linha (nunca nomes, JIDs ou telefones).
import { readFile } from 'node:fs/promises';
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';
import { NOME_INSTANCIA } from '../src/grupos/exportar.js';
import { entrouEmParaIso, planejarGrupos, type GrupoBanco } from '../src/importar/grupos.js';

const LOTE = 100; // jids por consulta ao banco

function opcao(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) sair(`${nome} precisa de um valor.`);
  return v;
}

function sair(mensagem: string): never {
  console.error(mensagem);
  process.exit(1);
}

const gravar = process.argv.includes('--gravar');
const arquivo = opcao('--arquivo') ?? sair('Use --arquivo var/grupos-NOME.csv.');
const instancia = (opcao('--instancia') ?? sair('Use --instancia NOME.')).toLowerCase();
if (!NOME_INSTANCIA.test(instancia)) sair('O nome da instância só pode ter letras sem acento, números e _.');

const agora = new Date();
const dataEntrada = opcao('--entrou-em');
let entrouEm = agora.toISOString();
if (dataEntrada !== undefined) {
  try {
    entrouEm = entrouEmParaIso(dataEntrada, agora);
  } catch (e) {
    sair((e as Error).message);
  }
}

let texto: string;
try {
  texto = await readFile(arquivo, 'utf8');
} catch {
  sair('Arquivo não encontrado (confira o caminho em --arquivo).');
}

carregarEnv();
const url = process.env.SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) sair('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env.');
const db = criarClienteSupabase({ url, serviceRoleKey: chave });

const time = await db.from('time').select('nome').eq('ativo', true);
if (time.error) throw new Error(`supabase: ${time.error.message}`);

// Só os grupos do arquivo, em lotes (os jids vão na URL da consulta).
const jids = [...new Set(texto.match(/[0-9A-Za-z.-]+@g\.us/g) ?? [])];
const existentes: GrupoBanco[] = [];
for (let i = 0; i < jids.length; i += LOTE) {
  const r = await db
    .from('grupos')
    .select('jid, nome, especialista, gestor, instancia, observador_entrou_em, principal_definido_em')
    .in('jid', jids.slice(i, i + LOTE));
  if (r.error) throw new Error(`supabase: ${r.error.message}`);
  existentes.push(...((r.data ?? []) as GrupoBanco[]));
}

const plano = planejarGrupos({
  texto,
  time: (time.data ?? []).map((t: { nome: string }) => t.nome),
  existentes,
  instancia,
  entrouEm,
  entrouEmInformado: dataEntrada !== undefined,
  definidoEm: agora.toISOString(),
});

console.log(`modo: ${gravar ? 'gravação' : 'simulação (nada gravado; use --gravar)'}`);
console.log(
  `novos: ${plano.novos} · atualizados: ${plano.atualizados} · sem mudança: ${plano.semMudanca} · ` +
    `ignorados (sem especialista ou gestor): ${plano.ignorados} · com erro: ${plano.erros.length}`,
);
if (plano.entrouEmIgnorado > 0) {
  console.log(`--entrou-em ignorado em ${plano.entrouEmIgnorado} grupo(s) que já existia(m)`);
}
for (const e of plano.erros) console.log(`  ${e}`);

if (gravar && plano.gravar.length > 0) {
  const { error } = await db.from('grupos').upsert(plano.gravar, { onConflict: 'jid' });
  if (error) throw new Error(`supabase: ${error.message}`);
  console.log(`gravados: ${plano.gravar.length}`);
}
