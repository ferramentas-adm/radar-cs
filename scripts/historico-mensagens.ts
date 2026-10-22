// Histórico inicial: carrega da uazapi as mensagens dos últimos N dias das conversas já cadastradas
// que a instância vê (grupos ativos que estão no /group/list dela e privadas ativas dela).
// Uso: npm run mensagens:historico -- --instancia NOME [--dias 7] [--gravar]
// Sem --gravar é simulação: lê a uazapi e o banco e não grava nada. Com --gravar, insere só as
// mensagens novas (messageid repetido é ignorado). Só leitura na uazapi (/group/list, /message/find).
// O terminal só mostra contagens: nunca nome, número, jid, chatid ou texto.
import { carregarDadosRadar } from '../src/api/dados.js';
import { decifrar, lerChave } from '../src/conversas/chave.js';
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';
import { buscarTodosGrupos, chaveTelefone, escolherInstancia } from '../src/grupos/exportar.js';
import {
  buscarHistorico,
  emAlerta,
  formatarContagens,
  lerDias,
  mapaLids,
  motivoFalha,
  paraMotor,
  processarConversa,
  semTimeNaJanela,
  type Contagens,
  type ConversaHistorico,
  type MembroHistorico,
} from '../src/mensagens/historico.js';
import type { MensagemMotor } from '../src/motor/calcular.js';
import { gravarMensagensSupabase, mensagensExistentesSupabase } from '../src/repositorio.js';
import { ClienteUazapi } from '../src/uazapi/cliente.js';

const PAGINA = 1000;
const DIA = 24 * 3600_000;

function sair(msg: string): never {
  console.error(msg);
  process.exit(1);
}

carregarEnv();
const argv = process.argv;
const gravar = argv.includes('--gravar');
if (!argv.includes('--instancia')) sair('Use --instancia NOME (ex.: --instancia roni_ramos).');
let instancia;
let dias;
try {
  instancia = escolherInstancia(argv, process.env);
  dias = lerDias(argv);
} catch (e) {
  sair((e as Error).message);
}
const nome = instancia.variavelToken.slice('UAZAPI_TOKEN_'.length).toLowerCase();

const url = process.env.SUPABASE_URL;
const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chaveDb) sair('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env.');
const cifra = lerChave(process.env.RADAR_CHAVE_CIFRA);
if (!cifra) sair('RADAR_CHAVE_CIFRA precisa estar no .env (Base64 de 32 bytes).');
const db = criarClienteSupabase({ url, serviceRoleKey: chaveDb });

// Time ativo: quem é do time e quem é dono desta instância. fromMe só é time numa instância de pessoa.
const rt = await db.from('time').select('numero, lid, instancia').eq('ativo', true);
if (rt.error) sair('Falha ao ler a tabela time.');
const time = (rt.data ?? []) as (MembroHistorico & { instancia: string | null })[];
if (!time.some((t) => t.instancia === nome)) sair(`A instância ${nome} não tem dono em time.instancia.`);
const chavesTime = new Set(time.map((t) => chaveTelefone(t.numero)).filter((c) => c !== ''));
const ehDoTime = (n: string) => chavesTime.has(chaveTelefone(n));

// Conversas ativas já cadastradas.
const cadastradas: { jid: string; tipo: 'grupo' | 'privada'; instancia: string | null; chat_cifrado: string | null }[] = [];
for (let de = 0; ; de += PAGINA) {
  const r = await db
    .from('grupos')
    .select('jid, tipo, instancia, chat_cifrado')
    .eq('ativo', true)
    .order('id')
    .range(de, de + PAGINA - 1);
  if (r.error) sair('Falha ao ler as conversas.');
  cadastradas.push(...((r.data ?? []) as typeof cadastradas));
  if ((r.data ?? []).length < PAGINA) break;
}

const uazapi = new ClienteUazapi(instancia.baseUrl, instancia.token);
const contagens: Contagens = {
  conversas: 0,
  lidas: 0,
  falhas: new Map(),
  noTeto: 0,
  mensagensLidas: 0,
  novas: 0,
  existentes: 0,
  semData: 0,
  foraDaJanela: 0,
  outraConversa: 0,
  naoIdentificados: 0,
  alertaParaOk: 0,
  okParaAlerta: 0,
  gruposSemTime: 0,
};
const falhou = (motivo: string) => contagens.falhas.set(motivo, (contagens.falhas.get(motivo) ?? 0) + 1);

