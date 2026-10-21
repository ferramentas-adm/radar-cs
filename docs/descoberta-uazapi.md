# Descoberta uazapi — passo 1

Payloads reais do evento `messages` capturados em `eventos_brutos` com o observador no grupo interno de teste. Registrado em 21/10/2026.

Amostra: 10 mensagens de grupo.

## Quem enviou: `sender` é LID

- `sender` chega como `@lid` nos grupos, não como número.
- O número real vem em `sender_pn` (`...@s.whatsapp.net`).
- Há também `sender_lid` (o mesmo `@lid`).
- Na amostra, as 10 mensagens traziam os três campos (`sender`, `sender_pn`, `sender_lid`).

Consequência: a tabela `time` guarda `numero` (o `sender_pn`) e `lid` (o `sender_lid`). O normalizador identifica o autor pelo número quando houver e cai para o LID quando não houver. Os identificadores são strings opacas: guardar com o sufixo (`@s.whatsapp.net`, `@lid`).

## `messageType` observados

| `messageType` | O que é |
|---|---|
| `Conversation` | texto simples |
| `ExtendedTextMessage` | texto com extras (resposta citada, link) |
| `AudioMessage` | áudio |
| `ImageMessage` | foto |
| `DocumentMessage` | documento |
| `StickerMessage` | figurinha |
| `ReactionMessage` | reação com emoji |

Vídeo não apareceu na amostra (o nome esperado é `VideoMessage`; confirmar quando aparecer).

## Outros fatos

- `fromMe` vem `true` nas mensagens enviadas pelo próprio observador. Serve como segunda proteção para nunca contar o observador como time.

## Campos úteis do evento

`groupName`, `chatid`, `chatlid`, `messageid`, `senderName`, `messageTimestamp` (milissegundos), `mediaType`, `quoted`.

## Regra de contagem que sai daqui

- **Contam:** `Conversation`, `ExtendedTextMessage`, `AudioMessage`.
- **Ignorados:** `ReactionMessage`, `StickerMessage`, `ImageMessage`, `DocumentMessage` e vídeo.
- A confirmar: mídia com legenda (foto ou documento com texto) conta como texto.

## Pendente

- Confirmar se `sender_pn` vem sempre (a amostra é pequena; se faltar, o autor é resolvido pelo `sender_lid`).
- Ver como `quoted` aparece preenchido numa resposta citada.
- Descobrir em qual campo chega a legenda de foto e de documento.
