# Radar CS — Grupo Silva

Sistema que lê os grupos de WhatsApp dos clientes e alerta sozinho quando um cliente fica **sem resposta**, **sem contato** ou com **retorno prometido vencido**. Hoje isso depende de varredura manual, e a varredura falha (já houve cliente com 9 dias sem contato depois de o time dizer que tinha feito).

Documentos de referência (copiar para `docs/` antes de começar):
- `docs/especificacao.pdf` — especificação original ("Radar CS: especificação para a Tecnologia")
- `docs/Radar CS.html` — primeiro protótipo visual (clientes fictícios). Referência histórica; o painel de verdade é o `frontend/index.html`.
- `docs/Radar CS.md` — texto do primeiro protótipo
- `docs/api-contract.md` — contrato da API que o painel lê (`GET /api/radar`, marcações). **O backend implementa este contrato; não mudar o formato sem mudar o painel.**
- `frontend/index.html` — painel pronto, página única. Sem configuração abre em modo demonstração (clientes fictícios, tempo simulado). Com `window.RADAR_CONFIG = { modo: 'api', apiBase: '/api' }` lê a API real. Modo TV: `#tv` ou tecla T.
- `frontend/tests/engine-demo.test.mjs` — 23 casos de limite das regras (19/20/31 min, 23h59/24h/48h, 2h59/3h, retorno vencido). O motor real do passo 4 deve passar nos mesmos casos.

Se este arquivo e a especificação divergirem, vale este arquivo (ele já incorpora a decisão pela uazapi). Dúvida de regra de negócio: perguntar à Ju antes de decidir.

## Decisões já tomadas

