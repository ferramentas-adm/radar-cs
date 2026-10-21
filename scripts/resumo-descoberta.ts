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

// Máscara de src/webhook/sanitizar.ts (mascararTexto): "[texto omitido: N caracteres]".
// String vazia também é mascarada, com N = 0.
const MASCARA = /^\[texto omitido: (\d+) caracteres\]$/;

interface ContagemTexto {
  mascarado: number;
  /** Dos mascarados, quantos tinham 0 caracteres no original (o original era vazio). */
  mascaradoDeVazio: number;
  preenchido: number;
  vazio: number;
}

const contagemTexto = (): ContagemTexto => ({ mascarado: 0, mascaradoDeVazio: 0, preenchido: 0, vazio: 0 });

function contarTexto(c: ContagemTexto, v: unknown): void {
  if (typeof v === 'string') {
    const m = MASCARA.exec(v);
    if (m) {
      c.mascarado++;
      if (m[1] === '0') c.mascaradoDeVazio++;
    } else if (v.trim() !== '') c.preenchido++;
    else c.vazio++;
  } else if (v === null || v === undefined) c.vazio++;
  else if (typeof v === 'object' && Object.keys(v).length === 0) c.vazio++;
  else c.preenchido++;
}

function tipoDe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'lista';
  return typeof v === 'object' ? 'objeto' : typeof v;
}

// Por messageType: situação de text e content (máscara x preenchido x vazio), tipo do content,
// nomes das chaves do content quando objeto, e quantos quoted apontam para o messageid de outro
// evento do conjunto. Só contagens e nomes de chave; nunca valores.
function camposPreenchidos(payloads: unknown[]) {
  const msgs: Record<string, unknown>[] = [];
  for (const p of payloads) {
    const raiz = p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : undefined;
    const m = raiz?.message;
    if (m !== null && typeof m === 'object' && !Array.isArray(m)) msgs.push(m as Record<string, unknown>);
  }
  const ids = new Set(msgs.map((m) => m.messageid).filter((v): v is string => typeof v === 'string' && v !== ''));

  const r: Record<
    string,
    {
      eventos: number;
      text: ContagemTexto;
      content: ContagemTexto;
      tipoContent: Record<string, number>;
      chavesContent: Record<string, number>;
      quotedBateComOutroEvento: number;
    }
  > = {};
  for (const msg of msgs) {
    const tipo = String(msg.messageType ?? '(sem messageType)');
    const t = (r[tipo] ??= {
      eventos: 0,
      text: contagemTexto(),
      content: contagemTexto(),
      tipoContent: {},
      chavesContent: {},
      quotedBateComOutroEvento: 0,
    });
    t.eventos++;
    contarTexto(t.text, msg.text);
    contarTexto(t.content, msg.content);
    const tc = tipoDe(msg.content);
    t.tipoContent[tc] = (t.tipoContent[tc] ?? 0) + 1;
    if (tc === 'objeto') {
      for (const c of Object.keys(msg.content as object)) t.chavesContent[c] = (t.chavesContent[c] ?? 0) + 1;
    }
    const q = msg.quoted;
    if (typeof q === 'string' && q !== '' && q !== msg.messageid && ids.has(q)) t.quotedBateComOutroEvento++;
  }
  return r;
}

const i = process.argv.indexOf('--arquivo');
const arquivo = i === -1 ? undefined : process.argv[i + 1];
const payloads = arquivo ? await lerDoArquivo(arquivo) : await lerDoSupabase();
console.log(JSON.stringify({ ...resumirPayloads(payloads), camposPreenchidos: camposPreenchidos(payloads) }, null, 2));
