// Aponta o webhook da instância observadora para o receptor do Radar.
// Uso: npm run webhook:configurar   (precisa de UAZAPI_BASE_URL, UAZAPI_INSTANCE_TOKEN,
// WEBHOOK_URL_PUBLICA e WEBHOOK_SEGREDO no .env). Nunca imprime o token nem o segredo.
import { lerConfig } from '../src/config.js';
import { carregarEnv } from '../src/env.js';
import { ClienteUazapi } from '../src/uazapi/cliente.js';
import { PREFIXO_WEBHOOK } from '../src/webhook/rota.js';

carregarEnv();
const cfg = lerConfig(process.env, { exigirBanco: false });
if (!cfg.uazapiBaseUrl || !cfg.webhookUrlPublica) {
  console.error('Faltam UAZAPI_BASE_URL e/ou WEBHOOK_URL_PUBLICA no .env.');
  process.exit(1);
}

const uazapi = new ClienteUazapi(cfg.uazapiBaseUrl, cfg.uazapiToken);
const { status } = await uazapi.instanceStatus();
console.log(`instância: ${status}`);

await uazapi.configurarWebhook({
  url: `${cfg.webhookUrlPublica}${PREFIXO_WEBHOOK}${cfg.webhookSegredo}`,
  events: ['messages', 'connection'],
  excludeMessages: ['isGroupNo'], // ignora conversas privadas
});
console.log(`webhook configurado: ${cfg.webhookUrlPublica}${PREFIXO_WEBHOOK}***`);
