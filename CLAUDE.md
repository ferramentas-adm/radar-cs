# Radar CS — Grupo Silva

Sistema que lê os grupos de WhatsApp dos clientes e alerta sozinho quando um cliente fica **sem resposta**, **sem contato** ou com **retorno prometido vencido**. Hoje isso depende de varredura manual, e a varredura falha (já houve cliente com 9 dias sem contato depois de o time dizer que tinha feito).

**Objetivo:** controlar a qualidade de resposta do time e mapear as promessas que o time faz ao cliente.

Documentos de referência (copiar para `docs/` antes de começar):
- `docs/especificacao.pdf` — especificação original ("Radar CS: especificação para a Tecnologia")
- `docs/Radar CS.html` — primeiro protótipo visual (clientes fictícios). Referência histórica; o painel de verdade é o `frontend/index.html`.
- `docs/Radar CS.md` — texto do primeiro protótipo
- `docs/api-contract.md` — contrato da API que o painel lê (`GET /api/radar`, marcações). **O backend implementa este contrato; não mudar o formato sem mudar o painel.**
- `frontend/index.html` — painel pronto, página única. Sem configuração abre em modo demonstração (clientes fictícios, tempo simulado). Com `window.RADAR_CONFIG = { modo: 'api', apiBase: '/api' }` lê a API real. Modo TV: `#tv` ou tecla T.
- `frontend/tests/engine-demo.test.mjs` — 30 casos de limite das regras (19/20/31 min, 23h59/24h/48h, 2h59/3h, retorno vencido, pilha de mensagens pendentes). O motor real do passo 4 deve passar nos mesmos casos (os 20/31 min equivalem ao nível de urgência médio).
- `docs/descoberta-uazapi.md` — o que os payloads reais do passo 1 mostraram (sender LID, `messageType`, campos úteis, pendências).

Se este arquivo e a especificação divergirem, vale este arquivo (ele já incorpora a decisão pela uazapi). Dúvida de regra de negócio: perguntar à Ju antes de decidir.

## Decisões já tomadas

