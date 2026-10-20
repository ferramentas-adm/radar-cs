-- Passo 1: payloads brutos do webhook da uazapi, só na fase de descoberta.
-- Gravados já sem o token da instância e, por padrão, com o texto das mensagens mascarado.
-- Remover esta tabela depois de resolvidas as dúvidas (sender número x LID, messageType).

create table public.eventos_brutos (
  id          bigint generated always as identity primary key,
  recebido_em timestamptz not null default now(),
  evento      text,
  id_mensagem text,
  payload     jsonb not null
);

create index eventos_brutos_recebido_em_idx on public.eventos_brutos (recebido_em desc);

comment on table public.eventos_brutos is
  'Só na fase de descoberta (passo 1). Payload sem token; texto mascarado por padrão. Remover depois.';

-- RLS ligado e sem policy: só a service role (backend) acessa.
alter table public.eventos_brutos enable row level security;
revoke all on table public.eventos_brutos from anon, authenticated;
