// Passo 2: lista os grupos do número conectado (POST /group/list) e grava var/grupos.csv para o CS
// preencher especialista e gestor. Se existir var/time.csv (nome;numero), preenche time_no_grupo.
// Uso: npm run grupos:exportar                          (UAZAPI_INSTANCE_TOKEN → var/grupos.csv)
//      npm run grupos:exportar -- --instancia ana       (UAZAPI_TOKEN_ANA → var/grupos-ana.csv)
//      ... -- --sobrescrever                            (recusa se o arquivo de saída já existir)
// O CSV tem nomes de clientes e números: fica em var/ (no .gitignore). O terminal só mostra contagens.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { carregarEnv } from '../src/env.js';
import {
  buscarTodosGrupos,
  escolherInstancia,
  gerarCsv,
  lerTimeCsv,
  montarLinhas,
  resumo,
} from '../src/grupos/exportar.js';
import { ClienteUazapi } from '../src/uazapi/cliente.js';

const PASTA = join(import.meta.dirname, '..', 'var');
const TIME = join(PASTA, 'time.csv');

carregarEnv();
let instancia;
try {
  instancia = escolherInstancia(process.argv, process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const saida = join(PASTA, instancia.arquivo);

if (existsSync(saida) && !process.argv.includes('--sobrescrever')) {
  console.error(`var/${instancia.arquivo} já existe (pode ter especialista e gestor preenchidos).`);
  console.error('Para gerar de novo por cima, acrescente: -- --sobrescrever');
  process.exit(1);
}

const temTime = existsSync(TIME);
const time = temTime ? lerTimeCsv(await readFile(TIME, 'utf8')) : [];

const uazapi = new ClienteUazapi(instancia.baseUrl, instancia.token);
const linhas = montarLinhas(await buscarTodosGrupos(uazapi), time);

await mkdir(PASTA, { recursive: true });
await writeFile(saida, gerarCsv(linhas), 'utf8');
console.log(`instância: ${instancia.variavelToken}`);
console.log(resumo(linhas, temTime));
console.log(`gravado em var/${instancia.arquivo}`);
