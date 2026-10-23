// Carregamento ANTIGO dos dados do GET /api/radar: 2 ou 3 consultas por conversa ativa.
// Fica só como referência para o npm run radar:comparar (prova que public.radar_dados() dá o mesmo
// resultado) e para o teste de equivalência. O painel usa src/api/dados.ts.
// Por conversa ativa (grupo ou privada): a última mensagem do time que conta e as do cliente depois
// dela. Na privada, também a última mensagem de qualquer lado (atividade). O texto nunca é lido.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Expediente } from '../motor/expediente.js';
import type { EntradaMotor, GrupoMotor, MensagemMotor } from '../motor/calcular.js';

export type DadosRadarLegado = Pick<EntradaMotor, 'grupos' | 'mensagens' | 'calendario' | 'prazo' | 'ultimaMensagemEm'>;

const LIMITE_PENDENTES = 1000; // mensagens do cliente sem resposta por conversa
const PAGINA = 1000; // o PostgREST devolve no máximo 1000 linhas por consulta

interface LinhaGrupo {
  jid: string;
  tipo: 'grupo' | 'privada';
  nome: string | null;
  especialista: string | null;
  gestor: string | null;
  ativo: boolean;
  observador_entrou_em: string | null;
}

const CONSULTAS_SIMULTANEAS = 10; // com o cadastro automático as conversas passam de centenas

/** Roda fn em todos os itens, no máximo `limite` ao mesmo tempo. O primeiro erro rejeita. */
async function emParalelo<T>(itens: T[], limite: number, fn: (item: T) => Promise<void>): Promise<void> {
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < itens.length) await fn(itens[proximo++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, trabalhador));
}

function falhou(tabela: string, erro: { message: string } | null): void {
  if (erro) throw new Error(`supabase (${tabela}): ${erro.message}`);
}

async function conversasAtivas(db: SupabaseClient): Promise<LinhaGrupo[]> {
  const linhas: LinhaGrupo[] = [];
  for (let de = 0; ; de += PAGINA) {
    const r = await db
      .from('grupos')
      .select('jid, tipo, nome, especialista, gestor, ativo, observador_entrou_em')
      .eq('ativo', true)
      .order('id')
      .range(de, de + PAGINA - 1);
    falhou('grupos', r.error);
    linhas.push(...((r.data ?? []) as LinhaGrupo[]));
    if ((r.data ?? []).length < PAGINA) return linhas;
  }
}

export async function carregarDadosRadarLegado(db: SupabaseClient): Promise<DadosRadarLegado> {
  const [conversas, expediente, feriados, prazo, ultima] = await Promise.all([
    conversasAtivas(db),
    db.from('config_expediente').select('hora_inicio, hora_fim, dias_uteis, fuso').single(),
    db.from('feriados').select('data'),
    db.from('prazos_urgencia').select('minutos_aviso, minutos_gestor').eq('urgencia', 'medio').single(),
    db.from('mensagens').select('enviada_em').order('enviada_em', { ascending: false }).limit(1),
  ]);
  falhou('config_expediente', expediente.error);
  falhou('feriados', feriados.error);
  falhou('prazos_urgencia', prazo.error);
  falhou('mensagens', ultima.error);

  const listaGrupos: GrupoMotor[] = conversas.map((g) => ({
    id_grupo: g.jid,
    tipo: g.tipo,
    // Privada não tem nome; nunca vira linha do painel.
    cliente: g.nome ?? (g.tipo === 'privada' ? '' : '(sem nome)'),
    especialista: g.especialista ?? '(sem especialista)',
    gestor: g.gestor ?? '(sem gestor)',
    ativo: g.ativo,
    observador_entrou_em: g.observador_entrou_em ? Date.parse(g.observador_entrou_em) : null,
  }));

  const mensagens: MensagemMotor[] = [];
  await emParalelo(listaGrupos, CONSULTAS_SIMULTANEAS, async (g) => {
    const time = await db
      .from('mensagens')
      .select('id_mensagem, enviada_em')
      .eq('jid', g.id_grupo)
      .eq('conta', true)
      .eq('autor_tipo', 'time')
      .order('enviada_em', { ascending: false })
      .limit(1);
    falhou('mensagens', time.error);
    const ultimaTime = time.data?.[0] as { id_mensagem: string; enviada_em: string } | undefined;

    let cliente = db
      .from('mensagens')
      .select('id_mensagem, enviada_em')
      .eq('jid', g.id_grupo)
      .eq('conta', true)
      .eq('autor_tipo', 'cliente');
    if (ultimaTime) cliente = cliente.gt('enviada_em', ultimaTime.enviada_em);
    const pend = await cliente.order('enviada_em', { ascending: true }).limit(LIMITE_PENDENTES);
    falhou('mensagens', pend.error);

    if (ultimaTime) {
      mensagens.push({ id_mensagem: ultimaTime.id_mensagem, id_grupo: g.id_grupo, autor_tipo: 'time', enviada_em: Date.parse(ultimaTime.enviada_em) });
    }
    for (const m of (pend.data ?? []) as { id_mensagem: string; enviada_em: string }[]) {
      mensagens.push({ id_mensagem: m.id_mensagem, id_grupo: g.id_grupo, autor_tipo: 'cliente', enviada_em: Date.parse(m.enviada_em) });
    }

    if (g.tipo === 'privada') {
      const at = await db
        .from('mensagens')
        .select('enviada_em')
        .eq('jid', g.id_grupo)
        .order('enviada_em', { ascending: false })
        .limit(1);
      falhou('mensagens', at.error);
      const em = (at.data?.[0] as { enviada_em: string } | undefined)?.enviada_em;
      g.ultima_atividade_em = em ? Date.parse(em) : null;
    }
  });

  const exp = expediente.data as Expediente;
  const ultimaMsg = (ultima.data?.[0] as { enviada_em: string } | undefined)?.enviada_em;
  return {
    grupos: listaGrupos,
    mensagens,
    calendario: {
      expediente: { ...exp, dias_uteis: exp.dias_uteis.map(Number) },
      feriados: new Set((feriados.data ?? []).map((f: { data: string }) => f.data)),
    },
    prazo: prazo.data as { minutos_aviso: number; minutos_gestor: number },
    ultimaMensagemEm: ultimaMsg ? Date.parse(ultimaMsg) : null,
  };
}
