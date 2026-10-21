// Passo 2: lista os grupos do número conectado (POST /group/list) e grava var/grupos.csv para o CS
// preencher especialista e gestor. Se existir var/time.csv (nome;numero), preenche time_no_grupo.
// Uso: npm run grupos:exportar                       (recusa se var/grupos.csv já existir)
//      npm run grupos:exportar -- --sobrescrever
// O CSV tem nomes de clientes e números: fica em var/ (no .gitignore). O terminal só mostra contagens.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lerConfig } from '../src/config.js';
import { carregarEnv } from '../src/env.js';
import { buscarTodosGrupos, gerarCsv, lerTimeCsv, montarLinhas, resumo } from '../src/grupos/exportar.js';
import { ClienteUazapi } from '../src/uazapi/cliente.js';

const PASTA = join(import.meta.dirname, '..', 'var');
const SAIDA = join(PASTA, 'grupos.csv');
const TIME = join(PASTA, 'time.csv');

if (existsSync(SAIDA) && !process.argv.includes('--sobrescrever')) {
  console.error('var/grupos.csv já existe (pode ter especialista e gestor preenchidos).');
  console.error('Para gerar de novo por cima: npm run grupos:exportar -- --sobrescrever');
  process.exit(1);
}

carregarEnv();
const cfg = lerConfig(process.env, { exigirBanco: false });
if (!cfg.uazapiBaseUrl) {
  console.error('Falta UAZAPI_BASE_URL no .env.');
  process.exit(1);
}

const temTime = existsSync(TIME);
const time = temTime ? lerTimeCsv(await readFile(TIME, 'utf8')) : [];

const uazapi = new ClienteUazapi(cfg.uazapiBaseUrl, cfg.uazapiToken);
const linhas = montarLinhas(await buscarTodosGrupos(uazapi), time);

await mkdir(PASTA, { recursive: true });
await writeFile(SAIDA, gerarCsv(linhas), 'utf8');
console.log(resumo(linhas, temTime));
console.log('gravado em var/grupos.csv');
