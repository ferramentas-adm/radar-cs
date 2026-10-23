# Radar CS — contrato da API do painel

O painel (`frontend/index.html`) é uma página única que só desenha o que a API devolve. Ele não calcula alerta nenhum quando está ligado ao backend: as regras (20/31 min, 1/2 dias, retorno vencido, 3 h da ação feita por fora) rodam no servidor, no motor do passo 4 do `CLAUDE.md`.

**Sobre os nomes:** na tela, o fluxo se chama "Registrar ação feita" (o especialista age primeiro e registra depois, com uma janela de confirmação), e a seção, "Ações feitas por fora". Os nomes técnicos deste contrato (`marcacoes`, `pode_marcar`, `resolvidos_por_fora`, `voltou_de_marcacao`) continuam os mesmos e não mudam.

Sem configuração, o painel abre em **modo demonstração**, com clientes fictícios e um motor de regras de brinquedo dentro da própria página. O formato dos dados da demonstração é exatamente o desta API, então trocar demo por backend não muda nada na tela.

## Como ligar o painel ao backend

O backend serve o `index.html` e injeta, antes do `<script>` do painel:

```html
<script>window.RADAR_CONFIG = { modo: 'api', apiBase: '/api', pollMs: 60000 };</script>
```

- `modo: 'api'` desliga a barra de demonstração e passa a ler `GET {apiBase}/radar`.
- `pollMs`: de quanto em quanto tempo consulta (60000 = a cada minuto, como na especificação).
- O painel manda cookies (`credentials: 'include'`). Login do Grupo Silva obrigatório; sem sessão a API responde `401`.
- Modo TV: abrir `index.html#tv`, ou o botão "Modo TV" (atalho: tecla T).

## Privacidade

Nenhum campo desta API carrega o texto das mensagens. O painel mostra o **motivo** do alerta, nunca o conteúdo da conversa. O texto das mensagens só existe nas tabelas, com RLS, para gestor e Ju.

**Conversas privadas** (do número corporativo de um especialista com um cliente) nunca aparecem como linha: não entram em `alertas`, `pendentes`, `resolvidos_por_fora`, `retornos`, `por_especialista[].clientes` nem no `resumo`. Elas aparecem só como contagens por especialista (`por_especialista[].conversas_privadas_*`), sem nome, número ou identificador do cliente.

## GET /api/radar

Resposta única, já calculada. Timestamps em ISO 8601 com offset (`-03:00` ou `Z`).

```json
{
  "gerado_em": "2026-10-20T15:40:12-03:00",
  "recursos": { "marcacoes": false, "promessas": false },
  "usuario": { "nome": "Camila Duarte", "pode_marcar": true },
  "observador": {
    "status": "conectado",
    "desde": null,
    "ultima_mensagem_em": "2026-10-20T15:39:41-03:00"
  },
  "resumo": {
    "clientes_total": 28,
    "em_alerta": 9,
    "em_alerta_gestor": 5,
    "sem_contato":   { "gestor": 2, "aviso": 3 },
    "sem_resposta":  { "gestor": 1, "aviso": 2 },
    "retornos_vencidos": 3
  },
  "alertas": [
    {
      "id_grupo": "120363040001000@g.us",
      "cliente": "Padaria Estrela do Sul",
      "especialista": "Camila Duarte",
      "gestor": "Marcos Leal",
      "nivel": "gestor",
      "motivos": [
        {
          "tipo": "sem_resposta",
          "nivel": "gestor",
          "desde": "2026-10-20T15:06:00-03:00",
          "aviso_em": "2026-10-20T15:26:00-03:00",
          "gestor_em": "2026-10-20T15:37:00-03:00"
        }
      ],
      "voltou_de_marcacao": null
    }
  ],
  "pendentes": [
    {
      "id_grupo": "120363040001000@g.us",
      "cliente": "Padaria Estrela do Sul",
      "especialista": "Camila Duarte",
      "quantidade": 4,
      "mais_antiga_desde": "2026-10-20T13:40:00-03:00",
      "estado": "gestor"
    }
  ],
  "resolvidos_por_fora": [
    {
      "id_grupo": "120363040001006@g.us",
      "cliente": "Distribuidora Pinheiro",
      "especialista": "Camila Duarte",
      "marcado_por": "Camila Duarte",
      "como": "ligacao",
      "marcado_em": "2026-10-20T14:30:00-03:00",
      "volta_em": "2026-10-20T17:30:00-03:00"
    }
  ],
  "por_especialista": [
    {
      "especialista": "Camila Duarte",
      "clientes": [
        { "id_grupo": "120363040001000@g.us", "cliente": "Padaria Estrela do Sul", "estado": "gestor" }
      ],
      "sem_contato": 0,
      "sem_resposta": 1,
      "retornos_vencidos": 0,
      "conversas_privadas_sem_resposta": 2,
      "conversas_privadas_7d": 5,
      "conversas_privadas_mes": 11
    }
  ],
  "retornos": [
    {
      "id": "p1",
      "id_grupo": "120363040001007@g.us",
      "cliente": "Agro Campos Verdes",
      "especialista": "Rafael Moura",
      "promessa": "Enviar laudo da safra",
      "prazo": "2026-10-19T14:40:00-03:00",
      "situacao": "vencido"
    }
  ]
}
```

