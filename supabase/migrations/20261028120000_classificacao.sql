-- Classificação das mensagens do cliente (passo 3b): nível de urgência e se exige resposta.
-- Mensagem sem classificação (nula) vale médio e exige resposta: o relógio nunca deixa de correr.
-- O texto continua não sendo guardado: só o resultado da classificação.
alter table public.mensagens
  add column categoria text check (categoria is null or char_length(categoria) <= 40),
  add column urgencia text check (urgencia in ('alto', 'medio', 'baixo')),
  add column exige_resposta boolean;

comment on column public.mensagens.categoria is 'Tipo da mensagem do cliente segundo a IA (reclamação, dúvida, elogio...). Só do cliente.';
comment on column public.mensagens.urgencia is 'Nível de urgência segundo a IA. Nulo = não classificada (vale médio).';
comment on column public.mensagens.exige_resposta is 'false = cumprimento, agradecimento ou encerramento (não inicia o relógio). Nulo = exige.';

-- radar_dados: as pendentes agora levam a urgência e deixam de fora as que não exigem resposta;
-- 'prazos' traz os três níveis (o 'prazo' do médio continua, por compatibilidade).
create or replace function public.radar_dados()
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
                 jsonb_build_object('id_mensagem', x.id_mensagem, 'enviada_em', x.enviada_em, 'urgencia', x.urgencia)
                 order by x.enviada_em, x.id_mensagem
               ) as lista
        from (
          select m.id_mensagem, m.enviada_em, m.urgencia
          from public.mensagens m
          where m.jid = c.jid and m.conta and m.autor_tipo = 'cliente'
            and coalesce(m.exige_resposta, true)
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
    'prazos', coalesce((
      select jsonb_agg(
        jsonb_build_object('urgencia', u.urgencia, 'minutos_aviso', u.minutos_aviso, 'minutos_gestor', u.minutos_gestor)
        order by u.urgencia
      )
      from public.prazos_urgencia u
    ), '[]'::jsonb),
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
