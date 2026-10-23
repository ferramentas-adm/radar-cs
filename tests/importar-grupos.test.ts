import { describe, expect, it } from 'vitest';
import { entrouEmParaIso, planejarGrupos, type EntradaGrupos, type GrupoBanco } from '../src/importar/grupos.js';

// Dados inventados.
const TIME = ['Ana Lima', 'Bruno', 'Gil'];
const AGORA = '2026-10-21T15:00:00.000Z';
const CAB = 'nome;jid;qtd_membros;time_no_grupo;especialista;gestor';

const entrada = (texto: string, extra: Partial<EntradaGrupos> = {}): EntradaGrupos => ({
  texto,
  time: TIME,
  existentes: [],
  instancia: 'roni_ramos',
  entrouEm: AGORA,
  entrouEmInformado: false,
  definidoEm: AGORA,
  ...extra,
});

describe('planejarGrupos', () => {
  it('importa só linhas com especialista E gestor; as outras contam como ignoradas', () => {
    const plano = planejarGrupos(
      entrada(
        `﻿${CAB}\r\n` +
          'Cliente Alfa;1@g.us;5;Ana Lima;Ana Lima;Gil\r\n' +
          'Cliente Beta;2@g.us;3;;Bruno;\r\n' + // sem gestor
          'Cliente Gama;3@g.us;3;;;Gil\r\n' + // sem especialista
          'Cliente Delta;4@g.us;3;;;\r\n',
      ),
    );
    expect([plano.novos, plano.ignorados, plano.erros.length]).toEqual([1, 3, 0]);
    expect(plano.gravar).toEqual([
      {
        jid: '1@g.us',
        nome: 'Cliente Alfa',
        especialista: 'Ana Lima',
        gestor: 'Gil',
        instancia: 'roni_ramos',
        observador_entrou_em: AGORA,
        principal_definido_em: AGORA,
      },
    ]);
  });

  it('vírgula como separador e aspas (Google Planilhas)', () => {
    const plano = planejarGrupos(
      entrada('nome,jid,qtd_membros,time_no_grupo,especialista,gestor\n"Cliente, Matriz",1@g.us,5,"Ana Lima, Gil",ana lima,GIL\n'),
    );
    expect(plano.erros).toEqual([]);
    expect(plano.gravar[0]).toMatchObject({ nome: 'Cliente, Matriz', especialista: 'Ana Lima', gestor: 'Gil' });
  });

  it('recusa especialista ou gestor fora do time, com o número da linha e sem dados do cliente', () => {
    const plano = planejarGrupos(
      entrada(
        `${CAB}\nCliente Alfa;1@g.us;5;;Zeca;Gil\nCliente Beta;2@g.us;5;;Ana Lima;Xuxa\nCliente Gama;3@g.us;5;;Zeca;Xuxa\n`,
      ),
    );
    expect(plano.erros).toEqual([
      'linha 2: especialista não está no time',
      'linha 3: gestor não está no time',
      'linha 4: especialista e gestor não estão no time',
    ]);
    expect(plano.gravar).toEqual([]);
    const tudo = plano.erros.join(' ');
    for (const proibido of ['Cliente', '@g.us', 'Zeca', 'Xuxa']) expect(tudo).not.toContain(proibido);
  });

  it('recusa jid inválido e jid repetido', () => {
    const plano = planejarGrupos(
      entrada(`${CAB}\nA;5511999@s.whatsapp.net;1;;Bruno;Gil\nB;1@g.us;1;;Bruno;Gil\nC;1@g.us;1;;Bruno;Gil\n`),
    );
    expect(plano.erros).toEqual(['linha 2: jid vazio ou que não é de grupo', 'linha 4: jid repetido no arquivo']);
    expect(plano.novos).toBe(1);
  });

  it('reimportação: não apaga o que já estava e não muda observador_entrou_em', () => {
    const existentes: GrupoBanco[] = [
      {
        jid: '1@g.us',
        nome: 'Cliente Alfa',
        especialista: 'Ana Lima',
        gestor: 'Gil',
        instancia: 'roni_ramos',
        observador_entrou_em: '2026-10-01T03:00:00.000Z',
        principal_definido_em: '2026-10-01T03:00:00.000Z',
      },
      {
        jid: '2@g.us',
        nome: 'Cliente Beta',
        especialista: 'Bruno',
        gestor: 'Gil',
        instancia: 'roni_ramos',
        observador_entrou_em: '2026-10-02T03:00:00.000Z',
        principal_definido_em: '2026-10-02T03:00:00.000Z',
      },
    ];
    const plano = planejarGrupos(
      entrada(
        `${CAB}\n` +
          ';1@g.us;5;;Bruno;Gil\n' + // nome vazio no CSV: mantém o do banco; troca o especialista
          'Cliente Beta;2@g.us;3;;Bruno;Gil\n' + // igual ao banco
          'Cliente Beta;2@g.us;3;;;\n', // linha sem especialista/gestor: ignorada, nada apagado
        { existentes, entrouEm: '2026-09-01T03:00:00.000Z', entrouEmInformado: true },
      ),
    );
    expect([plano.novos, plano.atualizados, plano.semMudanca, plano.ignorados]).toEqual([0, 1, 1, 1]);
    expect(plano.entrouEmIgnorado).toBe(2);
    expect(plano.gravar).toEqual([
      {
        jid: '1@g.us',
        nome: 'Cliente Alfa',
        especialista: 'Bruno',
        gestor: 'Gil',
        instancia: 'roni_ramos',
        observador_entrou_em: '2026-10-01T03:00:00.000Z',
        principal_definido_em: AGORA, // trocou o especialista: nova definição
      },
    ]);
  });

  it('grupo provisório (cadastro automático) confirmado pelo CSV passa a ser definido por pessoa', () => {
    const atual: GrupoBanco = {
      jid: '1@g.us',
      nome: 'Cliente Alfa',
      especialista: 'Bruno',
      gestor: 'Gil',
      instancia: 'roni_ramos',
      observador_entrou_em: '2026-10-01T03:00:00.000Z',
      principal_definido_em: null,
    };
    const plano = planejarGrupos(entrada(`${CAB}\nCliente Alfa;1@g.us;5;;Bruno;Gil\n`, { existentes: [atual] }));
    expect(plano.atualizados).toBe(1);
    expect(plano.gravar).toEqual([{ ...atual, principal_definido_em: AGORA }]);
  });

  it('cabeçalho sem as colunas obrigatórias', () => {
    expect(planejarGrupos(entrada('nome;jid\nA;1@g.us\n')).erros).toEqual([
      'cabeçalho: faltam as colunas especialista, gestor',
    ]);
  });
});

