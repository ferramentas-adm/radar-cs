-- Fatia do piloto (fase A): mensagens normalizadas dos grupos cadastrados.
-- Só entram mensagens de grupos ativos de public.grupos; o receptor descarta o resto na chegada.
-- O texto nunca é guardado: só a máscara "[texto omitido: N caracteres]" (o banco recusa outra coisa).

create table public.mensagens (
  id           bigint generated always as identity primary key,
  id_mensagem  text not null unique,
  jid          text not null references public.grupos (jid) on update cascade,
  instancia    text not null,
  autor_tipo   text not null check (autor_tipo in ('cliente', 'time')),
  autor_numero text check (autor_numero ~ '^[0-9]+$'),
  tipo         text not null check (
    tipo in ('texto', 'audio', 'imagem', 'documento', 'reacao', 'figurinha', 'video', 'outro')
  ),
  conta        boolean not null,
  texto        text check (texto ~ '^\[texto omitido: [0-9]+ caracteres\]$'),
  enviada_em   timestamptz not null,
  recebida_em  timestamptz not null default now(),
  -- Número só de quem é do time; de cliente fica nulo.
  check (autor_tipo = 'time' or autor_numero is null)
);

comment on column public.mensagens.id_mensagem is 'messageid da uazapi. Único: evento repetido ou visto por duas instâncias não duplica.';
comment on column public.mensagens.instancia is 'Instância uazapi que entregou a mensagem (a primeira, se mais de uma viu).';
comment on column public.mensagens.conta is
  'Conta para as regras: texto, áudio e foto/documento com legenda. Reação, figurinha, mídia sem legenda e vídeo não.';
comment on column public.mensagens.texto is 'Só a máscara com o tamanho do texto; o conteúdo nunca é guardado.';

create index mensagens_jid_enviada_em_idx on public.mensagens (jid, enviada_em desc);

-- RLS ligado e sem policy: só a service role (backend) acessa.
alter table public.mensagens enable row level security;
revoke all on table public.mensagens from anon, authenticated;

-- eventos_brutos (só durante o piloto): de qual instância veio o evento.
alter table public.eventos_brutos add column instancia text;
