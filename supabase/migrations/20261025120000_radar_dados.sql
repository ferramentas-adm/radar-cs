-- Dados do GET /api/radar numa consulta só (antes: 2 ou 3 consultas por conversa ativa).
-- A função devolve um jsonb único (escapa do limite de 1000 linhas do PostgREST) com:
-- - conversas ativas (grupos e privadas) e, por conversa, a última mensagem do time que conta, as
--   mensagens do cliente que contam depois dela (no máximo 1000, da mais antiga para a mais nova) e,
--   só na privada, a hora da última mensagem de qualquer tipo (atividade);
-- - expediente, feriados, prazo do nível médio e a hora da última mensagem recebida;
-- - presença, time ativo e varreduras, para a lista "aguardando definição" (planejarResponsaveis).
-- Nunca lê o texto das mensagens nem número de ninguém. Só a service role executa.

-- Última do time e pendentes do cliente: leitura direta de índice, sem filtrar conta/autor linha a linha.
create index mensagens_time_conta_idx on public.mensagens (jid, enviada_em desc)
  where conta and autor_tipo = 'time';
create index mensagens_cliente_conta_idx on public.mensagens (jid, enviada_em)
  where conta and autor_tipo = 'cliente';
-- Última mensagem recebida (de qualquer conversa).
create index mensagens_enviada_em_idx on public.mensagens (enviada_em desc);

create function public.radar_dados()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'conversas', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'jid', c.jid,
          'tipo', c.tipo,
          'nome', c.nome,
          'especialista', c.especialista,
          'gestor', c.gestor,
          'observador_entrou_em', c.observador_entrou_em,
          'principal_definido_em', c.principal_definido_em,
          'ultima_time', case when t.enviada_em is null then null
            else jsonb_build_object('id_mensagem', t.id_mensagem, 'enviada_em', t.enviada_em) end,
          'pendentes', coalesce(p.lista, '[]'::jsonb),
          'ultima_atividade_em', a.em
        )
        order by c.id
      )
      from public.grupos c
      left join lateral (
        select m.id_mensagem, m.enviada_em
        from public.mensagens m
        where m.jid = c.jid and m.conta and m.autor_tipo = 'time'
        order by m.enviada_em desc, m.id_mensagem desc
        limit 1
      ) t on true
      left join lateral (
        select jsonb_agg(
                 jsonb_build_object('id_mensagem', x.id_mensagem, 'enviada_em', x.enviada_em)
                 order by x.enviada_em, x.id_mensagem
               ) as lista
        from (
          select m.id_mensagem, m.enviada_em
          from public.mensagens m
          where m.jid = c.jid and m.conta and m.autor_tipo = 'cliente'
            and (t.enviada_em is null or m.enviada_em > t.enviada_em)
          order by m.enviada_em, m.id_mensagem
          limit 1000
        ) x
      ) p on true
      left join lateral (
        select max(m.enviada_em) as em
        from public.mensagens m
        where c.tipo = 'privada' and m.jid = c.jid
      ) a on true
      where c.ativo
    ), '[]'::jsonb),
    'expediente', (
      select jsonb_build_object(
        'hora_inicio', e.hora_inicio, 'hora_fim', e.hora_fim, 'dias_uteis', e.dias_uteis, 'fuso', e.fuso
      )
      from public.config_expediente e
    ),
    'feriados', coalesce((select jsonb_agg(f.data order by f.data) from public.feriados f), '[]'::jsonb),
    'prazo', (
      select jsonb_build_object('minutos_aviso', u.minutos_aviso, 'minutos_gestor', u.minutos_gestor)
      from public.prazos_urgencia u
      where u.urgencia = 'medio'
    ),
    'ultima_mensagem_em', (
      select m.enviada_em from public.mensagens m order by m.enviada_em desc limit 1
    ),
    'presencas', coalesce((
      select jsonb_agg(jsonb_build_object('jid', s.jid, 'instancia', s.instancia) order by s.jid, s.instancia)
      from public.presencas s
    ), '[]'::jsonb),
    'time', coalesce((
      select jsonb_agg(
        jsonb_build_object('nome', tm.nome, 'instancia', tm.instancia, 'gestor_padrao', tm.gestor_padrao, 'funcao', tm.funcao)
        order by tm.nome
      )
      from public.time tm
      where tm.ativo
    ), '[]'::jsonb),
    'varreduras', coalesce((
      select jsonb_agg(jsonb_build_object('instancia', v.instancia, 'concluida_em', v.concluida_em) order by v.instancia)
      from public.varreduras v
    ), '[]'::jsonb)
  );
$$;

comment on function public.radar_dados() is
  'Tudo que o GET /api/radar precisa, numa consulta só. Sem texto de mensagem e sem número. Só service_role.';

revoke execute on function public.radar_dados() from public, anon, authenticated;
grant execute on function public.radar_dados() to service_role;
