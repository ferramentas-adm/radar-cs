// Varredura por instância (fase C2): cadastra os grupos de cliente do número (inclusive os parados),
// grava quais grupos a instância vê (presença) e aplica a regra do especialista responsável.
// Uso: npm run grupos:varrer -- --instancia NOME [--gravar]
// Sem --gravar é simulação: lê a uazapi e o banco e não grava nada. Com --gravar, nesta ordem:
// cadastro dos grupos novos, presença da instância, regra do responsável (trocas automáticas).
// Só leitura na uazapi (/instance/status, /group/list, /group/info).
// O terminal só mostra contagens e nomes de instância: nunca nome de grupo, número, jid ou texto.
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';
import { chaveTelefone, escolherInstancia } from '../src/grupos/exportar.js';
import { formatarVarredura } from '../src/grupos/varrer.js';
import { ErroBancoVarredura, varrerInstancia } from '../src/grupos/varredura.js';
import { ClienteUazapi } from '../src/uazapi/cliente.js';

function sair(msg: string): never {
  console.error(msg);
  process.exit(1);
}

carregarEnv();
const argv = process.argv;
const gravar = argv.includes('--gravar');
if (!argv.includes('--instancia')) sair('Use --instancia NOME (ex.: --instancia roni_ramos).');
let instancia;
try {
  instancia = escolherInstancia(argv, process.env);
} catch (e) {
  sair((e as Error).message);
}
const nome = instancia.variavelToken.slice('UAZAPI_TOKEN_'.length).toLowerCase();

const url = process.env.SUPABASE_URL;
const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chaveDb) sair('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env.');
const db = criarClienteSupabase({ url, serviceRoleKey: chaveDb });
const observador = process.env.OBSERVADOR_NUMERO?.trim() ? chaveTelefone(process.env.OBSERVADOR_NUMERO) : undefined;

let r;
try {
  r = await varrerInstancia(db, { nome, uazapi: new ClienteUazapi(instancia.baseUrl, instancia.token), gravar, observador });
} catch (e) {
  if (e instanceof ErroBancoVarredura) sair(e.message);
  throw e;
}
if (!r.ok) sair(`A instância ${nome} não tem dono em time.instancia.`);

console.log(`instância: ${instancia.variavelToken}`);
console.log(formatarVarredura(r.contagens, gravar));