// Grupos: os cadastrados que esta instância vê. Privadas: as desta instância (o chatid é decifrado
// só em memória).
let doNumero: Set<string>;
try {
  doNumero = new Set((await buscarTodosGrupos(uazapi, undefined, true)).map((g) => g.JID));
} catch (e) {
  sair(`Falha ao listar os grupos da instância (${motivoFalha(e)}).`);
}
const conversas: ConversaHistorico[] = [];
for (const c of cadastradas) {
  if (c.tipo === 'grupo' && doNumero.has(c.jid)) conversas.push({ jid: c.jid, tipo: 'grupo', chatid: c.jid });
  if (c.tipo === 'privada' && c.instancia === nome) {
    try {
      if (!c.chat_cifrado) throw new Error('sem chat_cifrado');
      conversas.push({ jid: c.jid, tipo: 'privada', chatid: decifrar(c.chat_cifrado, cifra) });
    } catch {
      contagens.conversas++; // entra na contagem como falha
      falhou('cifra');
    }
  }
}
contagens.conversas += conversas.length;

// 1) Busca tudo (uma chamada por vez), 2) aprende LIDs com o conjunto, 3) normaliza.
const agora = Date.now();
const desde = agora - dias * DIA;
const brutas = new Map<string, Record<string, unknown>[]>();
for (const c of conversas) {
  try {
    const h = await buscarHistorico(uazapi, c.chatid, desde);
    brutas.set(c.jid, h.mensagens);
    contagens.lidas++;
    if (h.noTeto) contagens.noTeto++;
  } catch (e) {
    falhou(motivoFalha(e));
  }
}
const lids = mapaLids(time, [...brutas.values()].flat());

const porConversa = new Map<string, ReturnType<typeof processarConversa>>();
for (const c of conversas) {
  const b = brutas.get(c.jid);
  if (!b) continue;
  const r = processarConversa(c, b, { instancia: nome, ehDoTime, lids, desde, agora });
  porConversa.set(c.jid, r);
  contagens.mensagensLidas += r.lidas;
  contagens.semData += r.semData;
  contagens.foraDaJanela += r.foraDaJanela;
  contagens.outraConversa += r.outraConversa;
  contagens.naoIdentificados += r.naoIdentificados;
  if (semTimeNaJanela(c, r.validas)) contagens.gruposSemTime++;
}

try {
  const validas = [...porConversa.values()].flatMap((r) => r.validas);
  const existentes = await mensagensExistentesSupabase(db, validas.map((m) => m.id_mensagem));
  const novas = validas.filter((m) => !existentes.has(m.id_mensagem));
  contagens.existentes = validas.length - novas.length;
  contagens.novas = novas.length;

  // Estado antes e depois, pelo motor, com os dados de agora do banco.
  const dados = await carregarDadosRadar(db);
  const novasPorConversa = new Map<string, MensagemMotor[]>();
  for (const m of paraMotor(novas)) novasPorConversa.set(m.id_grupo, [...(novasPorConversa.get(m.id_grupo) ?? []), m]);
  for (const jid of porConversa.keys()) {
    const antes = emAlerta(dados, jid, agora);
    const depois = emAlerta(dados, jid, agora, novasPorConversa.get(jid) ?? []);
    if (antes && !depois) contagens.alertaParaOk++;
    if (!antes && depois) contagens.okParaAlerta++;
  }

  if (gravar) {
    await gravarMensagensSupabase(db, novas);
    contagens.gravadas = novas.length;
  }
} catch (e) {
  // Mensagens fixas (com o code do banco); nada da linha.
  sair(e instanceof Error && e.message.startsWith('falha ao') ? e.message : 'Falha ao ler ou gravar no banco.');
}

console.log(`instância: ${instancia.variavelToken}`);
console.log(formatarContagens(contagens, dias, gravar));
