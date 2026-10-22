import { describe, expect, it } from 'vitest';
import { jidDoGrupo, normalizarMensagem } from '../src/mensagens/normalizar.js';
import { GRUPO, NUMERO_CLIENTE, NUMERO_TIME, TEXTO, mensagemGrupo } from './fixtures/payloads.js';

const RONI = { nome: 'roni_ramos', tipo: 'pessoa' } as const;
const OBSERVADOR = { nome: 'observador', tipo: 'observador' } as const;
const RECEBIDO = '2026-10-22T12:00:00.000Z';
// Time com o número sem o nono dígito: o cadastro compara com e sem o 9.
const ehDoTime = (n: string) => n.replace(/^(\d{4})9(\d{8})$/, '$1$2') === '551177776666';
const normalizar = (sobre: Record<string, unknown> = {}, instancia: typeof RONI | typeof OBSERVADOR = RONI) =>
  normalizarMensagem(mensagemGrupo(sobre), instancia, ehDoTime, RECEBIDO);

describe('normalizarMensagem: autor', () => {
  it('cliente: sender_pn fora do time; número não é guardado', () => {
    expect(normalizar()).toEqual({
      id_mensagem: '3EB0BBBB0001',
      jid: GRUPO,
      instancia: 'roni_ramos',
      autor_tipo: 'cliente',
      autor_numero: null,
      tipo: 'texto',
      conta: true,
      texto: `[texto omitido: ${TEXTO.length} caracteres]`,
      enviada_em: new Date(1792512000000).toISOString(),
    });
  });

  it('time pelo sender_pn (com o nono dígito, cadastro sem): guarda o número só com dígitos', () => {
    const m = normalizar({ sender_pn: `${NUMERO_TIME}@s.whatsapp.net` });
    expect(m).toMatchObject({ autor_tipo: 'time', autor_numero: NUMERO_TIME });
  });

  it('time pelo fromMe na instância de uma pessoa, mesmo sem sender_pn', () => {
    expect(normalizar({ fromMe: true, sender_pn: undefined })).toMatchObject({ autor_tipo: 'time', autor_numero: null });
  });

  it('observador: fromMe nunca vira time (a mensagem nem é gravada)', () => {
    expect(normalizar({ fromMe: true }, OBSERVADOR)).toBeUndefined();
  });

  it('observador: mensagem de cliente e do time continua normal', () => {
    expect(normalizar({}, OBSERVADOR)?.autor_tipo).toBe('cliente');
    expect(normalizar({ sender_pn: `${NUMERO_TIME}@s.whatsapp.net` }, OBSERVADOR)?.autor_tipo).toBe('time');
  });

  it('sender_pn ausente e sem fromMe: cliente', () => {
    expect(normalizar({ sender_pn: undefined })?.autor_tipo).toBe('cliente');
  });
});

describe('normalizarMensagem: tipo e regra de contagem', () => {
  const casos: [string, string, string, boolean][] = [
    ['Conversation', TEXTO, 'texto', true],
    ['ExtendedTextMessage', 'resposta citada', 'texto', true],
    ['AudioMessage', '', 'audio', true],
    ['ImageMessage', 'foto com legenda', 'imagem', true],
    ['ImageMessage', '', 'imagem', false],
    ['DocumentMessage', 'segue o contrato', 'documento', true],
    ['DocumentMessage', '', 'documento', false],
    ['ReactionMessage', '👍', 'reacao', false],
    ['StickerMessage', '', 'figurinha', false],
    ['VideoMessage', 'vídeo com legenda', 'video', false],
    ['PollCreationMessage', 'enquete', 'outro', false],
  ];
  for (const [messageType, text, tipo, conta] of casos) {
    it(`${messageType}${text ? ' com texto' : ' sem texto'} → ${tipo}, ${conta ? 'conta' : 'não conta'}`, () => {
      expect(normalizar({ messageType, text })).toMatchObject({ tipo, conta });
    });
  }

  it('legenda só de espaços não conta', () => {
    expect(normalizar({ messageType: 'ImageMessage', text: '   ' })?.conta).toBe(false);
  });

  it('texto vazio fica nulo; nunca guarda o conteúdo', () => {
    expect(normalizar({ messageType: 'AudioMessage', text: '' })?.texto).toBeNull();
    expect(JSON.stringify(normalizar())).not.toContain(TEXTO);
  });
});

describe('normalizarMensagem: datas e descartes', () => {
  it('messageTimestamp em milissegundos → ISO UTC', () => {
    expect(normalizar({ messageTimestamp: Date.parse('2026-10-22T13:40:00-03:00') })?.enviada_em).toBe(
      '2026-10-22T16:40:00.000Z',
    );
  });

  it('sem messageTimestamp vale a hora do recebimento', () => {
    expect(normalizar({ messageTimestamp: undefined })?.enviada_em).toBe(RECEBIDO);
  });

  it('sem messageid, privado ou sem isGroup: não normaliza', () => {
    expect(normalizar({ messageid: '' })).toBeUndefined();
    expect(normalizar({ isGroup: false, chatid: `${NUMERO_CLIENTE}@s.whatsapp.net` })).toBeUndefined();
    expect(normalizar({ isGroup: false })).toBeUndefined();
  });

  it('mesma mensagem duas vezes (ou por duas instâncias): mesmo id_mensagem para o dedupe do banco', () => {
    expect(normalizar()?.id_mensagem).toBe(normalizar({}, OBSERVADOR)?.id_mensagem);
  });
});

describe('jidDoGrupo', () => {
  it('só eventos messages de grupo', () => {
    expect(jidDoGrupo(mensagemGrupo())).toBe(GRUPO);
    expect(jidDoGrupo({ ...mensagemGrupo(), EventType: 'messages_update' })).toBeUndefined();
    expect(jidDoGrupo({ EventType: 'connection' })).toBeUndefined();
    expect(jidDoGrupo(null)).toBeUndefined();
  });
});
