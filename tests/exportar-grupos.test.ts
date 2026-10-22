import { describe, expect, it } from 'vitest';
import {
  buscarTodosGrupos,
  chaveTelefone,
  escolherInstancia,
  gerarCsv,
  lerTimeCsv,
  montarLinhas,
  resumo,
} from '../src/grupos/exportar.js';
import { ClienteUazapi, type Grupo } from '../src/uazapi/cliente.js';

// Payload falso do POST /group/list (formato da documentação), em duas páginas.
const PAGINA_1 = {
  groups: [
    {
      JID: '120363000000000001@g.us',
      Name: 'Cliente Alfa; Matriz',
      ParticipantCount: 3,
      Participants: [
        { JID: '111@lid', LID: '111@lid', PhoneNumber: '5511988887777@s.whatsapp.net' }, // Ana, com o 9
        { JID: '222@lid', LID: '222@lid', PhoneNumber: '551133334444@s.whatsapp.net' }, // cliente
        { JID: '333@lid', LID: '333@lid' }, // sem PhoneNumber
      ],
    },
    {
      JID: '120363000000000002@g.us',
      Name: '=HYPERLINK("x")',
      ParticipantCount: 2,
      Participants: [
        { JID: '551177776666@s.whatsapp.net' }, // Bruno, sem o 9 e sem PhoneNumber
        { JID: '444@lid', PhoneNumber: '5511988887777' }, // Ana de novo
      ],
    },
  ],
  pagination: { totalRecords: 3, limit: 1000, offset: 0, hasMore: true, nextOffset: 2 },
};
const PAGINA_2 = {
  groups: [{ JID: '120363000000000003@g.us', Name: 'Cliente Gama', ParticipantCount: 1, Participants: [] }],
  pagination: { totalRecords: 3, limit: 1000, offset: 2, hasMore: false, nextOffset: 3 },
};

const TIME_CSV = '﻿nome;numero\r\nAna;5511988887777\r\nBruno;5511977776666\r\n';

function fetchFalso(respostas: Response[]) {
  const corpos: unknown[] = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    corpos.push(JSON.parse(String(init?.body)));
    const r = respostas.shift();
    if (!r) throw new Error('chamada a mais');
    return r;
  }) as typeof fetch;
  return { fn, corpos };
}

const json = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200 });
const semEspera = async () => {};

describe('buscarTodosGrupos', () => {
  it('pagina com limit 1000 e noParticipants false até hasMore = false', async () => {
    const { fn, corpos } = fetchFalso([json(PAGINA_1), json(PAGINA_2)]);
    const grupos = await buscarTodosGrupos(new ClienteUazapi('https://uazapi.teste', 'tk', fn), semEspera);
    expect(grupos.map((g) => g.JID)).toHaveLength(3);
    expect(corpos).toEqual([
      { limit: 1000, offset: 0, noParticipants: false },
      { limit: 1000, offset: 2, noParticipants: false },
    ]);
  });

  it('tenta de novo em 408 e 429 (respeitando Retry-After)', async () => {
    const esperas: number[] = [];
    const { fn } = fetchFalso([
      new Response('', { status: 429, headers: { 'retry-after': '5' } }),
      new Response('', { status: 408 }),
      json(PAGINA_2),
    ]);
    const grupos = await buscarTodosGrupos(new ClienteUazapi('https://u.t', 'tk', fn), async (ms) => {
      esperas.push(ms);
    });
    expect(grupos).toHaveLength(1);
    expect(esperas).toEqual([5000, 4000]);
  });

  it('desiste depois de 3 novas tentativas e não tenta de novo em outros erros', async () => {
    const erros = () => Array.from({ length: 4 }, () => new Response('', { status: 408 }));
    await expect(
      buscarTodosGrupos(new ClienteUazapi('https://u.t', 'tk', fetchFalso(erros()).fn), semEspera),
    ).rejects.toThrow('HTTP 408');
    const { fn, corpos } = fetchFalso([new Response('', { status: 500 })]);
    await expect(buscarTodosGrupos(new ClienteUazapi('https://u.t', 'tk', fn), semEspera)).rejects.toThrow(
      'HTTP 500',
    );
    expect(corpos).toHaveLength(1);
  });

  it('para se nextOffset não avança', async () => {
    const travada = { groups: [], pagination: { hasMore: true, nextOffset: 0 } };
    const { fn } = fetchFalso([json(travada)]);
    await expect(buscarTodosGrupos(new ClienteUazapi('https://u.t', 'tk', fn), semEspera)).rejects.toThrow(
      'nextOffset',
    );
  });
});

describe('chaveTelefone', () => {
  it('ignora sufixo e o nono dígito do celular brasileiro', () => {
    expect(chaveTelefone('5511988887777@s.whatsapp.net')).toBe('551188887777');
    expect(chaveTelefone('551188887777')).toBe('551188887777');
    expect(chaveTelefone('+55 (11) 98888-7777')).toBe('551188887777');
    expect(chaveTelefone('551133334444')).toBe('551133334444'); // fixo, 12 dígitos: fica igual
  });
});

