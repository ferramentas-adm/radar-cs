// Payloads de exemplo no formato descrito na doc da uazapi (API 2.6.7).
// Trocar por payloads reais (sanitizados) depois do teste no grupo interno.

export const TOKEN = 'tok-instancia-SECRETO-0123456789';
export const SEGREDO = 'segredo-do-caminho-0123456789-abcdefghij';
export const TEXTO = 'Bom dia, vocês conseguem me mandar o boleto até amanhã?';

export function mensagemTexto(sobre: Record<string, unknown> = {}) {
  return {
    EventType: 'messages',
    instanceName: 'observador',
    token: TOKEN,
    owner: '5511900000000',
    message: {
      id: '5511900000000:3EB0AAAA0001',
      messageid: '3EB0AAAA0001',
      chatid: '120363040001000@g.us',
      sender: '5511988887777@s.whatsapp.net',
      senderName: 'Cliente Teste',
      fromMe: false,
      isGroup: true,
      messageType: 'Conversation',
      text: TEXTO,
      content: TEXTO,
      messageTimestamp: 1792512000000,
      ...sobre,
    },
    chat: { wa_chatid: '120363040001000@g.us', wa_lastMessageTextVote: TEXTO },
  };
}

export function mensagemCitada() {
  return mensagemTexto({
    messageid: '3EB0AAAA0002',
    messageType: 'ExtendedTextMessage',
    text: 'Segue o boleto',
    content: {
      text: 'Segue o boleto',
      contextInfo: { stanzaID: '3EB0AAAA0001', quotedMessage: { conversation: TEXTO } },
    },
  });
}

export function eventoConexao() {
  return { EventType: 'connection', instanceName: 'observador', token: TOKEN, instance: { status: 'connected' } };
}

// Formato real observado no passo 1 (docs/descoberta-uazapi.md): sender é @lid, número em sender_pn.
export const GRUPO = '120363040001000@g.us';
export const NUMERO_CLIENTE = '5511988887777';
export const NUMERO_TIME = '5511977776666';
export const TOKEN_RONI = 'tok-roni-SECRETO-9876543210';

// Conversa privada: formato suposto (ainda não confirmado com payload real), mesmos campos do grupo.
export const CHAT_PRIVADO = `${NUMERO_CLIENTE}@s.whatsapp.net`;
export const LID_CLIENTE = '222222222222222@lid';

export function mensagemPrivada(sobre: Record<string, unknown> = {}, token = TOKEN_RONI) {
  return {
    EventType: 'messages',
    instanceName: 'roni_ramos',
    token,
    message: {
      id: '5511977776666:3EB0CCCC0001',
      messageid: '3EB0CCCC0001',
      chatid: CHAT_PRIVADO,
      chatlid: LID_CLIENTE,
      sender: LID_CLIENTE,
      sender_pn: CHAT_PRIVADO,
      sender_lid: LID_CLIENTE,
      senderName: 'Contato Cliente',
      fromMe: false,
      isGroup: false,
      messageType: 'Conversation',
      mediaType: '',
      text: TEXTO,
      content: TEXTO,
      quoted: '',
      messageTimestamp: 1792512000000,
      ...sobre,
    },
  };
}

export function mensagemGrupo(sobre: Record<string, unknown> = {}, token = TOKEN_RONI) {
  return {
    EventType: 'messages',
    instanceName: 'roni_ramos',
    token,
    message: {
      id: '5511977776666:3EB0BBBB0001',
      messageid: '3EB0BBBB0001',
      chatid: GRUPO,
      chatlid: '120363040001000@lid',
      groupName: 'Cliente Teste | Grupo Silva',
      sender: '111111111111111@lid',
      sender_pn: `${NUMERO_CLIENTE}@s.whatsapp.net`,
      sender_lid: '111111111111111@lid',
      senderName: 'Cliente Teste',
      fromMe: false,
      isGroup: true,
      messageType: 'Conversation',
      mediaType: '',
      text: TEXTO,
      content: TEXTO,
      quoted: '',
      messageTimestamp: 1792512000000,
      ...sobre,
    },
  };
}
