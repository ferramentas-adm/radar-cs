# Descoberta uazapi — passo 1

Payloads reais do evento `messages` capturados em `eventos_brutos` com o observador no grupo interno de teste. Registrado em 21/10/2026.

Amostra: começou com 10 mensagens de grupo; a segunda rodada de `npm run descoberta:resumo` teve 14 eventos `messages`, todos de grupo; a terceira, 15 (mais um documento com legenda). Texto mascarado pelo receptor (`[texto omitido: N caracteres]`), então as conclusões sobre texto vêm do tamanho (`N`) e das chaves, nunca do conteúdo.

## Quem enviou: `sender` é LID

- `sender` chega como `@lid` nos grupos, não como número.
- O número real vem em `sender_pn`: veio em 14 de 14 eventos, sempre `...@s.whatsapp.net`.
- Há também `sender_lid` (o mesmo `@lid`), em 14 de 14.

Consequência: a tabela `time` guarda `numero` (o `sender_pn`) e `lid` (o `sender_lid`). O normalizador identifica o autor pelo número e, se algum dia `sender_pn` faltar, cai para o LID. Os identificadores são strings opacas: guardar com o sufixo (`@s.whatsapp.net`, `@lid`).

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

## Onde fica cada coisa

- **`text` e `content`.** Em `Conversation`, `content` é string (o próprio texto). Nos outros tipos, `content` é objeto com os dados da mídia ou da extensão (`contextInfo`, `URL`, `mimetype` etc.).
- **Legenda de foto:** chega em `content.caption` e é copiada para `message.text`. Numa `ImageMessage`, `text` com mais de 0 caracteres significa "foto com legenda"; foto sem legenda vem com `text` vazio.
- **Legenda de documento:** igual à da foto, em `content.caption` e copiada para `message.text`. Num `DocumentMessage`, `text` com mais de 0 caracteres significa "documento com legenda"; sem legenda, `text` vem vazio. Confirmado com um documento real no grupo de teste.
- **Resposta citada:** `quoted` é o `messageid` da mensagem citada (confirmado: os `quoted` preenchidos apontam para eventos que já temos). Resposta = `ExtendedTextMessage` com `quoted` preenchido. Nos outros tipos `quoted` veio vazio.
- **Áudio, figurinha e foto ou documento sem legenda** chegam com `text` vazio. O áudio vem sem transcrição: a transcrição é nossa (`/message/download` com `transcribe: true`).
- **Reação** traz o emoji em `text` (e em `content.text`; o alvo fica em `content.key`). Quem a separa de texto é o `messageType` `ReactionMessage`, não o `text`.
- `fromMe` vem `true` nas mensagens enviadas pelo próprio observador. Serve como segunda proteção para nunca contar o observador como time.

## Campos úteis do evento

`groupName`, `chatid`, `chatlid`, `messageid`, `senderName`, `sender_pn`, `sender_lid`, `messageTimestamp` (milissegundos), `mediaType`, `quoted`, `text`, `content.caption`.

## Regra de contagem que sai daqui

- **Contam:** `Conversation`, `ExtendedTextMessage`, `AudioMessage` e **foto ou documento com legenda** (`ImageMessage` ou `DocumentMessage` com `text` não vazio), que valem como mensagem de texto, para o cliente e para o time.
- **Ignorados:** `ReactionMessage`, `StickerMessage`, foto ou documento sem legenda e vídeo.
