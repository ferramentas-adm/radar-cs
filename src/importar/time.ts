// Passo 2b: importação de var/time.csv (nome;numero) para a tabela time.
// Função pura: recebe o texto do CSV e o que já está no banco; devolve o que gravar e as contagens.
// Mensagens de erro citam só o número da linha, nunca nomes ou telefones.
import { lerCsv, coluna } from '../csv.js';

export interface MembroTimeBanco {
  nome: string;
  numero: string;
}

export interface PlanoTime {
  /** Linhas para o upsert por nome (com a grafia do nome que já está no banco). */
  gravar: MembroTimeBanco[];
  novos: number;
  atualizados: number;
  semMudanca: number;
  erros: string[];
}

const chaveNome = (nome: string) => nome.trim().replace(/\s+/g, ' ').toLowerCase();

export function planejarTime(texto: string, existentes: MembroTimeBanco[]): PlanoTime {
  const csv = lerCsv(texto);
  const plano: PlanoTime = { gravar: [], novos: 0, atualizados: 0, semMudanca: 0, erros: [] };
  if (!csv.cabecalho.includes('nome') || !csv.cabecalho.includes('numero')) {
    plano.erros.push('cabeçalho: precisa das colunas "nome" e "numero"');
    return plano;
  }

  const porNome = new Map(existentes.map((m) => [chaveNome(m.nome), m]));
  const donoDoNumero = new Map(existentes.map((m) => [m.numero, chaveNome(m.nome)]));
  const nomesNoArquivo = new Set<string>();
  const numerosNoArquivo = new Set<string>();

  for (const l of csv.linhas) {
    const nome = coluna(csv, l, 'nome').replace(/\s+/g, ' ');
    const numero = coluna(csv, l, 'numero').replace(/\D/g, '');
    const erro = (motivo: string) => plano.erros.push(`linha ${l.numero}: ${motivo}`);

    const chave = chaveNome(nome);
    const dono = donoDoNumero.get(numero);
    const motivo =
      nome === ''
        ? 'nome vazio'
        : numero.length < 12
          ? 'número inválido (use 55 + DDD + número)'
          : nomesNoArquivo.has(chave)
            ? 'nome repetido no arquivo'
            : numerosNoArquivo.has(numero)
              ? 'número repetido no arquivo'
              : dono !== undefined && dono !== chave
                ? 'número já pertence a outra pessoa do time'
                : undefined;
    if (motivo) {
      erro(motivo);
      continue;
    }
    nomesNoArquivo.add(chave);
    numerosNoArquivo.add(numero);

    const atual = porNome.get(chave);
    if (atual?.numero === numero) {
      plano.semMudanca++;
      continue;
    }
    if (atual) plano.atualizados++;
    else plano.novos++;
    plano.gravar.push({ nome: atual?.nome ?? nome, numero });
  }
  return plano;
}
