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