- **WhatsApp:** uazapi (plano com 100 instâncias). Substitui "Evolution ou Z-API" da especificação.
- **Número observador:** chip já aquecido, WhatsApp comum (não Business), perfil "Grupo Silva | Qualidade". Já foi usado em atendimento, parado há semanas. Só lê. Nunca envia, nunca é admin, ninguém conversa por ele.
- **Banco:** Supabase (Postgres).
- **Backend:** um serviço Node.js + TypeScript com três partes: receptor do webhook, motor de regras (a cada minuto) e job da IA (a cada hora).
- **IA dos retornos:** API da Anthropic, modelo Claude Haiku (`claude-haiku-5-5`; confirmar a string atual em https://docs.claude.com).
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
- Áudio: `POST /message/download` com `transcribe: true` transcreve (precisa de credencial configurada). Fora do escopo inicial.
- IDs (`id`, `messageid`, JIDs) são strings opacas. Não remover sufixos (`@g.us`, `@s.whatsapp.net`, `@lid`).

**Ainda não sabemos (descobrir com payloads reais no grupo de teste, ver passo 1):**
- Se `sender` em grupo chega como número (`...@s.whatsapp.net`) ou como `@lid`. Se vier LID, a tabela `time` precisa guardar os dois identificadores.
- Os valores de `messageType` para áudio, reação, figurinha e resposta citada.

## Modelo de dados (Supabase)

Nomes como na especificação.

- `grupos`: `id_grupo` (pk), `cliente`, `especialista`, `gestor`, `ativo` (bool). Preenchida pelo CS.
- `time`: `numero` (e, se necessário, `lid`), `nome`. Quem não está nela é cliente.
- `mensagens`: `id_mensagem` (unique, = `messageid`), `id_grupo`, `autor_numero`, `autor_tipo` (`time`|`cliente`), `tipo` (texto, audio, reacao, figurinha, outro), `texto` (áudio: só a marca), `enviada_em`. Índice em `(id_grupo, enviada_em desc)`.
- `promessas`: `id`, `id_grupo`, `especialista`, `promessa`, `prazo`, `criada_em`, `status` (`aberta`|`cumprida`), `id_mensagem_origem`.
- `marcacoes`: histórico de "Resolvi por fora" (nunca apagar): `id`, `id_grupo`, `marcado_por`, `como` (`ligacao`|`privado`|`reuniao`), `marcado_em`, `encerrada_em`, `encerrada_por` (`mensagem_no_grupo`|`desfeita`|`expirou`).
- `eventos_brutos`: payloads (sem o `token`) só durante a fase de descoberta. Remover depois.
- `avisos_enviados`: `(id_grupo, tipo, nivel, episodio)` único, para não reenviar o mesmo aviso a cada minuto.
- `sync_estado`: última mensagem recebida, último status de conexão da instância.

RLS ligado em tudo. O backend usa a service role; o painel nunca fala direto com o banco.

## Regras dos alertas (recalcular cada grupo a cada minuto)

| Situação | Como medir | Aviso ao especialista | Sobe ao gestor |
|---|---|---|---|
| Sem resposta | última mensagem do grupo é do cliente; tempo desde ela | 20 min | 31 min |
| Sem contato | tempo desde a última mensagem do time | 1 dia | 2 dias |
| Retorno vencido | promessa aberta passou do prazo | não tem | assim que vence |

- Uma mensagem do time zera "sem resposta" e "sem contato" na hora.
- Tempo corrido, 24h por dia. **Parametrizar** para poder virar horário comercial (ex.: 8h–20h, seg–sáb) sem reescrever; a Ju decide antes de ligar para valer.
- Reação com emoji, figurinha ou "ok" do time **não** zera "sem resposta". Precisa ser texto ou áudio.
- Áudio do time conta como resposta.
- Grupos com `ativo = não` saem do radar.

## "Resolvi por fora"

1. No alerta, o especialista escolhe: ligação, privado ou reunião.
2. Grava cliente, quem marcou, como, data e hora.
3. O alerta sai de "Agir agora" e vai para "Resolvidos por fora", com o horário em que volta.
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

- Especialista: aviso de 20 min sem resposta e de 1 dia sem contato (notificação do sistema interno ou e-mail).
- Gestor: tudo que sobe (31 min, 2 dias, retorno vencido, marcação à mão que voltou).
- Ju: resumo diário às 18h por e-mail, totais do dia por especialista.
- **Nunca por WhatsApp**, para não pôr os números em risco.

## Ordem de construção

Cada passo termina com testes passando e algo que dá para ver funcionando.

**Painel primeiro (feito).** `frontend/index.html` + `docs/api-contract.md`. Dá para mostrar ao líder hoje, em modo demonstração. Cada passo abaixo que alimentar o painel deve fazê-lo pelo contrato, e o painel real vai ganhando vida sem mudar de tela: passo 4 = motor real; passo 6 = `POST/DELETE /api/marcacoes`; passo 8 = `GET /api/radar`.

0. **Base:** repositório, projeto Supabase, migrations em `supabase/migrations`, `.env.example`, vitest, tipagem estrita.
1. **Receptor do webhook + captura.** `POST /hooks/whatsapp/<segredo>`: valida, responde 200, grava o payload (sem `token`) em `eventos_brutos`. Teste com o observador num **grupo interno de teste**: texto, áudio, reação, figurinha, resposta citada, de pessoas diferentes. Resultado: resolver as duas dúvidas da seção uazapi.
2. **Script de grupos.** Lista os grupos da instância e gera um CSV (`id_grupo`, nome) para o CS preencher especialista, gestor e ativo; depois importa em `grupos`. Idem para `time`.
3. **Normalizador** payload → `mensagens` (autor_tipo, tipo, dedupe por `messageid`, ms → timestamptz).
4. **Motor de regras como função pura** (recebe mensagens, grupos, marcações, promessas, `agora`; devolve alertas) + agendador de 1 minuto.
5. **Reconciliação e saúde.** Ao subir e a cada poucos minutos, buscar via `/message/find` o que faltou desde a última mensagem recebida. Monitorar `/instance/status`: se a sessão cair, avisar o gestor (um painel que parece "tudo em dia" com o observador desconectado é pior que nenhum painel).
6. **Resolvi por fora.**
7. **IA dos retornos.**
8. **`GET /api/radar` conforme `docs/api-contract.md`** (monta a resposta a partir do motor, das marcações, das promessas e do estado do observador), servir o `frontend/index.html` com `RADAR_CONFIG`, avisos e resumo das 18h. Conferir o painel contra a API com dados reais, incluindo a faixa vermelha quando o observador cai.
9. **Deploy na Hostinger** e troca do túnel pela URL definitiva do webhook.

## Casos de teste do motor (mínimo)

- Mensagem do cliente: 19 min → nada; 20 min → aviso; 31 min → gestor.
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
- `sender` vem como número ou LID? Quais são os `messageType`? (Passo 1.)

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
