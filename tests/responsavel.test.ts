import { describe, expect, it } from 'vitest';
import {
  decidirResponsavel,
  especialistasPorInstancia,
  planejarResponsaveis,
  semVarreduraRecente,
  type EntradaResponsaveis,
  type Especialista,
  type GrupoResponsavel,
  type MembroResponsavel,
} from '../src/conversas/responsavel.js';

const H = 3600_000;
const AGORA = Date.parse('2026-10-23T15:00:00Z');
const ha = (horas: number) => new Date(AGORA - horas * H).toISOString();

const ANA: Especialista = { nome: 'Ana', instancia: 'ana', gestor: 'Julia' };
const BRUNO: Especialista = { nome: 'Bruno', instancia: 'bruno', gestor: null };
const CAIO: Especialista = { nome: 'Caio', instancia: 'caio', gestor: 'Julia' };

const grupo = (o: Partial<GrupoResponsavel> = {}): GrupoResponsavel => ({
  jid: '1@g.us',
  especialista: 'Ana',
  gestor: 'Julia',
  principal_definido_em: null,
  ...o,
});
const definido = (o: Partial<GrupoResponsavel> = {}) => grupo({ principal_definido_em: ha(100), ...o });

describe('decidirResponsavel: grupo provisório (cadastro automático)', () => {
  it('0 especialistas: mantém', () => expect(decidirResponsavel(grupo(), [])).toEqual({ acao: 'manter' }));
  it('1 especialista que já é o dono: mantém', () => expect(decidirResponsavel(grupo(), [ANA])).toEqual({ acao: 'manter' }));
  it('1 especialista diferente: troca sozinho', () =>
    expect(decidirResponsavel(grupo(), [BRUNO])).toEqual({ acao: 'trocar', para: BRUNO }));
  it('dono sem especialista (nulo) e 1 presente: troca', () =>
    expect(decidirResponsavel(grupo({ especialista: null }), [BRUNO])).toMatchObject({ acao: 'trocar' }));
  it('2 ou mais (mesmo com o dono entre eles): aguardando', () =>
    expect(decidirResponsavel(grupo(), [BRUNO, ANA])).toEqual({ acao: 'aguardando', especialistas: ['Ana', 'Bruno'] }));
});

describe('decidirResponsavel: grupo definido por pessoa', () => {
  it('dono presente: mantém, mesmo com outros no grupo', () =>
    expect(decidirResponsavel(definido(), [ANA, BRUNO, CAIO])).toEqual({ acao: 'manter' }));
  it('dono saiu e 0 especialistas: mantém (sem listar)', () =>
    expect(decidirResponsavel(definido(), [])).toEqual({ acao: 'manter' }));
  it('dono saiu e 1 especialista: sugere (nunca troca sozinho)', () =>
    expect(decidirResponsavel(definido(), [BRUNO])).toEqual({ acao: 'sugerir', para: BRUNO }));
  it('dono saiu e 2 ou mais: aguardando', () =>
    expect(decidirResponsavel(definido(), [CAIO, BRUNO])).toEqual({ acao: 'aguardando', especialistas: ['Bruno', 'Caio'] }));
});

const membro = (nome: string, instancia: string | null, funcao: MembroResponsavel['funcao'], gestor: string | null = null): MembroResponsavel => ({
  nome,
  instancia,
  gestor_padrao: gestor,
  funcao,
});
const TIME: MembroResponsavel[] = [
  membro('Ana', 'ana', 'especialista', 'Julia'),
  membro('Bruno', 'bruno', 'especialista'),
  membro('Julia', 'julia', 'gestor'),
  membro('Dani', null, 'especialista'), // sem instância: não tem como estar presente
  membro('Edu', 'edu', null), // sem função: não conta
];

describe('especialistasPorInstancia e semVarreduraRecente', () => {
  it('só funcao = especialista e com instância', () => {
    expect([...especialistasPorInstancia(TIME).keys()]).toEqual(['ana', 'bruno']);
  });

  it('instância sem varredura ou com varredura de mais de 24 h', () => {
    const esp = especialistasPorInstancia(TIME);
    expect(semVarreduraRecente(esp, [{ instancia: 'ana', concluida_em: ha(23) }, { instancia: 'bruno', concluida_em: ha(24.1) }], AGORA)).toEqual(['bruno']);
    expect(semVarreduraRecente(esp, [{ instancia: 'ana', concluida_em: ha(1) }], AGORA)).toEqual(['bruno']);
    expect(semVarreduraRecente(esp, [{ instancia: 'ana', concluida_em: ha(1) }, { instancia: 'bruno', concluida_em: ha(24) }], AGORA)).toEqual([]);
  });
});

describe('planejarResponsaveis', () => {
  const recentes = [
    { instancia: 'ana', concluida_em: ha(2) },
    { instancia: 'bruno', concluida_em: ha(3) },
  ];
  const entrada = (o: Partial<EntradaResponsaveis> = {}): EntradaResponsaveis => ({
    grupos: [
      grupo({ jid: 'a@g.us', especialista: 'Ana' }), // só Bruno presente: troca
      grupo({ jid: 'b@g.us', especialista: 'Ana' }), // Ana e Bruno: aguardando
      definido({ jid: 'c@g.us', especialista: 'Julia' }), // dono não é especialista, Bruno presente: sugere
      grupo({ jid: 'd@g.us', especialista: 'Ana' }), // só a gestora presente: mantém
    ],
    presencas: [
      { jid: 'a@g.us', instancia: 'bruno' },
      { jid: 'b@g.us', instancia: 'ana' },
      { jid: 'b@g.us', instancia: 'bruno' },
      { jid: 'c@g.us', instancia: 'bruno' },
      { jid: 'd@g.us', instancia: 'julia' },
      { jid: 'd@g.us', instancia: 'edu' },
    ],
    time: TIME,
    varreduras: recentes,
    agora: AGORA,
    ...o,
  });

  it('troca, sugere e aguarda; gestor fica o do grupo quando o novo não tem gestor padrão', () => {
    const p = planejarResponsaveis(entrada());
    expect(p.semVarreduraRecente).toEqual([]);
    expect(p.trocas).toEqual([{ jid: 'a@g.us', esperado: 'Ana', especialista: 'Bruno', gestor: 'Julia', instancia: 'bruno' }]);
    expect([p.sugeridas, p.aguardando]).toEqual([1, 1]);
  });

  it('lista dos aguardando: jid e especialistas presentes em ordem alfabética (só para o painel)', () => {
    const p = planejarResponsaveis(
      entrada({ presencas: [...entrada().presencas, { jid: 'e@g.us', instancia: 'bruno' }, { jid: 'e@g.us', instancia: 'ana' }], grupos: [...entrada().grupos, definido({ jid: 'e@g.us', especialista: 'Julia' })] }),
    );
    expect(p.aguardandoLista).toEqual([
      { jid: 'b@g.us', especialistas: ['Ana', 'Bruno'] },
      { jid: 'e@g.us', especialistas: ['Ana', 'Bruno'] },
    ]);
    expect(p.aguardando).toBe(p.aguardandoLista.length);
  });

  it('alguma instância de especialista sem varredura nas últimas 24 h: nada decidido e diz quais', () => {
    const p = planejarResponsaveis(entrada({ varreduras: [{ instancia: 'ana', concluida_em: ha(2) }] }));
    expect(p).toEqual({ trocas: [], sugeridas: 0, aguardando: 0, aguardandoLista: [], semVarreduraRecente: ['bruno'] });
  });
});
