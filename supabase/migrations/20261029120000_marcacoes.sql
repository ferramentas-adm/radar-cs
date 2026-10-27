-- "Registrar ação feita" (passo 6, antes "Resolvi por fora"). Histórico: nunca se apaga.
-- volta_em = fim da janela de 3 h em tempo de expediente, calculado pelo servidor na hora do registro.
-- Uma marcação aberta (encerrada_em nulo) por grupo. Fecha quando o time escreve no grupo
-- (mensagem_no_grupo), quando a janela passa sem mensagem (expirou) ou quando alguém desfaz (desfeita).
create table public.marcacoes (
  id           bigint generated always as identity primary key,
  jid          text not null references public.grupos (jid),
  marcado_por  text not null check (char_length(marcado_por) between 1 and 120),
  como         text not null check (como in ('ligacao', 'privado', 'reuniao')),
  marcado_em   timestamptz not null default now(),
  volta_em     timestamptz not null check (volta_em > marcado_em),
  encerrada_em timestamptz,
  encerrada_por text check (encerrada_por in ('mensagem_no_grupo', 'desfeita', 'expirou')),
  check ((encerrada_em is null) = (encerrada_por is null))
);
create unique index marcacoes_uma_aberta_idx on public.marcacoes (jid) where encerrada_em is null;
create index marcacoes_jid_marcado_em_idx on public.marcacoes (jid, marcado_em desc);

alter table public.marcacoes enable row level security;
revoke all on table public.marcacoes from anon, authenticated;

-- Fecha as marcações abertas que já acabaram. Devolve quantas fechou.
create or replace function public.encerrar_marcacoes()
returns integer
language sql
security invoker
set search_path = ''
as $$
  with fechadas as (
    update public.marcacoes m set
      encerrada_em = coalesce(
        (select min(x.enviada_em) from public.mensagens x
          where x.jid = m.jid and x.autor_tipo = 'time' and x.conta and x.enviada_em > m.marcado_em),
        m.volta_em
      ),
      encerrada_por = case when exists (
        select 1 from public.mensagens x
        where x.jid = m.jid and x.autor_tipo = 'time' and x.conta and x.enviada_em > m.marcado_em
      ) then 'mensagem_no_grupo' else 'expirou' end
    where m.encerrada_em is null
      and (m.volta_em <= now() or exists (
        select 1 from public.mensagens x
        where x.jid = m.jid and x.autor_tipo = 'time' and x.conta and x.enviada_em > m.marcado_em
      ))
    returning 1
  )
  select count(*)::integer from fechadas;
$$;

-- Registra a marcação. Devolve 'ok', 'grupo_inexistente' (não existe, inativo ou privada) ou 'ja_existe'.
create or replace function public.registrar_marcacao(p_jid text, p_como text, p_por text, p_volta_em timestamptz)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.grupos g where g.jid = p_jid and g.ativo and g.tipo = 'grupo';
  if not found then
    return 'grupo_inexistente';
  end if;
  perform public.encerrar_marcacoes();
  begin
    insert into public.marcacoes (jid, marcado_por, como, volta_em) values (p_jid, p_por, p_como, p_volta_em);
  exception when unique_violation then
    return 'ja_existe';
  end;
  return 'ok';
end;
$$;

-- Desfaz a marcação aberta do grupo. Devolve quantas desfez (0 ou 1).
create or replace function public.desfazer_marcacao(p_jid text)
returns integer
language sql
security invoker
set search_path = ''
as $$
  with d as (
    update public.marcacoes set encerrada_em = now(), encerrada_por = 'desfeita'
    where jid = p_jid and encerrada_em is null
    returning 1
  )
  select count(*)::integer from d;
$$;

revoke execute on function public.encerrar_marcacoes() from public, anon, authenticated;
grant execute on function public.encerrar_marcacoes() to service_role;
revoke execute on function public.registrar_marcacao(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.registrar_marcacao(text, text, text, timestamptz) to service_role;
revoke execute on function public.desfazer_marcacao(text) from public, anon, authenticated;
grant execute on function public.desfazer_marcacao(text) to service_role;

-- radar_dados: cada grupo traz a marcação mais recente (o motor decide se vale) e 'recursos.marcacoes'
-- avisa o painel de que o recurso existe.
create or replace function public.radar_dados()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'recursos', jsonb_build_object('marcacoes', true),
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
