// Lê do Supabase o que o motor precisa para GET /api/radar (service role, só leitura), numa
// consulta só: a função public.radar_dados() (migration 20261025120000_radar_dados.sql).
// Por conversa ativa (grupo ou privada): a última mensagem do time que conta e as do cliente depois
// dela. Na privada, também a última mensagem de qualquer lado (atividade). Mais presença, time e
// varreduras, para a lista "aguardando definição". O texto nunca é lido.
// O mapeamento (montarDadosRadar) é puro e é o mesmo do carregamento antigo (dados-legado.ts).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Expediente } from '../motor/expediente.js';
import type { EntradaMotor, GrupoMotor, MensagemMotor } from '../motor/calcular.js';
import type { MembroResponsavel } from '../conversas/responsavel.js';

export type DadosRadar = Pick<
  EntradaMotor,
  'grupos' | 'mensagens' | 'calendario' | 'prazo' | 'ultimaMensagemEm' | 'responsaveis'
>;

interface MensagemJson {
  id_mensagem: string;
  enviada_em: string;
}

/** Formato do jsonb devolvido por public.radar_dados(). */
export interface RadarDadosJson {
  conversas: {
    jid: string;
    tipo: 'grupo' | 'privada';
    nome: string | null;
    especialista: string | null;
    gestor: string | null;
    observador_entrou_em: string | null;
    principal_definido_em: string | null;
    ultima_time: MensagemJson | null;
    pendentes: MensagemJson[];
    ultima_atividade_em: string | null;
  }[];
  expediente: Expediente;
  feriados: string[];
  prazo: { minutos_aviso: number; minutos_gestor: number };
  ultima_mensagem_em: string | null;
  presencas: { jid: string; instancia: string }[];
  time: MembroResponsavel[];
  varreduras: { instancia: string; concluida_em: string }[];
}

/** jsonb da função → entrada do motor. Mesmos rótulos e conversões do carregamento antigo. */
export function montarDadosRadar(j: RadarDadosJson): DadosRadar {
  const grupos: GrupoMotor[] = [];
  const mensagens: MensagemMotor[] = [];
  for (const c of j.conversas) {
    grupos.push({
      id_grupo: c.jid,
      tipo: c.tipo,
      // Privada não tem nome; nunca vira linha do painel.
      cliente: c.nome ?? (c.tipo === 'privada' ? '' : '(sem nome)'),
      especialista: c.especialista ?? '(sem especialista)',
      gestor: c.gestor ?? '(sem gestor)',
      ativo: true, // a função só devolve conversas ativas
      observador_entrou_em: c.observador_entrou_em ? Date.parse(c.observador_entrou_em) : null,
      ...(c.tipo === 'privada'
        ? { ultima_atividade_em: c.ultima_atividade_em ? Date.parse(c.ultima_atividade_em) : null }
        : {}),
    });
    if (c.ultima_time) {
      mensagens.push({ id_mensagem: c.ultima_time.id_mensagem, id_grupo: c.jid, autor_tipo: 'time', enviada_em: Date.parse(c.ultima_time.enviada_em) });
    }
    for (const m of c.pendentes) {
      mensagens.push({ id_mensagem: m.id_mensagem, id_grupo: c.jid, autor_tipo: 'cliente', enviada_em: Date.parse(m.enviada_em) });
    }
  }
  return {
    grupos,
    mensagens,
    calendario: {
      expediente: { ...j.expediente, dias_uteis: j.expediente.dias_uteis.map(Number) },
      feriados: new Set(j.feriados),
    },
    prazo: j.prazo,
    ultimaMensagemEm: j.ultima_mensagem_em ? Date.parse(j.ultima_mensagem_em) : null,
    responsaveis: {
      // Só grupos (privada nunca entra na regra do responsável), com os valores crus do banco.
      grupos: j.conversas
        .filter((c) => c.tipo === 'grupo')
        .map((c) => ({ jid: c.jid, especialista: c.especialista, gestor: c.gestor, principal_definido_em: c.principal_definido_em })),
      presencas: j.presencas,
      time: j.time,
      varreduras: j.varreduras,
    },
  };
}

export async function carregarDadosRadar(db: SupabaseClient): Promise<DadosRadar> {
  const r = await db.rpc('radar_dados');
  if (r.error) throw new Error(`supabase (radar_dados): ${r.error.message}`);
  if (!r.data) throw new Error('supabase (radar_dados): resposta vazia');
  return montarDadosRadar(r.data as RadarDadosJson);
}