- **WhatsApp:** uazapi (plano com 100 instâncias). Substitui "Evolution ou Z-API" da especificação.
- **Número observador:** chip já aquecido, WhatsApp comum (não Business), perfil "Grupo Silva | Qualidade". Já foi usado em atendimento, parado há semanas. Só lê. Nunca envia, nunca é admin, ninguém conversa por ele.
- **Banco:** Supabase (Postgres).
- **Backend:** um serviço Node.js + TypeScript com três partes: receptor do webhook, motor de regras (a cada minuto) e job da IA (a cada hora).
- **IA (classificação das mensagens do cliente e retornos prometidos):** API da Anthropic, modelo Claude Haiku (`claude-haiku-5-5`; confirmar a string atual em https://docs.claude.com).
- **O time responde por texto** (padrão da empresa). Áudio do time é exceção rara, mas conta como resposta.
- **Hospedagem:** local na máquina durante o piloto (com túnel HTTPS de hostname fixo), depois num servidor da Hostinger que rode Node 24h com HTTPS (confirmar o plano antes de migrar).
- **Painel:** já construído em `frontend/index.html` (prioridade do projeto: o líder precisa ver o painel funcionando cedo). Não reescrever. O backend só serve o arquivo, injeta `RADAR_CONFIG` e expõe a API de `docs/api-contract.md`. Atualiza sozinho a cada minuto. Quem calcula alerta é o servidor; o motor que existe dentro do `index.html` é só da demonstração.

## Regras inegociáveis

1. **O observador nunca envia.** O cliente da uazapi neste projeto expõe só leitura (webhook, `/instance/status`, `/group/list`, `/group/info`, `/message/find`). Nenhuma chamada a `/send/*` nem a rotas de escrita de grupo. Ter um teste automatizado que falha se qualquer arquivo referenciar `/send/`.
2. **Segredos só no servidor** (`.env`, nunca no git, nunca no painel): token da instância uazapi, `SUPABASE_SERVICE_ROLE_KEY`, chave da Anthropic. Manter `.env.example` sem valores.
3. **Nunca logar o payload do webhook inteiro.** Ele carrega o `token` da instância. Redigir o campo `token` antes de qualquer log ou gravação.
4. **Webhook sem assinatura documentada:** usar um segredo aleatório no caminho da URL (`/hooks/whatsapp/<segredo>`) e conferir que o `token` do payload é o da instância esperada. Rejeitar o resto.
5. **Privacidade:** texto das mensagens visível só para gestor e Ju (RLS no Supabase + API). O painel da TV mostra o motivo do alerta, nunca o conteúdo da conversa.
6. **Retenção (LGPD):** guardar mensagens só enquanto o cliente estiver `ativo`, mais 90 dias. Job de limpeza.
7. **Fuso:** gravar `timestamptz` (UTC). Regras, textos e relatórios em `America/Sao_Paulo`.
8. O número observador nunca conta como mensagem do time.

## uazapi: o que a documentação diz (lida em 20/10/2026, API 2.6.7)

Docs: https://docs.uazapi.com — índice para IA em `/llms.txt` e `/llms-full.txt`; OpenAPI em `/openapi-bundled.json`.

- Autenticação: header `token` (instância) e `admintoken` (servidor). Rotas de instância usam `token`.
- Estado da sessão: `GET /instance/status` (`connected`, `disconnected`, `connecting`, `hibernated`...).
- Webhook: `POST /webhook` com `{enabled, url, events, excludeMessages}`. Para o Radar: `events: ["messages", "connection"]` e `excludeMessages: ["isGroupNo"]` (ignora privado). `messages_update` só se for preciso.
- Evento `messages`: `message.id`, `message.messageid`, `message.chatid` (grupo termina em `@g.us`), `message.sender`, `message.senderName`, `message.fromMe`, `message.isGroup`, `message.messageType` (texto aparece como `Conversation`), `message.text`, `message.messageTimestamp` (**milissegundos**).
- **O webhook não tenta de novo** se o receptor falhar. Eventos podem chegar repetidos ou fora de ordem. Responder `200` imediatamente e processar depois (receptor lento atrasa a fila da instância).
- Histórico local da uazapi: até 7 dias. O banco do Radar é a fonte da verdade.
- `POST /message/find` (com `limit`/`offset`) permite reconciliar mensagens perdidas. `POST /group/list` (com `noParticipants: true`) lista grupos.
- Limite: 10 chamadas/s por instância (rajada 20). `429` traz `Retry-After`.
- Áudio: `POST /message/download` com `transcribe: true` transcreve (precisa de credencial configurada). Necessário para o áudio do **cliente**, que é transcrito antes da classificação (passo 3b).
- IDs (`id`, `messageid`, JIDs) são strings opacas. Não remover sufixos (`@g.us`, `@s.whatsapp.net`, `@lid`).

**Descoberto com payloads reais (passo 1, detalhes em `docs/descoberta-uazapi.md`):**
- `sender` em grupo chega como `@lid`. O número real vem em `sender_pn` (14 de 14 eventos, sempre `...@s.whatsapp.net`) e o LID também em `sender_lid`. A tabela `time` guarda os dois identificadores.
- `messageType` observados: `Conversation`, `ExtendedTextMessage`, `AudioMessage`, `ImageMessage`, `DocumentMessage`, `StickerMessage`, `ReactionMessage`.
- `fromMe` vem `true` nas mensagens do próprio observador.
- Campos úteis: `groupName`, `chatid`, `chatlid`, `messageid`, `senderName`, `messageTimestamp`, `mediaType`, `quoted`.
- Legenda de foto e de documento chega em `content.caption` e é copiada para `message.text`. Numa `ImageMessage` ou `DocumentMessage`, `text` com mais de 0 caracteres significa "com legenda"; sem legenda, `text` vem vazio (documento confirmado com um documento real no grupo de teste, 15 eventos no total).
- `quoted` é o `messageid` da mensagem citada (confirmado: aponta para eventos que já temos). Resposta = `ExtendedTextMessage` com `quoted` preenchido.
- Áudio, figurinha e foto ou documento sem legenda chegam com `text` vazio. O áudio vem sem transcrição: nós transcrevemos.
- Reação traz o emoji em `text`; o `messageType` `ReactionMessage` é o que a separa de texto.

## Modelo de dados (Supabase)

Nomes como na especificação.

- `grupos`: `id_grupo` (pk), `cliente`, `especialista`, `gestor`, `ativo` (bool). Preenchida pelo CS.
- `time`: `numero` (`sender_pn`), `lid` (`sender_lid`), `nome`. Quem não está nela é cliente.
- `mensagens`: `id_mensagem` (unique, = `messageid`), `id_grupo`, `autor_numero`, `autor_tipo` (`time`|`cliente`), `tipo` (texto, audio, reacao, figurinha, outro), `texto` (áudio: só a marca), `enviada_em`. Índice em `(id_grupo, enviada_em desc)`. Mensagens do cliente ganham a classificação da IA: `categoria`, `urgencia` (`alto`|`medio`|`baixo`), `exige_resposta` (bool).
- `prazos_urgencia`: tabela de configuração com os prazos de "sem resposta" por nível (`urgencia`, `aviso_min`, `gestor_min`). Mudar prazo é mudar linha, não código.
- `promessas`: `id`, `id_grupo`, `especialista`, `promessa`, `prazo`, `criada_em`, `status` (`aberta`|`cumprida`), `id_mensagem_origem`.
- `marcacoes`: histórico de "Resolvi por fora" (nunca apagar): `id`, `id_grupo`, `marcado_por`, `como` (`ligacao`|`privado`|`reuniao`), `marcado_em`, `encerrada_em`, `encerrada_por` (`mensagem_no_grupo`|`desfeita`|`expirou`).
- `eventos_brutos`: payloads (sem o `token`) só durante a fase de descoberta. Remover depois.
- `avisos_enviados`: `(id_grupo, tipo, nivel, episodio)` único, para não reenviar o mesmo aviso a cada minuto.
- `sync_estado`: última mensagem recebida, último status de conexão da instância.

RLS ligado em tudo. O backend usa a service role; o painel nunca fala direto com o banco.

## Regras dos alertas (recalcular cada grupo a cada minuto)

| Situação | Como medir | Aviso ao especialista | Sobe ao gestor |
|---|---|---|---|
| Sem resposta | mensagem do cliente que exige resposta, sem mensagem do time depois; tempo desde ela | conforme o nível (tabela abaixo) | conforme o nível |
| Sem contato | tempo desde a última mensagem do time | 1 dia | 2 dias |
| Retorno vencido | promessa aberta passou do prazo | não tem | assim que vence |

Prazos de "sem resposta" por nível de urgência (**aprovados pela Julia**; ficam na tabela de configuração `prazos_urgencia`):

| Nível | Exemplos | Aviso ao especialista | Sobe ao gestor |
|---|---|---|---|
| Alto | reclamação, reembolso, cancelamento | 10 min | 15 min |
| Médio | dúvida, solicitação, crítica | 20 min | 31 min |
| Baixo | elogio, feedback | 60 min | 90 min |

- **Toda interação do cliente exige resposta**, exceto cumprimento, agradecimento e encerramento ("obrigado", "valeu", "ok"), que não iniciam o relógio (regra **aprovada pela Julia**). O que muda entre as outras é a velocidade (o nível).
- **O que conta como mensagem** (time e cliente): só `Conversation`, `ExtendedTextMessage`, `AudioMessage` e foto ou documento com legenda (`ImageMessage` ou `DocumentMessage` com `text` não vazio), que contam como mensagem de texto, para o cliente e para o time. `ReactionMessage`, `StickerMessage`, foto ou documento sem legenda e vídeo são ignorados.
- Uma mensagem do time zera "sem resposta" e "sem contato" na hora.
- Tempo corrido, 24h por dia. **Parametrizar** para poder virar horário comercial (ex.: 8h–20h, seg–sáb) sem reescrever; a Ju decide antes de ligar para valer.
- Reação com emoji, figurinha ou "ok" do time **não** zera "sem resposta". Precisa ser texto ou áudio.
- Áudio do time conta como resposta (é exceção rara; o padrão é texto).
- Grupos com `ativo = não` saem do radar.

## Classificação das mensagens do cliente (IA)

1. Cada mensagem do cliente que conta (ver acima) é classificada pela IA (Claude Haiku), com as últimas mensagens do grupo como contexto. Áudio do cliente é transcrito antes (`/message/download` com `transcribe: true`).
2. A IA devolve o tipo da mensagem e o nível de urgência: **alto** (reclamação, reembolso, cancelamento), **médio** (dúvida, solicitação, crítica), **baixo** (elogio, feedback); ou marca como cumprimento/agradecimento/encerramento, que não exige resposta.
3. Falha da IA, JSON inválido ou dúvida: vale **médio** (o relógio nunca deixa de correr por erro do classificador).
4. O critério inicial é o julgamento da IA. Ajustar depois com os dados do piloto (prompt versionado em `prompts/`).
5. Prazos relativos ditos nas mensagens ("amanhã de noite", "até sexta") são resolvidos a partir do horário da mensagem em `America/Sao_Paulo`, não do horário em que a IA roda.

## "Registrar ação feita" (antigo "Resolvi por fora")

Na tela, o fluxo se chama **"Registrar ação feita"**, a seção é **"Ações feitas por fora"** e a lista principal é **"Precisam de ação"**. O especialista age primeiro (liga, chama no privado, faz reunião) e registra depois; a janela de 3 horas é a confirmação. Os nomes técnicos não mudam: `marcacoes`, `pode_marcar`, `resolvidos_por_fora`, `voltou_de_marcacao`.

1. No alerta, o especialista registra como agiu: ligação, privado ou reunião.
2. Grava cliente, quem marcou, como, data e hora.
3. O alerta sai de "Precisam de ação" e vai para "Ações feitas por fora", com o horário em que volta.
4. Mensagem do time no grupo dentro de 3 horas: marcação encerrada.
5. 3 horas sem mensagem do time: o alerta volta em nível gestor, com "marcado à mão, sem registro no grupo".
6. Quem marcou pode desfazer. Tudo fica no histórico.

## IA dos retornos prometidos (a cada hora)

1. Por grupo, pegar as mensagens do time da última hora + as 10 mensagens anteriores do grupo como contexto.
2. Enviar à IA com o prompt abaixo (guardar em `prompts/retornos.md`, versionado).
3. Cada promessa devolvida vira linha em `promessas` (`status = aberta`). Validar o JSON; se inválido, registrar e tentar de novo na próxima hora, sem perder as mensagens.
4. A cada minuto, uma promessa aberta vira `cumprida` quando o time manda mensagem no grupo depois dela (começar com "qualquer mensagem"; refinar no piloto).
5. Passou do prazo e continua aberta: alerta "retorno vencido", direto ao gestor.

Prompt:

```
Você lê mensagens de um grupo de WhatsApp entre o time de CS do Grupo Silva e
um cliente.

Marque toda promessa de retorno feita por alguém do time: frases como "vou
ver e te retorno", "amanhã te mando", "vou falar com o jurídico", "até sexta te passo".
Não marque cumprimentos, confirmações ou promessas do cliente.

Para cada promessa, defina o prazo:
- se a frase disser o prazo ("amanhã", "até sexta", "em 1 hora"), converta em
  data e hora;
- "amanhã" sem hora = amanhã às 18h; um dia da semana sem hora = esse dia às 18h;
- sem prazo dito = 24 horas depois da mensagem.

Responda só com JSON, uma lista vazia se não houver promessa:
[{"id_mensagem": "...", "promessa": "resumo em até 10 palavras", "prazo": "AAAA-MM-DDTHH:MM"}]

Data e hora de agora: {agora}. Fuso: America/Sao_Paulo.
Mensagens: {mensagens}
```

## Avisos

- Especialista: aviso de sem resposta (10/20/60 min conforme o nível) e de 1 dia sem contato (notificação do sistema interno ou e-mail).
- Gestor: tudo que sobe (15/31/90 min conforme o nível, 2 dias, retorno vencido, marcação à mão que voltou).
- Ju: resumo diário às 18h por e-mail, totais do dia por especialista.
- **Nunca por WhatsApp**, para não pôr os números em risco.

## Ordem de construção

Cada passo termina com testes passando e algo que dá para ver funcionando.

**Painel primeiro (feito).** `frontend/index.html` + `docs/api-contract.md`. Dá para mostrar ao líder hoje, em modo demonstração. Cada passo abaixo que alimentar o painel deve fazê-lo pelo contrato, e o painel real vai ganhando vida sem mudar de tela: passo 4 = motor real; passo 6 = `POST/DELETE /api/marcacoes`; passo 8 = `GET /api/radar`.

0. **Base:** repositório, projeto Supabase, migrations em `supabase/migrations`, `.env.example`, vitest, tipagem estrita.
1. **Receptor do webhook + captura.** `POST /hooks/whatsapp/<segredo>`: valida, responde 200, grava o payload (sem `token`) em `eventos_brutos`. Teste com o observador num **grupo interno de teste**: texto, áudio, reação, figurinha, resposta citada, de pessoas diferentes. Resultado: resolver as duas dúvidas da seção uazapi.
2. **Script de grupos.** Lista os grupos da instância e gera um CSV (`id_grupo`, nome) para o CS preencher especialista, gestor e ativo; depois importa em `grupos`. Idem para `time`.
3. **Normalizador** payload → `mensagens` (autor_tipo, tipo, dedupe por `messageid`, ms → timestamptz).

3b. **Classificador** das mensagens do cliente (IA + transcrição de áudio do cliente; ver "Classificação das mensagens do cliente"). Vem antes do motor, que depende do nível de urgência. Numerado 3b para não mudar as referências a "passo 4" etc. em outros arquivos.

4. **Motor de regras como função pura** (recebe mensagens, grupos, marcações, promessas, `agora`; devolve alertas) + agendador de 1 minuto.
5. **Reconciliação e saúde.** Ao subir e a cada poucos minutos, buscar via `/message/find` o que faltou desde a última mensagem recebida. Monitorar `/instance/status`: se a sessão cair, avisar o gestor (um painel que parece "tudo em dia" com o observador desconectado é pior que nenhum painel).
6. **Resolvi por fora.**
7. **IA dos retornos.**
8. **`GET /api/radar` conforme `docs/api-contract.md`** (monta a resposta a partir do motor, das marcações, das promessas e do estado do observador), servir o `frontend/index.html` com `RADAR_CONFIG`, avisos e resumo das 18h. Conferir o painel contra a API com dados reais, incluindo a faixa vermelha quando o observador cai.
9. **Deploy na Hostinger** e troca do túnel pela URL definitiva do webhook.

## Casos de teste do motor (mínimo)

- Mensagem do cliente nível médio: 19 min → nada; 20 min → aviso; 31 min → gestor.
- Nível alto: 9 min → nada; 10 min → aviso; 15 min → gestor. Nível baixo: 59 min → nada; 60 min → aviso; 90 min → gestor.
- Cumprimento, agradecimento ou encerramento do cliente ("obrigado", "valeu", "ok") não inicia o relógio.
- Falha do classificador → tratada como médio.
- Reação, figurinha e foto ou documento sem legenda do cliente não iniciam o relógio.
- Resposta de texto ou áudio do time zera; reação, figurinha e "ok" não zeram "sem resposta".
- Mensagem do observador não conta como time.
- Sem contato: 23h59 → nada; 1 dia → aviso; 2 dias → gestor.
- Grupo inativo não gera alerta.
- Marcação à mão: resposta aos 2h59 encerra; 3h sem resposta volta em nível gestor com o aviso; desfazer.
- Retorno: vence → gestor direto; mensagem do time depois da promessa → cumprida.
- Mensagem duplicada e mensagens fora de ordem não mudam o resultado.
- Virada de dia e fuso `America/Sao_Paulo`.
- Mesmo alerta não gera aviso repetido a cada minuto.

## Perguntas em aberto

- Tempo corrido ou horário comercial? (Ju decide; começar corrido, parametrizado.)
- Promessa cumprida por qualquer mensagem do time ou só a que trata do assunto? (Começar com qualquer uma.)
- Grupo novo que nunca teve mensagem do time: "sem contato" conta desde quando? Sugestão: desde a entrada do observador no grupo. Confirmar com a Ju.
- Várias mensagens do cliente pendentes com níveis diferentes: qual relógio vale? Sugestão: cada uma corre no seu prazo e o alerta mostra o mais grave. Confirmar com a Ju.

## Operação durante o piloto (máquina local)

- O webhook não tenta de novo: **máquina dormindo ou sem internet = eventos perdidos.** Desligar suspensão automática e contar com a reconciliação do passo 5 ao religar.
- O túnel precisa de hostname fixo. URL que muda a cada reinício quebra o webhook em silêncio.
- O celular do chip observador fica carregado, com internet, e ninguém abre o WhatsApp nele.
- Entrada nos grupos em lotes pequenos, ao longo de dias, com um administrador de cada grupo adicionando o número. Aviso de LGPD enviado no grupo antes: o número "Grupo Silva | Qualidade" está ali para garantir o tempo de resposta.
- Plano B: segundo chip aquecido, já nos mesmos grupos, em outra instância com o webhook desligado. Se o principal cair, ligar o webhook do reserva.

## Convenções

- TypeScript estrito, testes com vitest, funções de regra puras (sem I/O) para testar sem banco.
- Tabelas e campos de domínio em português, como na especificação; comentários em português.
- Migrations versionadas; nada de alterar o banco à mão.
- Pull request pequeno por passo da ordem de construção.
- Identidade visual do painel: fundo preto, verde-limão `#C8E000`, vermelho `#FF5A4F` (gestor), âmbar `#FFB020` (aviso), Anton, Archivo e IBM Plex Mono. Mudanças de tela no `frontend/index.html` mantêm essas cores e fontes.
