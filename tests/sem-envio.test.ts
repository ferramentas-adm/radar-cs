import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regra inegociável 1: o observador nunca envia. Nenhum arquivo de código pode referenciar
// rotas de envio da uazapi. A string é montada aqui para este próprio teste não se acusar.
const PROIBIDO = '/se' + 'nd/';

const RAIZ = join(import.meta.dirname, '..');
const PASTAS_IGNORADAS = new Set(['node_modules', '.git', 'docs', 'dist', 'coverage', 'var']);
const EXTENSOES_IGNORADAS = ['.md', '.pdf', '.png', '.jpg', '.ico'];

function arquivos(pasta: string): string[] {
  return readdirSync(pasta, { withFileTypes: true }).flatMap((e) => {
    const caminho = join(pasta, e.name);
    if (e.isDirectory()) return PASTAS_IGNORADAS.has(e.name) ? [] : arquivos(caminho);
    return EXTENSOES_IGNORADAS.some((x) => e.name.toLowerCase().endsWith(x)) ? [] : [caminho];
  });
}

describe('observador só lê', () => {
  it(`nenhum arquivo de código referencia "${PROIBIDO}"`, () => {
    const lista = arquivos(RAIZ);
    expect(lista.length).toBeGreaterThan(10); // a varredura achou o código de verdade
    const culpados = lista
      .filter((f) => readFileSync(f, 'utf8').includes(PROIBIDO))
      .map((f) => relative(RAIZ, f));
    expect(culpados).toEqual([]);
  });
});