### Campos

| Campo | Valores / regra |
|---|---|
| `recursos` | `{ marcacoes, promessas }`, booleanos: o que o backend já implementa. `false` (ou campo ausente) = ainda não existe, e o painel **esconde** a parte em vez de mostrar zero. `marcacoes: false` esconde a seção "Ações feitas por fora", a frase "Agiu por ligação, privado ou reunião? Depois de agir, registre a ação aqui", o botão "Registrar ação feita", o item "ação feita por fora" da legenda e a regra da ação feita por fora no rodapé. `promessas: false` esconde a seção "Retornos prometidos", o cartão "Retornos vencidos", a coluna "Retornos vencidos" da tabela por especialista e a regra do retorno vencido no rodapé. Hoje o backend manda os dois `false`; a demonstração do painel, os dois `true`. Com `false`, `resolvidos_por_fora` e `retornos` vêm `[]` e `retornos_vencidos` vem `0`. |
| `usuario.pode_marcar` | `true` mostra o botão "Registrar ação feita". Só especialistas e gestores. |
| `observador.status` | `conectado`, `conectando` ou `desconectado` (vem de `GET /instance/status` da uazapi). Qualquer valor diferente de `conectado` faz o painel mostrar a faixa vermelha de aviso e **nunca** "Tudo em dia". |
| `observador.desde` | Quando o status atual começou (usado na faixa de aviso). |
| `alertas[].nivel` | `aviso` (especialista) ou `gestor`. Se `voltou_de_marcacao` não for nulo, é sempre `gestor`. |
| `alertas[]` | Só grupos `ativo = sim`, fora de marcação válida. Ordem livre: o painel reordena por gravidade. |
| `motivos[].tipo` | `sem_resposta`, `sem_contato`, `retorno_vencido`. |
| `motivos[].desde` | `sem_resposta`: hora da última mensagem do cliente. `sem_contato`: hora da última mensagem do time. `retorno_vencido`: o prazo da promessa. |
| `motivos[].aviso_em` | Hora em que passou a limite de aviso (20 min / 1 dia). `null` em `retorno_vencido`. |
| `motivos[].gestor_em` | Hora em que sobe ao gestor (31 min / 2 dias / o próprio prazo). O painel usa `aviso_em`, `desde` e `gestor_em` para desenhar a barra "sobe ao gestor em …". |
| `motivos[].promessa` | Só em `retorno_vencido`: resumo da promessa (até 10 palavras, vem da IA). |
| `pendentes[]` | Ranking da "Pilha de mensagens": clientes com mensagens esperando resposta. Só grupos `ativo = sim`, com `quantidade >= 1`. **Já vem ordenado**: mais mensagens primeiro; em empate, a mais antiga primeiro. O painel mostra os 8 primeiros (5 no modo TV) e não reordena. Campo opcional: se faltar, o painel mostra "Nenhuma mensagem de cliente esperando resposta". |
| `pendentes[].quantidade` | Mensagens do cliente que exigem resposta (texto ou áudio, depois do filtro do classificador) enviadas **depois da última mensagem do time**. Não conta cumprimento, agradecimento nem encerramento. |
| `pendentes[].mais_antiga_desde` | Hora da mais antiga dessas mensagens. O painel mostra "há X" a partir dela. |
| `pendentes[].estado` | Só o "sem resposta" daquele grupo, pela mensagem pendente **mais antiga** (`mais_antiga_desde`): `ok` (no prazo, antes do aviso), `aviso` ou `gestor`, com os mesmos prazos e o mesmo tempo de expediente do motivo `sem_resposta`. **Não** considera "sem contato", retorno vencido nem marcação: o estado geral do grupo fica em `por_especialista[].clientes[].estado`. Define a cor da pilha e a coluna "Situação". Não carrega texto de mensagem. |
| `voltou_de_marcacao` | `{ como, marcado_por, marcado_em }` quando uma marcação à mão passou de 3 h sem mensagem do time no grupo. |
| `como` | `ligacao`, `privado` ou `reuniao`. |
| `por_especialista[].clientes[].estado` | `ok`, `aviso`, `gestor` ou `resolvido_por_fora`. Uma entrada por grupo ativo (conversa privada nunca entra). |
| `por_especialista[]` | Um item por especialista com grupo ativo **ou** com conversa privada ativa (quem só tem privadas vem com `clientes: []`). |
| `por_especialista[].conversas_privadas_sem_resposta` | Conversas privadas ativas do especialista (o dono da instância) em que o cliente escreveu e o time não respondeu depois, contando só as que já passaram do prazo de aviso (nível médio, 20 min em tempo de expediente, como nos grupos). Conta conversas, não mensagens. É acompanhamento: não entra em `resumo` nem em "clientes em alerta". |
| `por_especialista[].conversas_privadas_7d` | Conversas privadas ativas distintas com ao menos uma mensagem (qualquer tipo, de qualquer lado) nos últimos 7 × 24 h. |
| `por_especialista[].conversas_privadas_mes` | O mesmo, desde a meia-noite do dia 1 do mês corrente (`America/Sao_Paulo`). O painel mostra só como dica ao passar o mouse em "7 dias". |
| `conversas_privadas_*` ausente | O painel mostra "—" (nunca 0), para não afirmar zero com uma API que ainda não manda o campo. |
| `retornos[].situacao` | `vencido`, `vence_hoje` (até 6 h), `no_prazo`, `cumprido`. Incluir cumpridos só das últimas 24 h. |

