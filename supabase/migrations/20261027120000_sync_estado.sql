-- Passo 5: reconciliação e saúde. Guarda, por instância, até onde a reconciliação já chegou
-- (para não reler tudo a cada rodada) e o último status de conexão visto (para sobreviver a um
-- reinício do backend sem perder o "a instância estava desconectada desde quando").

create table public.sync_estado (
  instancia         text primary key check (instancia ~ '^[a-z0-9_]+$'),
  ultima_mensagem_em timestamptz,
  ultimo_status     text,
  atualizado_em     timestamptz not null default now()
);

comment on table public.sync_estado is
  'Por instância: até onde a reconciliação (/message/find) já leu e o último status de conexão visto.';

alter table public.sync_estado enable row level security;
revoke all on table public.sync_estado from anon, authenticated;
