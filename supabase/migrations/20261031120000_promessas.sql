-- IA dos retornos prometidos (passo 7). O texto das mensagens não é guardado, então a promessa é
-- detectada na chegada da mensagem do time (com as anteriores do grupo só em memória) e aqui fica só
-- o resumo (até 10 palavras, como na especificação) e o prazo.
-- feita_em = hora da mensagem da promessa. Cumprida = o time escreveu no grupo depois dela.
create table public.promessas (
  id                 bigint generated always as identity primary key,
  jid                text not null references public.grupos (jid),
  especialista       text,
  promessa           text not null check (char_length(promessa) between 1 and 120),
  prazo              timestamptz not null,
  feita_em           timestamptz not null,
  criada_em          timestamptz not null default now(),
  status             text not null default 'aberta' check (status in ('aberta', 'cumprida')),
  cumprida_em        timestamptz,
  id_mensagem_origem text not null unique,
  check ((status = 'cumprida') = (cumprida_em is not null))
);
create index promessas_abertas_idx on public.promessas (jid) where status = 'aberta';

comment on table public.promessas is
  'Retornos prometidos pelo time (IA). Só o resumo e o prazo; o texto da mensagem não é guardado.';

alter table public.promessas enable row level security;
revoke all on table public.promessas from anon, authenticated;

-- Responsável do grupo no momento da promessa, quando quem grava não informa.
create or replace function public.promessa_especialista()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.especialista is null then
    select g.especialista into new.especialista from public.grupos g where g.jid = new.jid;
  end if;
  return new;
end;
$$;

create trigger promessas_especialista
  before insert on public.promessas
  for each row execute function public.promessa_especialista();

-- Marca como cumpridas as promessas abertas com mensagem do time no grupo depois delas.
create or replace function public.cumprir_promessas()
returns integer
language sql
security invoker
set search_path = ''
as $$
  with c as (
    update public.promessas p set
      status = 'cumprida',
      cumprida_em = (
        select min(x.enviada_em) from public.mensagens x
        where x.jid = p.jid and x.autor_tipo = 'time' and x.conta and x.enviada_em > p.feita_em
      )
    where p.status = 'aberta'
      and exists (
        select 1 from public.mensagens x
        where x.jid = p.jid and x.autor_tipo = 'time' and x.conta and x.enviada_em > p.feita_em
      )
    returning 1
  )
  select count(*)::integer from c;
$$;

revoke execute on function public.promessa_especialista() from public, anon, authenticated;
revoke execute on function public.cumprir_promessas() from public, anon, authenticated;
grant execute on function public.cumprir_promessas() to service_role;

-- radar_dados: 'promessas' (abertas e cumpridas nas últimas 24 h, só de grupos ativos) e
-- recursos.promessas = true.
create or replace function public.radar_dados()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'recursos', jsonb_build_object('marcacoes', true, 'promessas', true),
    'promessas', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', pr.id, 'jid', pr.jid, 'especialista', pr.especialista, 'promessa', pr.promessa,
          'prazo', pr.prazo, 'feita_em', pr.feita_em, 'status', pr.status, 'cumprida_em', pr.cumprida_em
        )
        order by pr.prazo, pr.id
      )
      from public.promessas pr
      join public.grupos gp on gp.jid = pr.jid and gp.ativo and gp.tipo = 'grupo'
      where pr.status = 'aberta' or pr.cumprida_em > now() - interval '24 hours'
    ), '[]'::jsonb),
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
          'ultima_atividade_em', a.em,
          'marcacao', mk.obj
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
        select jsonb_build_object(
                 'como', k.como, 'marcado_por', k.marcado_por, 'marcado_em', k.marcado_em,
                 'volta_em', k.volta_em, 'encerrada_por', k.encerrada_por
               ) as obj
        from public.marcacoes k
        where c.tipo = 'grupo' and k.jid = c.jid
        order by k.marcado_em desc
        limit 1
      ) mk on true
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
