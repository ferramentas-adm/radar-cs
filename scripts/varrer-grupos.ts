// Varredura por instância (fase C2): cadastra os grupos de cliente do número (inclusive os parados),
// grava quais grupos a instância vê (presença) e aplica a regra do especialista responsável.
// Uso: npm run grupos:varrer -- --instancia NOME [--gravar]
// Sem --gravar é simulação: lê a uazapi e o banco e não grava nada. Com --gravar, nesta ordem:
// cadastro dos grupos novos, presença da instância, regra do responsável (trocas automáticas).
// Só leitura na uazapi (/instance/status, /group/list, /group/info).
// O terminal só mostra contagens e nomes de instância: nunca nome de grupo, número, jid ou texto.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErroCadastroConversa } from '../src/conversas/cadastrador.js';
import { planejarResponsaveis, type GrupoResponsavel, type MembroResponsavel } from '../src/conversas/responsavel.js';
import { criarClienteSupabase } from '../src/db/supabase.js';
import { carregarEnv } from '../src/env.js';
import { chaveTelefone, escolherInstancia } from '../src/grupos/exportar.js';
import {
  classificarListados,
  formatarVarredura,
  listarComSeguranca,
  novaConversaDeGrupo,
  simularPresencas,
  simularVarreduras,
  type Classificacao,
  type ContagensVarredura,
} from '../src/grupos/varrer.js';
import { gravarConversaSupabase } from '../src/repositorio.js';
import { ClienteUazapi } from '../src/uazapi/cliente.js';

const PAGINA = 1000;

