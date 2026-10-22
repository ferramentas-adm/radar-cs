import { describe, expect, it } from 'vitest';
import { planejarTime, type MembroTimeBanco } from '../src/importar/time.js';

const m = (nome: string, numero: string, o: Partial<MembroTimeBanco> = {}): MembroTimeBanco => ({
  nome,
  numero,
  instancia: null,
  gestor_padrao: null,
  ...o,
});

describe('planejarTime', () => {
  it('novos, atualizados e sem mudança (nome sem diferenciar maiúsculas)', () => {
    const plano = planejarTime(
      '﻿nome;numero\r\nAna Lima;+55 (11) 98888-7777\r\nBRUNO;5511977776666\r\nCaio;5511966665555\r\n',
      [m('Bruno', '5511900000000'), m('Caio', '5511966665555')],
    );
    expect(plano.erros).toEqual([]);
    expect([plano.novos, plano.atualizados, plano.semMudanca]).toEqual([1, 1, 1]);
    expect(plano.gravar).toEqual([
      m('Ana Lima', '5511988887777'),
      m('Bruno', '5511977776666'), // mantém a grafia do banco
    ]);
  });

  it('instância e gestor padrão (gestor do banco ou do arquivo); célula vazia mantém o banco', () => {
    const plano = planejarTime(
      'nome;numero;instancia;gestor\nRoni;5511977776666;Roni_Ramos;julia\nJulia;5511955554444;;\nFelipe;5511933332222;;\n',
      [m('Felipe', '5511933332222', { instancia: 'felipe', gestor_padrao: 'Julia' })],
    );
    expect(plano.erros).toEqual([]);
    expect(plano.gravar).toEqual([
      m('Roni', '5511977776666', { instancia: 'roni_ramos', gestor_padrao: 'Julia' }),
      m('Julia', '5511955554444'),
    ]);
    expect(plano.semMudanca).toBe(1);
  });

  it('erros de instância e gestor, só com o número da linha', () => {
    const plano = planejarTime(
      'nome;numero;instancia;gestor\nA;5511911110000;../x;\nB;5511922220000;dup;\nC;5511933330000;dup;\nD;5511944440000;felipe;\nE;5511955550000;;Ninguém\nF;5511966660000;;F\n',
      [m('Felipe', '5511900000000', { instancia: 'felipe' })],
    );
    expect(plano.erros).toEqual([
      'linha 2: instância só com letras sem acento, números e _',
      'linha 4: instância repetida no arquivo',
      'linha 5: instância já pertence a outra pessoa do time',
      'linha 6: gestor não está no time',
      'linha 7: a pessoa não pode ser gestora de si mesma',
    ]);
  });

  it('aceita vírgula como separador', () => {
    expect(planejarTime('nome,numero\nAna,5511988887777\n', []).novos).toBe(1);
  });

  it('erros por linha, sem nomes nem números na mensagem', () => {
    const plano = planejarTime(
      'nome;numero\nAna;5511988887777\nana;5511911112222\nDuda;5511988887777\n;5511933334444\nEdu;1234\nFabi;5511955554444\n',
      [m('Gil', '5511955554444')],
    );
    expect(plano.erros).toEqual([
      'linha 3: nome repetido no arquivo',
      'linha 4: número repetido no arquivo',
      'linha 5: nome vazio',
      'linha 6: número inválido (use 55 + DDD + número)',
      'linha 7: número já pertence a outra pessoa do time',
    ]);
    expect(plano.gravar).toEqual([m('Ana', '5511988887777')]);
  });

  it('cabeçalho errado', () => {
    expect(planejarTime('pessoa;telefone\nAna;5511988887777\n', []).erros[0]).toContain('cabeçalho');
  });
});
