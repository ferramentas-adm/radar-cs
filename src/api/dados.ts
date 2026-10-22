// Lê do Supabase o que o motor precisa para GET /api/radar (service role, só leitura).
// Por grupo: a última mensagem do time que conta e as do cliente depois dela. O texto nunca é lido.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Expediente } from '../motor/expediente.js';
import type { EntradaMotor, GrupoMotor, MensagemMotor } from '../motor/calcular.js';

export type DadosRadar = Pick<EntradaMotor, 'grupos' | 'mensagens' | 'calendario' | 'prazo' | 'ultimaMensagemEm'>;

const LIMITE_PENDENTES = 1000; // mensagens do cliente sem resposta por grupo

function falhou(tabela: string, erro: { message: string } | null): void {
  if (erro) throw new Error(`supabase (${tabela}): ${erro.message}`);
}

export async function carregarDadosRadar(db: SupabaseClient): Promise<DadosRadar> {
  const [grupos, expediente, feriados, prazo, ultima] = await Promise.all([
    db.from('grupos').select('jid, nome, especialista, gestor, ativo, observador_entrou_em').eq('ativo', true),
    db.from('config_expediente').select('hora_inicio, hora_fim, dias_uteis, fuso').single(),
    db.from('feriados').select('data'),
    db.from('prazos_urgencia').select('minutos_aviso, minutos_gestor').eq('urgencia', 'medio').single(),
    db.from('mensagens').select('enviada_em').order('enviada_em', { ascending: false }).limit(1),
  ]);
  falhou('grupos', grupos.error);
  falhou('config_expediente', expediente.error);
  falhou('feriados', feriados.error);
  falhou('prazos_urgencia', prazo.error);
  falhou('mensagens', ultima.error);

  const listaGrupos: GrupoMotor[] = (grupos.data ?? []).map(
    (g: {
      jid: string;
      nome: string | null;
      especialista: string | null;
      gestor: string | null;
      ativo: boolean;
      observador_entrou_em: string | null;
    }) => ({
      id_grupo: g.jid,
      cliente: g.nome ?? '(sem nome)',
      especialista: g.especialista ?? '(sem especialista)',
      gestor: g.gestor ?? '(sem gestor)',
      ativo: g.ativo,
      observador_entrou_em: g.observador_entrou_em ? Date.parse(g.observador_entrou_em) : null,
    }),
  );

  const mensagens: MensagemMotor[] = [];
  await Promise.all(
    listaGrupos.map(async (g) => {
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
    }),
  );

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
