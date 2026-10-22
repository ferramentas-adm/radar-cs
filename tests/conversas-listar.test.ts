import { describe, expect, it } from 'vitest';
import { gerarCsvConversas, lerId, resumoConversas, type ConversaBanco } from '../src/conversas/listar.js';

const conversas: ConversaBanco[] = [
  { id: 1, tipo: 'grupo', nome: '=Cliente; A', especialista: 'Roni Ramos', gestor: 'Gestora', instancia: 'roni_ramos', origem: 'importado', ativo: true },
  { id: 2, tipo: 'privada', nome: null, especialista: 'Roni Ramos', gestor: null, instancia: 'roni_ramos', origem: 'automatico', ativo: false },
];

describe('gerarCsvConversas', () => {
  it('id, tipo, nome e responsáveis; sem JID; privada sem nome; fórmula neutralizada', () => {
    const csv = gerarCsvConversas(conversas);
    expect(csv.startsWith('\uFEFFid;tipo;nome;especialista;gestor;instancia;origem;ativo\r\n')).toBe(true);
    expect(csv).toContain(`1;grupo;"'=Cliente; A";Roni Ramos;Gestora;roni_ramos;importado;sim`);
    expect(csv).toContain('2;privada;;Roni Ramos;;roni_ramos;automatico;não');
    expect(csv).not.toMatch(/@g\.us|privada:/);
  });

  it('começa com o BOM (U+FEFF), para o Excel abrir em UTF-8', () => {
    const csv = gerarCsvConversas([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('resumo só com contagens', () => {
    expect(resumoConversas(conversas)).toBe(
      'conversas: 2 · grupos: 1 · privadas: 1 · cadastradas sozinhas: 1 · bloqueadas: 1',
    );
  });
});

describe('lerId', () => {
  it('inteiro positivo', () => {
    expect(lerId(['--id', '42'])).toBe(42);
    for (const argv of [[], ['--id'], ['--id', '0'], ['--id', '-1'], ['--id', '1.5'], ['--id', 'abc']]) {
      expect(() => lerId(argv)).toThrow('--id');
    }
  });
});
