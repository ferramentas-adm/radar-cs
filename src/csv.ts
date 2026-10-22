// Leitor de CSV para as planilhas que o CS edita no Excel ou no Google Planilhas.
// Aceita BOM, separador ";" ou "," (detectado pela primeira linha), campos entre aspas
// (com "" escapado, separador e quebra de linha dentro) e CRLF ou LF.

export interface LinhaCsv {
  /** Linha do arquivo onde o registro começa (1 = cabeçalho). Para mensagens de erro. */
  numero: number;
  campos: string[];
}

export interface Csv {
  /** Cabeçalho em minúsculas e sem espaços nas pontas. */
  cabecalho: string[];
  linhas: LinhaCsv[];
}

/** ";" ou ",": o que aparecer mais vezes fora de aspas na primeira linha (empate: ";"). */
export function detectarSeparador(texto: string): ';' | ',' {
  let pv = 0;
  let v = 0;
  let aspas = false;
  for (const c of texto) {
    if (c === '"') aspas = !aspas;
    else if (!aspas && (c === '\n' || c === '\r')) break;
    else if (!aspas && c === ';') pv++;
    else if (!aspas && c === ',') v++;
  }
  return v > pv ? ',' : ';';
}

export function lerCsv(bruto: string): Csv {
  const texto = bruto.replace(/^\uFEFF/, '');
  const sep = detectarSeparador(texto);
  const registros: LinhaCsv[] = [];

  let campos: string[] = [];
  let campo = '';
  let aspas = false;
  let linha = 1;
  let inicio = 1;

  const fecharRegistro = () => {
    campos.push(campo);
    // Linha em branco não vira registro.
    if (campos.length > 1 || campos[0]!.trim() !== '') registros.push({ numero: inicio, campos });
    campos = [];
    campo = '';
  };

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') aspas = false;
      else {
        if (c === '\n') linha++;
        campo += c;
      }
    } else if (c === '"') aspas = true;
    else if (c === sep) {
      campos.push(campo);
      campo = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fecharRegistro();
      linha++;
      inicio = linha;
    } else campo += c;
  }
  if (campo !== '' || campos.length > 0) fecharRegistro();

  const [cab, ...linhas] = registros;
  return { cabecalho: (cab?.campos ?? []).map((c) => c.trim().toLowerCase()), linhas };
}

/** Valor da coluna pelo nome do cabeçalho, sem espaços nas pontas ('' se não existir). */
export function coluna(csv: Csv, linha: LinhaCsv, nome: string): string {
  const i = csv.cabecalho.indexOf(nome);
  return i === -1 ? '' : (linha.campos[i] ?? '').trim();
}
