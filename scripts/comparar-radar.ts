// Compara o carregamento novo do GET /api/radar (public.radar_dados(), uma consulta só) com o
// antigo (2 ou 3 consultas por conversa) no banco real. Só leitura: não grava nada, não fala com a
// uazapi. Uso: npm run radar:comparar
// O terminal só mostra contagens e tempos; nunca nome, número, jid ou texto. Sai com código 1 se
// houver diferença.
import { carregarDadosRadarLegado } from '../src/api/dados-legado.js';
import { carregarDadosRadar } from '../src/api/dados.js';
import { compararDadosRadar } from '../src/api/comparar.js';
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';

function sair(msg: string): never {
  console.error(msg);
  process.exit(1);
}

carregarEnv();
const url = process.env.SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) sair('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env.');
const db = criarClienteSupabase({ url, serviceRoleKey: chave });

// Mensagens que chegarem entre as duas leituras dão diferença falsa: rodar de novo se acontecer.
let t0 = Date.now();
let novo;
try {
  novo = await carregarDadosRadar(db);
} catch {
  sair('Falha ao chamar public.radar_dados() (a migration 20261025120000_radar_dados.sql foi aplicada?).');
}
const msNovo = Date.now() - t0;
t0 = Date.now();
let legado;
try {
  legado = await carregarDadosRadarLegado(db);
} catch {
  sair('Falha no carregamento antigo.');
}
const msLegado = Date.now() - t0;

const r = compararDadosRadar(legado, novo, Date.now());
console.log(
  [
    `conversas ativas: ${r.grupos} grupos, ${r.privadas} privadas`,
    `mensagens carregadas: ${r.mensagens}`,
    `alertas: ${r.alertas} (sem resposta ${r.semResposta}, sem contato ${r.semContato})`,
    `pilha de mensagens: ${r.pendentes} grupos`,
    `aguardando definição: ${r.definicoes} grupos (instâncias sem varredura recente: ${r.semVarredura})`,
    `tempo: antigo ${msLegado} ms, novo ${msNovo} ms`,
    `diferenças = ${r.diferencas}`,
  ].join('\n'),
);
if (r.diferencas > 0) process.exit(1);
