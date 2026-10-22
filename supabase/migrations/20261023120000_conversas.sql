-- Mudança de escopo: o Radar analisa todas as conversas dos números conectados, exceto as internas.
-- A tabela grupos passa a guardar também conversas privadas (coluna tipo). Conversa nova é cadastrada
-- sozinha pelo receptor (origem = 'automatico'); as importadas por CSV continuam como estão.
-- Privacidade: na privada o número do cliente nunca fica em claro. O jid é 'privada:' + HMAC-SHA256
-- (chave RADAR_CHAVE_CONVERSA, sobre instância + número) e o chatid original fica cifrado
-- (AES-256-GCM, chave RADAR_CHAVE_CIFRA) em chat_cifrado, só para a reconciliação do passo 5.

alter table public.grupos
  add column tipo text not null default 'grupo' check (tipo in ('grupo', 'privada')),
  add column origem text not null default 'importado' check (origem in ('importado', 'automatico')),
  add column chat_cifrado text;

-- O check antigo só aceitava @g.us.
alter table public.grupos drop constraint grupos_jid_check;
alter table public.grupos add constraint grupos_jid_por_tipo check (
  (tipo = 'grupo' and jid like '%@g.us' and chat_cifrado is null)
  or (
    tipo = 'privada'
    and jid ~ '^privada:[0-9a-f]{64}$'
    and chat_cifrado is not null
    and nome is null
    and instancia is not null
  )
);

comment on column public.grupos.tipo is
  'grupo: grupo de WhatsApp com alguém de fora do time. privada: conversa privada de uma instância com '
  'um número de fora do time. Na privada vale só "sem resposta".';
comment on column public.grupos.origem is
  'importado: veio do CSV (grupos:importar). automatico: cadastrado pelo receptor na primeira mensagem.';
comment on column public.grupos.chat_cifrado is
  'Só na privada: chatid cifrado (AES-256-GCM). Nunca exibido; usado só no servidor para reconciliar.';
comment on column public.grupos.nome is 'Nome do grupo. Na privada fica sempre nulo (o contato não é guardado).';
comment on column public.grupos.instancia is
  'Instância uazapi dona da conversa: a primeira que a viu (cadastro automático) ou a do CSV. '
  'O especialista é o dono dessa instância. Na privada faz parte da chave.';
comment on column public.grupos.observador_entrou_em is
  'Início do "sem contato" de grupo que nunca teve mensagem do time: data da importação ou, no '
  'cadastro automático, a hora da primeira mensagem vista. Nulo na privada (sem contato não se aplica).';
comment on column public.grupos.ativo is
  'false = conversa ignorada (bloqueada): sai da análise e mensagens novas não são gravadas; o histórico fica.';

-- Quem é dono de cada instância e o gestor padrão dessa pessoa (para o cadastro automático).
alter table public.time
  add column instancia text unique check (instancia ~ '^[a-z0-9_]+$'),
  add column gestor_padrao text references public.time (nome) on update cascade;

comment on column public.time.instancia is
  'Nome da instância uazapi do número corporativo desta pessoa (como em RADAR_INSTANCIAS).';
comment on column public.time.gestor_padrao is 'Gestor das conversas cadastradas sozinhas pela instância desta pessoa.';
