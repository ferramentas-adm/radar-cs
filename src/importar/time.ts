// Passo 2b: importação de var/time.csv (nome;numero[;instancia;gestor]) para a tabela time.
// Função pura: recebe o texto do CSV e o que já está no banco; devolve o que gravar e as contagens.
// Colunas opcionais: instancia (nome da instância uazapi do número corporativo da pessoa) e gestor
// (gestor padrão das conversas cadastradas sozinhas por essa instância). Célula vazia mantém o que
// está no banco. Mensagens de erro citam só o número da linha, nunca nomes ou telefones.
import { lerCsv, coluna } from '../csv.js';
import { NOME_INSTANCIA } from '../grupos/exportar.js';

export interface MembroTimeBanco {
  nome: string;
  numero: string;
  instancia: string | null;
  gestor_padrao: string | null;
}

export interface PlanoTime {
  /** Linhas completas para o upsert por nome (com a grafia do nome que já está no banco). */
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
  const donoDaInstancia = new Map(
    existentes.filter((m) => m.instancia).map((m) => [m.instancia!, chaveNome(m.nome)]),
  );
  // Gestor pode ser alguém do banco ou do próprio arquivo (grafia do banco quando existir).
  const nomesConhecidos = new Map(existentes.map((m) => [chaveNome(m.nome), m.nome]));
  for (const l of csv.linhas) {
    const nome = coluna(csv, l, 'nome').replace(/\s+/g, ' ');
    if (nome !== '' && !nomesConhecidos.has(chaveNome(nome))) nomesConhecidos.set(chaveNome(nome), nome);
  }
  const nomesNoArquivo = new Set<string>();
  const numerosNoArquivo = new Set<string>();
  const instanciasNoArquivo = new Set<string>();

  for (const l of csv.linhas) {
    const nome = coluna(csv, l, 'nome').replace(/\s+/g, ' ');
    const numero = coluna(csv, l, 'numero').replace(/\D/g, '');
    const instanciaCsv = coluna(csv, l, 'instancia').toLowerCase();
    const gestorCsv = coluna(csv, l, 'gestor');
    const erro = (motivo: string) => plano.erros.push(`linha ${l.numero}: ${motivo}`);

    const chave = chaveNome(nome);
    const dono = donoDoNumero.get(numero);
    const donoInstancia = instanciaCsv === '' ? undefined : donoDaInstancia.get(instanciaCsv);
    const gestor = gestorCsv === '' ? undefined : nomesConhecidos.get(chaveNome(gestorCsv));
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
                : instanciaCsv !== '' && !NOME_INSTANCIA.test(instanciaCsv)
                  ? 'instância só com letras sem acento, números e _'
                  : instanciaCsv !== '' && instanciasNoArquivo.has(instanciaCsv)
                    ? 'instância repetida no arquivo'
                    : donoInstancia !== undefined && donoInstancia !== chave
                      ? 'instância já pertence a outra pessoa do time'
                      : gestorCsv !== '' && gestor === undefined
                        ? 'gestor não está no time'
                        : gestor !== undefined && chaveNome(gestor) === chave
                          ? 'a pessoa não pode ser gestora de si mesma'
                          : undefined;
    if (motivo) {
      erro(motivo);
      continue;
    }
    nomesNoArquivo.add(chave);
    numerosNoArquivo.add(numero);
    if (instanciaCsv !== '') instanciasNoArquivo.add(instanciaCsv);

    const atual = porNome.get(chave);
    // Célula vazia não apaga o que está no banco.
    const linha: MembroTimeBanco = {
      nome: atual?.nome ?? nome,
      numero,
      instancia: instanciaCsv || (atual?.instancia ?? null),
      gestor_padrao: gestor ?? atual?.gestor_padrao ?? null,
    };
    if (
      atual &&
      atual.numero === linha.numero &&
      atual.instancia === linha.instancia &&
      atual.gestor_padrao === linha.gestor_padrao
    ) {
      plano.semMudanca++;
      continue;
    }
    if (atual) plano.atualizados++;
    else plano.novos++;
    plano.gravar.push(linha);
  }
  return plano;
}
