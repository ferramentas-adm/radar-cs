import { describe, expect, it } from 'vitest';
import { planejarTime } from '../src/importar/time.js';

describe('planejarTime', () => {
  it('novos, atualizados e sem mudança (nome sem diferenciar maiúsculas)', () => {
    const plano = planejarTime(
      '﻿nome;numero\r\nAna Lima;+55 (11) 98888-7777\r\nBRUNO;5511977776666\r\nCaio;5511966665555\r\n',
      [
        { nome: 'Bruno', numero: '5511900000000' },
        { nome: 'Caio', numero: '5511966665555' },
      ],
    );
    expect(plano.erros).toEqual([]);
    expect([plano.novos, plano.atualizados, plano.semMudanca]).toEqual([1, 1, 1]);
    expect(plano.gravar).toEqual([
      { nome: 'Ana Lima', numero: '5511988887777' },
      { nome: 'Bruno', numero: '5511977776666' }, // mantém a grafia do banco
    ]);
  });

  it('aceita vírgula como separador', () => {
    expect(planejarTime('nome,numero\nAna,5511988887777\n', []).novos).toBe(1);
  });

  it('erros por linha, sem nomes nem números na mensagem', () => {
    const plano = planejarTime(
      'nome;numero\nAna;5511988887777\nana;5511911112222\nDuda;5511988887777\n;5511933334444\nEdu;1234\nFabi;5511955554444\n',
      [{ nome: 'Gil', numero: '5511955554444' }],
    );
    expect(plano.erros).toEqual([
      'linha 3: nome repetido no arquivo',
      'linha 4: número repetido no arquivo',
      'linha 5: nome vazio',
      'linha 6: número inválido (use 55 + DDD + número)',
      'linha 7: número já pertence a outra pessoa do time',
    ]);
    expect(plano.gravar).toEqual([{ nome: 'Ana', numero: '5511988887777' }]);
  });

  it('cabeçalho errado', () => {
    expect(planejarTime('pessoa;telefone\nAna;5511988887777\n', []).erros[0]).toContain('cabeçalho');
  });
});