describe('entrouEmParaIso (--entrou-em)', () => {
  const agora = new Date('2026-10-21T15:00:00Z'); // 12h em São Paulo

  it('meia-noite em America/Sao_Paulo', () => {
    expect(entrouEmParaIso('2026-10-01', agora)).toBe('2026-10-01T03:00:00.000Z');
    expect(entrouEmParaIso('2026-10-21', agora)).toBe('2026-10-21T03:00:00.000Z'); // hoje vale
  });

  it('respeita o horário de verão de datas antigas', () => {
    expect(entrouEmParaIso('2018-12-01', agora)).toBe('2018-12-01T02:00:00.000Z');
  });

  it('recusa formato inválido e data que não existe', () => {
    for (const d of ['01/10/2026', '2026-1-5', '2026-02-30', 'ontem', '']) {
      expect(() => entrouEmParaIso(d, agora)).toThrow('AAAA-MM-DD');
    }
  });

  it('recusa data no futuro (considera o dia em São Paulo)', () => {
    expect(() => entrouEmParaIso('2026-10-22', agora)).toThrow('futuro');
    // 22h de 21/10 em São Paulo já é 22/10 em UTC: 22/10 ainda é futuro.
    expect(() => entrouEmParaIso('2026-10-22', new Date('2026-10-22T01:00:00Z'))).toThrow('futuro');
  });
});
