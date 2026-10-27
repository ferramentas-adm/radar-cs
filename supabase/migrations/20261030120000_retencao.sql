-- Retenção (LGPD, regra 6): mensagens só enquanto a conversa estiver ativa, mais 90 dias.
-- grupos.desativado_em marca quando a conversa foi bloqueada (ativo = false); volta a nulo se for
-- reativada. As conversas já bloqueadas antes desta migration começam a contar agora (nunca antes).
alter table public.grupos add column desativado_em timestamptz;
update public.grupos set desativado_em = now() where not ativo;

comment on column public.grupos.desativado_em is
  'Quando a conversa foi bloqueada (ativo = false). As mensagens dela são apagadas 90 dias depois.';

create or replace function public.marcar_desativacao()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.ativo and not old.ativo then
    new.desativado_em := null;
  elsif not new.ativo and old.ativo then
    new.desativado_em := now();
  end if;
  return new;
end;
$$;

create trigger grupos_marcar_desativacao
  before update of ativo on public.grupos
  for each row execute function public.marcar_desativacao();

-- Apaga as mensagens das conversas bloqueadas há mais de 90 dias e os eventos brutos (só da fase de
-- descoberta) com mais de 90 dias. A conversa em si fica em grupos (mensagens e promessas apontam
-- para o jid). Devolve só contagens.
create or replace function public.limpar_retencao()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n_mensagens integer;
  n_brutos integer;
begin
  delete from public.mensagens m
  using public.grupos g
  where m.jid = g.jid
    and not g.ativo
    and g.desativado_em is not null
    and g.desativado_em < now() - interval '90 days';
  get diagnostics n_mensagens = row_count;

  delete from public.eventos_brutos e
  where e.recebido_em < now() - interval '90 days';
  get diagnostics n_brutos = row_count;

  return jsonb_build_object('mensagens', n_mensagens, 'eventos_brutos', n_brutos);
end;
$$;

revoke execute on function public.marcar_desativacao() from public, anon, authenticated;
revoke execute on function public.limpar_retencao() from public, anon, authenticated;
grant execute on function public.limpar_retencao() to service_role;
