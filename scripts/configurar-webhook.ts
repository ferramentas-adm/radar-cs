// Aponta o webhook de uma instância para o receptor do Radar.
// Uso: npm run webhook:configurar                        (UAZAPI_INSTANCE_TOKEN, o observador)
//      npm run webhook:configurar -- --instancia ana     (UAZAPI_TOKEN_ANA)
// Precisa de UAZAPI_BASE_URL, WEBHOOK_URL_PUBLICA e WEBHOOK_SEGREDO no .env. A URL é a mesma para
// todas as instâncias: o receptor identifica a instância pelo token. Nunca imprime token nem segredo.
import { carregarEnv } from '../src/env.js';
import { escolherInstancia } from '../src/grupos/exportar.js';
import { ClienteUazapi } from '../src/uazapi/cliente.js';
import { PREFIXO_WEBHOOK } from '../src/webhook/rota.js';

carregarEnv();
let instancia;
try {
  instancia = escolherInstancia(process.argv, process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const urlPublica = process.env.WEBHOOK_URL_PUBLICA?.trim().replace(/\/+$/, '');
const segredo = process.env.WEBHOOK_SEGREDO?.trim();
if (!urlPublica || !URL.canParse(urlPublica)) {
  console.error('Falta WEBHOOK_URL_PUBLICA (uma URL) no .env.');
  process.exit(1);
}
if (!segredo || segredo.length < 32) {
  console.error('Falta WEBHOOK_SEGREDO (pelo menos 32 caracteres) no .env.');
  process.exit(1);
}

const uazapi = new ClienteUazapi(instancia.baseUrl, instancia.token);
const { status } = await uazapi.instanceStatus();
console.log(`instância: ${instancia.variavelToken} (${status})`);

await uazapi.configurarWebhook({
  url: `${urlPublica}${PREFIXO_WEBHOOK}${segredo}`,
  events: ['messages', 'connection'],
  excludeMessages: ['isGroupNo'], // ignora conversas privadas
});
console.log(`webhook configurado: ${urlPublica}${PREFIXO_WEBHOOK}***`);
