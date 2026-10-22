-- Passo 2b: cadastros (time, grupos), perfis de acesso e configuração do motor
-- (expediente, feriados, prazos por urgência).
-- time e grupos têm nomes de clientes e telefones: só a service role (backend) acessa.
-- Configuração: leitura para usuários autenticados; escrita só para administrador (RLS).

-- Perfis: quem é administrador. Só a service role grava (ninguém se promove sozinho).
create table public.perfis (
  user_id uuid primary key references auth.users (id) on delete cascade,
  papel   text not null default 'comum' check (papel in ('admin', 'comum'))
);

comment on table public.perfis is 'Papel de cada usuário do painel. Só a service role grava.';

alter table public.perfis enable row level security;
revoke all on table public.perfis from anon, authenticated;
grant select on table public.perfis to authenticated;

create policy perfis_le_o_proprio on public.perfis
  for select to authenticated
  using (user_id = (select auth.uid()));

-- security definer: consulta perfis sem depender da policy de quem chama.
create function public.eh_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.perfis
    where user_id = (select auth.uid()) and papel = 'admin'
  );
$$;

revoke execute on function public.eh_admin() from public, anon;
grant execute on function public.eh_admin() to authenticated;

-- Time: quem está aqui é do time; quem não está é cliente.
create table public.time (
  id     bigint generated always as identity primary key,
  nome   text not null unique,
  numero text not null unique check (numero ~ '^[0-9]+$'),
  lid    text,
  ativo  boolean not null default true
);

comment on column public.time.numero is 'Só dígitos: 55 + DDD + número (corresponde ao sender_pn).';
comment on column public.time.lid is 'sender_lid (@lid), quando conhecido.';

alter table public.time enable row level security;
revoke all on table public.time from anon, authenticated;

-- Grupos de clientes que o Radar acompanha.
create table public.grupos (
  id                   bigint generated always as identity primary key,
  jid                  text not null unique check (jid like '%@g.us'),
  nome                 text,
  especialista         text references public.time (nome) on update cascade,
  gestor               text references public.time (nome) on update cascade,
  instancia            text,
  ativo                boolean not null default true,
  observador_entrou_em timestamptz,
  criado_em            timestamptz not null default now()
);

comment on column public.grupos.instancia is
  'Nome da instância uazapi que enxerga o grupo. Hoje guarda só uma; grupo visto por mais de uma '
  'instância (números corporativos) será tratado depois.';
comment on column public.grupos.observador_entrou_em is
  'Início do "sem contato" de grupo que nunca teve mensagem do time. Gravado só na primeira importação.';

alter table public.grupos enable row level security;
revoke all on table public.grupos from anon, authenticated;

-- Expediente: uma linha só (id sempre true).
create table public.config_expediente (
  id          boolean primary key default true check (id),
  hora_inicio time not null,
  hora_fim    time not null,
  dias_uteis  smallint[] not null check (
    cardinality(dias_uteis) > 0 and dias_uteis <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
  ),
  fuso        text not null,
  check (hora_fim > hora_inicio)
);

comment on column public.config_expediente.dias_uteis is 'ISO: 1 = segunda ... 7 = domingo.';

insert into public.config_expediente (hora_inicio, hora_fim, dias_uteis, fuso)
values ('09:00', '19:00', array[1, 2, 3, 4, 5]::smallint[], 'America/Sao_Paulo');

-- Feriados: o relógio para nesses dias, como no fim de semana.
create table public.feriados (
  data      date primary key,
  descricao text not null
);

-- Prazos de "sem resposta" por nível de urgência (aprovados pela Julia).
create table public.prazos_urgencia (
  urgencia       text primary key check (urgencia in ('alto', 'medio', 'baixo')),
  minutos_aviso  integer not null check (minutos_aviso > 0),
  minutos_gestor integer not null,
  check (minutos_gestor > minutos_aviso)
);

insert into public.prazos_urgencia (urgencia, minutos_aviso, minutos_gestor) values
  ('alto', 10, 15),
  ('medio', 20, 31),
  ('baixo', 60, 90);

-- Configuração: leitura para autenticados; escrita só para administrador.
alter table public.config_expediente enable row level security;
alter table public.feriados enable row level security;
alter table public.prazos_urgencia enable row level security;

revoke all on table public.config_expediente, public.feriados, public.prazos_urgencia from anon;
grant select, insert, update, delete
  on table public.config_expediente, public.feriados, public.prazos_urgencia to authenticated;

create policy config_expediente_leitura on public.config_expediente
  for select to authenticated using (true);
create policy config_expediente_admin_atualiza on public.config_expediente
  for update to authenticated using (public.eh_admin()) with check (public.eh_admin());
-- Sem policy de insert/delete: a linha única nasce aqui e nunca é apagada.

create policy feriados_leitura on public.feriados
  for select to authenticated using (true);
create policy feriados_admin_insere on public.feriados
  for insert to authenticated with check (public.eh_admin());
create policy feriados_admin_atualiza on public.feriados
  for update to authenticated using (public.eh_admin()) with check (public.eh_admin());
create policy feriados_admin_apaga on public.feriados
  for delete to authenticated using (public.eh_admin());

create policy prazos_urgencia_leitura on public.prazos_urgencia
  for select to authenticated using (true);
create policy prazos_urgencia_admin_atualiza on public.prazos_urgencia
  for update to authenticated using (public.eh_admin()) with check (public.eh_admin());
-- Sem policy de insert/delete: os três níveis são fixos; o administrador só muda os minutos.
