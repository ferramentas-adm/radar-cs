-- Especialista responsável pelo grupo, decidido pela presença (fase C2).
-- - time.funcao: só quem tem funcao = 'especialista' conta para decidir o dono de um grupo.
-- - grupos.principal_definido_em: o responsável foi definido por uma pessoa (importação por CSV ou
--   conversas:definir-principal). Nulo = provisório (cadastro automático).
-- - presencas: quais instâncias de pessoa estão em cada grupo, lidas pela varredura (grupos:varrer).
--   A presença de uma instância só é substituída por uma listagem completa e boa.
-- - varreduras: a última varredura boa de cada instância (para a regra das 24 horas).
-- - responsaveis_historico: toda troca de responsável (automática ou por pessoa). Nunca apagar.
-- Tudo só pela service role: RLS ligado, sem policy, sem acesso para anon e authenticated.

alter table public.time
  add column funcao text check (funcao in ('especialista', 'gestor', 'observador'));

comment on column public.time.funcao is
  'especialista, gestor ou observador. Só especialista conta para decidir o dono de um grupo pela presença.';

alter table public.grupos add column principal_definido_em timestamptz;

comment on column public.grupos.principal_definido_em is
  'Quando uma pessoa definiu o especialista principal (grupos:importar ou conversas:definir-principal). '
  'Nulo = responsável provisório (cadastro automático): a varredura pode trocar sozinha.';

-- Backfill: grupo importado já foi definido por uma pessoa (o CS, pelo CSV).
update public.grupos set principal_definido_em = now() where origem = 'importado';

create table public.presencas (
  jid       text not null references public.grupos (jid) on update cascade,
  instancia text not null check (instancia ~ '^[a-z0-9_]+$'),
  visto_em  timestamptz not null,
  primary key (jid, instancia)
);

create index presencas_instancia on public.presencas (instancia);

comment on table public.presencas is
  'Instâncias de pessoa presentes em cada grupo cadastrado, pela última varredura boa de cada instância.';

alter table public.presencas enable row level security;
revoke all on table public.presencas from anon, authenticated;

create table public.varreduras (
  instancia    text primary key check (instancia ~ '^[a-z0-9_]+$'),
  concluida_em timestamptz not null,
  grupos       integer not null check (grupos >= 0)
);

comment on table public.varreduras is
  'Última varredura boa (listagem completa) de cada instância e quantos grupos ela listou.';

alter table public.varreduras enable row level security;
revoke all on table public.varreduras from anon, authenticated;

create table public.responsaveis_historico (
  id                    bigint generated always as identity primary key,
  jid                   text not null references public.grupos (jid) on update cascade,
  especialista_anterior text,
  especialista_novo     text not null,
  gestor_anterior       text,
  gestor_novo           text,
  instancia_anterior    text,
  instancia_nova        text,
  motivo                text not null check (motivo in ('automatico', 'pessoa')),
  em                    timestamptz not null default now()
);

create index responsaveis_historico_jid on public.responsaveis_historico (jid, em desc);

comment on table public.responsaveis_historico is
  'Histórico de trocas de responsável. automatico: a varredura trocou um grupo provisório; '
  'pessoa: conversas:definir-principal. Nunca apagar.';

alter table public.responsaveis_historico enable row level security;
revoke all on table public.responsaveis_historico from anon, authenticated;

-- Troca atômica da presença de uma instância: apaga a anterior, grava a da listagem (só grupos
-- cadastrados) e registra a varredura boa. Chamada só depois de uma listagem completa e boa.
-- Parâmetro nulo (ou p_listados negativo) = erro, nunca apaga a presença. Array vazio é aceito:
-- quem decide se uma lista vazia é suspeita é o código (grupos:varrer).
create function public.substituir_presencas(
  p_instancia    text,
  p_jids         text[],
  p_listados     integer,
  p_concluida_em timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  gravadas integer;
begin
  if p_instancia is null or p_jids is null or p_concluida_em is null
     or p_listados is null or p_listados < 0 then
    raise exception 'parâmetros inválidos' using errcode = '22023';
  end if;
  delete from public.presencas where instancia = p_instancia;
  insert into public.presencas (jid, instancia, visto_em)
    select distinct g.jid, p_instancia, p_concluida_em
    from unnest(p_jids) as u (jid)
    join public.grupos g on g.jid = u.jid and g.tipo = 'grupo';
  get diagnostics gravadas = row_count;
  insert into public.varreduras (instancia, concluida_em, grupos)
    values (p_instancia, p_concluida_em, p_listados)
    on conflict (instancia) do update
      set concluida_em = excluded.concluida_em, grupos = excluded.grupos;
  return gravadas;
end;
$$;

revoke execute on function public.substituir_presencas(text, text[], integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.substituir_presencas(text, text[], integer, timestamptz) to service_role;

-- Troca de responsável com histórico, numa transação só. Só troca se o especialista atual ainda é
-- o esperado (outra troca no meio do caminho = não faz nada). A troca automática nunca mexe em
-- grupo definido por pessoa. motivo = 'pessoa' marca principal_definido_em; se o especialista
-- informado já é o atual, só trava o grupo nele (com histórico) e devolve true.
-- Devolve true se gravou.
create function public.trocar_responsavel(
  p_jid          text,
  p_esperado     text,
  p_especialista text,
  p_gestor       text,
  p_instancia    text,
  p_motivo       text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  atual record;
begin
  if p_motivo not in ('automatico', 'pessoa') then
    raise exception 'motivo inválido' using errcode = '22023';
  end if;
  select especialista, gestor, instancia, principal_definido_em into atual
    from public.grupos
    where jid = p_jid and tipo = 'grupo'
    for update;
  if not found then
    raise exception 'grupo não encontrado' using errcode = 'P0002';
  end if;
  -- Pessoa confirmando o especialista que já é o atual: trava o grupo nele (principal_definido_em),
  -- com histórico, sem mexer em gestor nem instância.
  if p_motivo = 'pessoa' and atual.especialista is not distinct from p_especialista then
    update public.grupos set principal_definido_em = now() where jid = p_jid;
    insert into public.responsaveis_historico (
      jid, especialista_anterior, especialista_novo, gestor_anterior, gestor_novo,
      instancia_anterior, instancia_nova, motivo
    ) values (
      p_jid, atual.especialista, atual.especialista, atual.gestor, atual.gestor,
      atual.instancia, atual.instancia, p_motivo
    );
    return true;
  end if;
  if atual.especialista is distinct from p_esperado then
    return false;
  end if;
  if p_motivo = 'automatico' and atual.principal_definido_em is not null then
    return false;
  end if;
  update public.grupos
    set especialista = p_especialista,
        gestor = p_gestor,
        instancia = p_instancia,
        principal_definido_em = case when p_motivo = 'pessoa' then now() else principal_definido_em end
    where jid = p_jid;
  insert into public.responsaveis_historico (
    jid, especialista_anterior, especialista_novo, gestor_anterior, gestor_novo,
    instancia_anterior, instancia_nova, motivo
  ) values (
    p_jid, atual.especialista, p_especialista, atual.gestor, p_gestor,
    atual.instancia, p_instancia, p_motivo
  );
  return true;
end;
$$;

revoke execute on function public.trocar_responsavel(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.trocar_responsavel(text, text, text, text, text, text) to service_role;
