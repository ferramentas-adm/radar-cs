// Define à mão o especialista principal de um grupo e marca como definido por pessoa (a varredura
// não troca mais sozinha). Também confirma uma troca sugerida pela varredura. Grava o histórico.
// Uso: npm run conversas:definir-principal -- --id N --especialista "NOME" [--gravar]
// O id vem de var/conversas.csv (npm run conversas:exportar). Sem --gravar é simulação.
// O terminal mostra o id e nomes do time; nunca nome do grupo, jid ou número.
import { lerId } from '../src/conversas/listar.js';
import { formatarPrincipal, lerEspecialista, planejarPrincipal, type GrupoPrincipal } from '../src/conversas/principal.js';
import type { MembroResponsavel } from '../src/conversas/responsavel.js';
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';

function sair(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const falhaBanco = (onde: string, erro: { code?: string } | null) => {
  if (erro) sair(`Falha no banco (${onde}, código ${erro.code || 'desconhecido'}).`);
};

const argv = process.argv;
const gravar = argv.includes('--gravar');
let id: number;
let especialista: string;
try {
  id = lerId(argv);
  especialista = lerEspecialista(argv);
} catch (e) {
  sair((e as Error).message);
}

carregarEnv();
const url = process.env.SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) sair('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env.');
const db = criarClienteSupabase({ url, serviceRoleKey: chave });

const g = await db
  .from('grupos')
  .select('id, jid, tipo, especialista, gestor, instancia, principal_definido_em')
  .eq('id', id)
  .maybeSingle();
falhaBanco('grupos', g.error);
const grupo = (g.data ?? undefined) as GrupoPrincipal | undefined;

const t = await db.from('time').select('nome, instancia, gestor_padrao, funcao').eq('ativo', true);
falhaBanco('time', t.error);

let presentes: string[] = [];
if (grupo) {
  const p = await db.from('presencas').select('instancia').eq('jid', grupo.jid);
  falhaBanco('presencas', p.error);
  presentes = ((p.data ?? []) as { instancia: string }[]).map((x) => x.instancia);
}

const plano = planejarPrincipal(grupo, especialista, (t.data ?? []) as MembroResponsavel[], presentes);
console.log(formatarPrincipal(id, plano, gravar));
if (plano.tipo === 'erro') process.exit(1);

if (gravar && plano.tipo === 'mudanca' && grupo) {
  const r = await db.rpc('trocar_responsavel', {
    p_jid: grupo.jid,
    p_esperado: grupo.especialista,
    p_especialista: plano.para.especialista,
    p_gestor: plano.para.gestor,
    p_instancia: plano.para.instancia,
    p_motivo: 'pessoa',
  });
  falhaBanco('trocar_responsavel', r.error);
  if (r.data !== true) sair('O responsável mudou enquanto o comando rodava; nada gravado. Rode de novo.');
  console.log(plano.soConfirma ? 'gravado: grupo travado no responsável atual (com histórico)' : 'gravado (com histórico)');
}
