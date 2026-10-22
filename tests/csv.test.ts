import { describe, expect, it } from 'vitest';
import { coluna, detectarSeparador, lerCsv } from '../src/csv.js';

describe('lerCsv', () => {
  it('ponto e vírgula, com BOM e CRLF', () => {
    const csv = lerCsv('﻿Nome;JID\r\nAlfa;1@g.us\r\nBeta;2@g.us\r\n');
    expect(csv.cabecalho).toEqual(['nome', 'jid']);
    expect(csv.linhas).toEqual([
      { numero: 2, campos: ['Alfa', '1@g.us'] },
      { numero: 3, campos: ['Beta', '2@g.us'] },
    ]);
  });

  it('vírgula, detectada pela primeira linha', () => {
    expect(detectarSeparador('nome,jid,gestor\n"a;b",1,x')).toBe(',');
    expect(lerCsv('nome,jid\nAlfa,1@g.us\n').linhas[0]?.campos).toEqual(['Alfa', '1@g.us']);
  });

  it('aspas: separador, aspas escapadas e quebra de linha dentro do campo', () => {
    const csv = lerCsv('nome;jid;obs\n"Alfa; Matriz";1@g.us;"diz ""oi""\nem duas linhas"\nBeta;2@g.us;\n');
    expect(csv.linhas[0]?.campos).toEqual(['Alfa; Matriz', '1@g.us', 'diz "oi"\nem duas linhas']);
    expect(csv.linhas[1]).toEqual({ numero: 4, campos: ['Beta', '2@g.us', ''] }); // conta a linha de dentro das aspas
  });

  it('ignora linhas em branco e lê a última linha sem quebra no fim', () => {
    const csv = lerCsv('nome;jid\n\nAlfa;1@g.us\n\nBeta;2@g.us');
    expect(csv.linhas.map((l) => l.numero)).toEqual([3, 5]);
  });

  it('coluna: pelo nome do cabeçalho, sem espaços nas pontas', () => {
    const csv = lerCsv(' Nome ; Gestor \n Alfa ; Gil \n');
    const l = csv.linhas[0]!;
    expect(coluna(csv, l, 'gestor')).toBe('Gil');
    expect(coluna(csv, l, 'inexistente')).toBe('');
  });
});