describe('lerTimeCsv', () => {
  it('lê nome;numero com BOM e CRLF', () => {
    expect(lerTimeCsv(TIME_CSV)).toEqual([
      { nome: 'Ana', numero: '5511988887777' },
      { nome: 'Bruno', numero: '5511977776666' },
    ]);
  });

  it('recusa cabeçalho errado', () => {
    expect(() => lerTimeCsv('nome,numero\nAna,5511988887777')).toThrow('nome;numero');
  });
});

describe('montarLinhas e gerarCsv', () => {
  const grupos = [...PAGINA_1.groups, ...PAGINA_2.groups] as Grupo[];
  const linhas = montarLinhas(grupos, lerTimeCsv(TIME_CSV));

  it('cruza o time pelo número (com e sem o 9, PhoneNumber ou JID)', () => {
    expect(linhas.map((l) => l.time_no_grupo)).toEqual(['Ana', 'Bruno, Ana', '']);
    expect(linhas.map((l) => l.qtd_membros)).toEqual([3, 2, 1]);
    expect(linhas.every((l) => l.especialista === '' && l.gestor === '')).toBe(true);
  });

  it('sem time.csv, time_no_grupo sai vazio', () => {
    expect(montarLinhas(grupos, []).every((l) => l.time_no_grupo === '')).toBe(true);
  });

  it('CSV para o Excel: BOM, ponto e vírgula, CRLF, aspas e proteção contra fórmula', () => {
    const csv = gerarCsv(linhas);
    expect(csv.startsWith('﻿nome;jid;qtd_membros;time_no_grupo;especialista;gestor\r\n')).toBe(true);
    const corpo = csv.slice(1).split('\r\n');
    expect(corpo[1]).toBe('"Cliente Alfa; Matriz";120363000000000001@g.us;3;Ana;;');
    expect(corpo[2]).toBe(`"'=HYPERLINK(""x"")";120363000000000002@g.us;2;Bruno, Ana;;`);
    expect(corpo[3]).toBe('Cliente Gama;120363000000000003@g.us;1;;;');
  });

  it('o resumo do terminal só tem contagens', () => {
    const s = resumo(linhas, true);
    expect(s).toBe('grupos: 3 · com alguém do time: 2');
    for (const proibido of ['Cliente', 'Ana', 'Bruno', '5511', '@g.us']) expect(s).not.toContain(proibido);
    expect(resumo(linhas, false)).toContain('var/time.csv não encontrado');
  });
});

describe('escolherInstancia', () => {
  const env = {
    UAZAPI_BASE_URL: 'https://uazapi.teste/',
    UAZAPI_INSTANCE_TOKEN: 'token-padrao-secreto',
    UAZAPI_TOKEN_ANA: 'token-ana-secreto',
  };
  const argv = (...a: string[]) => ['node', 'exportar-grupos.ts', ...a];

  it('sem --instancia: UAZAPI_INSTANCE_TOKEN e grupos.csv', () => {
    expect(escolherInstancia(argv(), env)).toEqual({
      baseUrl: 'https://uazapi.teste',
      token: 'token-padrao-secreto',
      arquivo: 'grupos.csv',
      variavelToken: 'UAZAPI_INSTANCE_TOKEN',
    });
  });

  it('com --instancia ana: UAZAPI_TOKEN_ANA e grupos-ana.csv (aceita maiúsculas no argumento)', () => {
    for (const nome of ['ana', 'Ana']) {
      expect(escolherInstancia(argv('--instancia', nome, '--sobrescrever'), env)).toEqual({
        baseUrl: 'https://uazapi.teste',
        token: 'token-ana-secreto',
        arquivo: 'grupos-ana.csv',
        variavelToken: 'UAZAPI_TOKEN_ANA',
      });
    }
  });

  it('variável da instância ausente: erro com o nome da variável, sem valores', () => {
    const erro = () => escolherInstancia(argv('--instancia', 'bruno'), env);
    expect(erro).toThrow('Falta UAZAPI_TOKEN_BRUNO no .env.');
    try {
      erro();
    } catch (e) {
      for (const v of Object.values(env)) expect((e as Error).message).not.toContain(v);
    }
  });

  it('recusa nome vazio, outra opção no lugar do nome e caminhos', () => {
    expect(() => escolherInstancia(argv('--instancia'), env)).toThrow('--instancia NOME');
    expect(() => escolherInstancia(argv('--instancia', '--sobrescrever'), env)).toThrow('--instancia NOME');
    expect(() => escolherInstancia(argv('--instancia', '../x'), env)).toThrow('só pode ter');
    expect(() => escolherInstancia(argv('--instancia', 'ana-2'), env)).toThrow('só pode ter');
  });

  it('sem UAZAPI_BASE_URL: erro claro', () => {
    expect(() => escolherInstancia(argv(), { UAZAPI_INSTANCE_TOKEN: 'x' })).toThrow('UAZAPI_BASE_URL');
  });
});