### De onde vem cada coisa (tabelas do `CLAUDE.md`)

| Campo da API | Tabela |
|---|---|
| `cliente`, `especialista`, `gestor`, `id_grupo` | `grupos` |
| `motivos` (`sem_resposta`, `sem_contato`) | `mensagens` (última do cliente, última do time) |
| `retorno_vencido`, `retornos` | `promessas` |
| `pendentes` | `mensagens` (as do cliente depois da última do time, com `exige_resposta`) |
| `resolvidos_por_fora`, `voltou_de_marcacao` | `marcacoes` |
| `conversas_privadas_*` | `grupos` com `tipo = 'privada'` e `ativo`, mais `mensagens` (pendentes do cliente e última mensagem de cada conversa) |
| `observador` | `sync_estado` |

## POST /api/marcacoes

Corpo: `{ "id_grupo": "…@g.us", "como": "ligacao" }`.

| Resposta | Quando |
|---|---|
| `201` | Marcação gravada (quem marcou vem da sessão, nunca do corpo). |
| `403` | Usuário sem permissão de marcar. |
| `404` | Grupo inexistente ou inativo. |
| `409` | Já existe marcação válida para o grupo. |

Depois do `201` o painel chama `GET /api/radar` de novo.

## DELETE /api/marcacoes/{id_grupo}

Desfaz a marcação válida do grupo. `204` em sucesso. Só quem marcou, ou um gestor. A marcação continua no histórico com `encerrada_por = desfeita`.

## Erros

Qualquer resposta que não seja `2xx` em `GET /api/radar` faz o painel manter os últimos dados e mostrar a faixa "Radar sem conexão com o servidor". O painel nunca apaga a tela por erro de rede.