function sair(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Erro do banco: só a tabela e o code (a mensagem do PostgREST pode trazer a linha). */
function falhaBanco(onde: string, erro: { code?: string } | null): void {
  if (erro) sair(`Falha no banco (${onde}, código ${erro.code || 'desconhecido'}).`);
}

/** Lê a tabela inteira em páginas, ordenada pela chave (ordem estável entre as páginas). */
async function lerTudo<T>(
  db: SupabaseClient,
  tabela: string,
  colunas: string,
  chave: string[],
  soAtivos = false,
): Promise<T[]> {
  const linhas: T[] = [];
  for (let de = 0; ; de += PAGINA) {
    let q = db.from(tabela).select(colunas);
    if (soAtivos) q = q.eq('ativo', true);
    for (const c of chave) q = q.order(c);
    const r = await q.range(de, de + PAGINA - 1);
    falhaBanco(tabela, r.error);
    linhas.push(...((r.data ?? []) as T[]));
    if ((r.data ?? []).length < PAGINA) return linhas;
  }
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

type MembroTime = MembroResponsavel & { numero: string; lid: string | null };
type GrupoLido = GrupoResponsavel & { tipo: 'grupo' | 'privada'; ativo: boolean };

const time = await lerTudo<MembroTime>(db, 'time', 'nome, numero, lid, instancia, gestor_padrao, funcao', ['nome'], true);
const dono = time.find((t) => t.instancia === nome);
if (!dono) sair(`A instância ${nome} não tem dono em time.instancia.`);
const chavesTime = new Set(time.map((t) => chaveTelefone(t.numero)).filter((c) => c !== ''));
const lidsTime = new Set(time.map((t) => t.lid).filter((l): l is string => !!l));

const lerGrupos = () =>
  lerTudo<GrupoLido>(db, 'grupos', 'jid, tipo, ativo, especialista, gestor, principal_definido_em', ['jid']);
const lerPresencas = () => lerTudo<{ jid: string; instancia: string }>(db, 'presencas', 'jid, instancia', ['jid', 'instancia']);
const lerVarreduras = () =>
  lerTudo<{ instancia: string; concluida_em: string; grupos: number }>(
    db,
    'varreduras',
    'instancia, concluida_em, grupos',
    ['instancia'],
  );

const grupos = await lerGrupos();
const varreduras = await lerVarreduras();
const cadastrados = new Set(grupos.map((g) => g.jid));

const agora = Date.now();
const agoraIso = new Date(agora).toISOString();
const uazapi = new ClienteUazapi(instancia.baseUrl, instancia.token);
const listagem = await listarComSeguranca(uazapi, varreduras.find((v) => v.instancia === nome)?.grupos);

let classificacao: Classificacao | undefined;
if (listagem.ok) {
  classificacao = await classificarListados(
    listagem.grupos,
    cadastrados,
    { ehDoTime: (n) => chavesTime.has(chaveTelefone(n)), ehLidDoTime: (l) => lidsTime.has(l), observador },
    (jid) => uazapi.participantesDoGrupo(jid),
  );
}

const contagens: Omit<ContagensVarredura, 'responsaveis'> = { listagem, classificacao };
const ativosGrupo = (gs: GrupoLido[]) => gs.filter((g) => g.ativo && g.tipo === 'grupo');
let plano;

if (gravar) {
  // 1) Cadastro dos grupos novos (insert sem sobrescrever: outra instância pode ter cadastrado antes).
  if (listagem.ok && classificacao) {
    const gravarConversa = gravarConversaSupabase(db);
    contagens.cadastrados = 0;
    contagens.falhasCadastro = 0;
    for (const g of classificacao.aCadastrar) {
      try {
        await gravarConversa(novaConversaDeGrupo(g, { especialista: dono.nome, gestor: dono.gestor_padrao }, nome, agoraIso));
        contagens.cadastrados++;
      } catch (e) {
        if (!(e instanceof ErroCadastroConversa)) throw e;
        contagens.falhasCadastro++;
      }
    }
    // 2) Presença: troca atômica, só com listagem boa.
    const r = await db.rpc('substituir_presencas', {
      p_instancia: nome,
      p_jids: listagem.grupos.map((g) => g.JID).filter((j) => j.endsWith('@g.us')),
      p_listados: listagem.grupos.length,
      p_concluida_em: agoraIso,
    });
    falhaBanco('substituir_presencas', r.error);
    contagens.presencasGravadas = r.data as number;
  }
  // 3) Regra do responsável com o que ficou no banco.
  plano = planejarResponsaveis({
    grupos: ativosGrupo(await lerGrupos()),
    presencas: await lerPresencas(),
    time,
    varreduras: await lerVarreduras(),
    agora,
  });
  contagens.trocasGravadas = 0;
  for (const t of plano.trocas) {
    const r = await db.rpc('trocar_responsavel', {
      p_jid: t.jid,
      p_esperado: t.esperado,
      p_especialista: t.especialista,
      p_gestor: t.gestor,
      p_instancia: t.instancia,
      p_motivo: 'automatico',
    });
    falhaBanco('trocar_responsavel', r.error);
    if (r.data === true) contagens.trocasGravadas++;
  }
} else {
  // Simulação: os grupos novos entram como provisórios do dono, e a presença e a varredura desta
  // instância como ficariam se a listagem fosse gravada.
  const novos: GrupoLido[] = (classificacao?.aCadastrar ?? []).map((g) => ({
    jid: g.JID,
    tipo: 'grupo',
    ativo: true,
    especialista: dono.nome,
    gestor: dono.gestor_padrao,
    principal_definido_em: null,
  }));
  const comNovos = new Set([...cadastrados, ...novos.map((g) => g.jid)]);
  const presencas = await lerPresencas();
  plano = planejarResponsaveis({
    grupos: ativosGrupo([...grupos, ...novos]),
    presencas: listagem.ok ? simularPresencas(presencas, nome, listagem.grupos.map((g) => g.JID), comNovos) : presencas,
    time,
    varreduras: listagem.ok ? simularVarreduras(varreduras, nome, agoraIso) : varreduras,
    agora,
  });
}

console.log(`instância: ${instancia.variavelToken}`);
console.log(formatarVarredura({ ...contagens, responsaveis: plano }, gravar));
