// Passo 2: exportar os grupos da instância para o CS preencher especialista e gestor.
// Funções puras (sem disco), para testar sem a uazapi. O script fica em scripts/exportar-grupos.ts.
// Nada aqui imprime nomes de grupos nem números: o CSV tem dados de clientes e só vai para var/.
import { ErroUazapi, type ClienteUazapi, type Grupo } from '../uazapi/cliente.js';

const LIMITE_PAGINA = 1000; // máximo aceito pelo /group/list
const MAX_TENTATIVAS = 3;
const ESPERA_PADRAO_S = 2;

export interface MembroTime {
  nome: string;
  numero: string;
}

export interface LinhaGrupo {
  nome: string;
  jid: string;
  qtd_membros: number;
  time_no_grupo: string;
  especialista: string;
  gestor: string;
}

const dormir = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Busca todos os grupos, paginando até hasMore = false. 408 e 429 tentam de novo (até 3 vezes). */
export async function buscarTodosGrupos(
  uazapi: Pick<ClienteUazapi, 'listarGrupos'>,
  esperar: (ms: number) => Promise<void> = dormir,
): Promise<Grupo[]> {
  const grupos: Grupo[] = [];
  let offset = 0;
  for (;;) {
    const pagina = await comTentativas(
      () => uazapi.listarGrupos({ limit: LIMITE_PAGINA, offset, noParticipants: false }),
      esperar,
    );
    grupos.push(...pagina.groups);
    const { hasMore, nextOffset } = pagina.pagination;
    if (!hasMore) return grupos;
    // nextOffset que não avança faria um loop infinito.
    if (typeof nextOffset !== 'number' || nextOffset <= offset) {
      throw new Error(`/group/list: nextOffset inválido com hasMore = true (offset ${offset})`);
    }
    offset = nextOffset;
  }
}

async function comTentativas<T>(chamada: () => Promise<T>, esperar: (ms: number) => Promise<void>): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await chamada();
    } catch (e) {
      const temporario = e instanceof ErroUazapi && (e.status === 408 || e.status === 429);
      if (!temporario || tentativa > MAX_TENTATIVAS) throw e;
      await esperar((e.retryAfterS ?? ESPERA_PADRAO_S * tentativa) * 1000);
    }
  }
}

/**
 * Chave de comparação de telefone: só dígitos, sem o sufixo do JID. Número brasileiro de celular
 * com 13 dígitos (55 + DDD + 9 + 8 dígitos) perde o nono dígito, porque o WhatsApp de contas
 * antigas costuma vir sem ele. Assim "5511988887777" e "551188887777" batem.
 */
export function chaveTelefone(valor: string): string {
  const digitos = (valor.split('@')[0] ?? '').replace(/\D/g, '');
  if (digitos.length === 13 && digitos.startsWith('55') && digitos[4] === '9') {
    return digitos.slice(0, 4) + digitos.slice(5);
  }
  return digitos;
}

/** Lê var/time.csv: cabeçalho "nome;numero", separador ponto e vírgula, aceita BOM e CRLF. */
export function lerTimeCsv(texto: string): MembroTime[] {
  const linhas = texto.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const cabecalho = (linhas.shift() ?? '').split(';').map((c) => c.trim().toLowerCase());
  const iNome = cabecalho.indexOf('nome');
  const iNumero = cabecalho.indexOf('numero');
  if (iNome === -1 || iNumero === -1) {
    throw new Error('var/time.csv precisa do cabeçalho "nome;numero" (separador ponto e vírgula)');
  }
  return linhas
    .map((l) => l.split(';'))
    .map((c) => ({ nome: (c[iNome] ?? '').trim(), numero: (c[iNumero] ?? '').trim() }))
    .filter((m) => m.nome !== '' && chaveTelefone(m.numero) !== '');
}

/** Número do participante: PhoneNumber quando vier; senão o JID, se for de telefone. */
function telefoneDoParticipante(p: { JID?: string; PhoneNumber?: string }): string | undefined {
  if (p.PhoneNumber) return p.PhoneNumber;
  if (p.JID?.endsWith('@s.whatsapp.net')) return p.JID;
  return undefined;
}

/** Uma linha por grupo; time_no_grupo com os nomes do time presentes (vazio sem time.csv). */
export function montarLinhas(grupos: Grupo[], time: MembroTime[]): LinhaGrupo[] {
  const porChave = new Map<string, string>();
  for (const m of time) porChave.set(chaveTelefone(m.numero), m.nome);

  return grupos.map((g) => {
    const participantes = g.Participants ?? [];
    const nomes = new Set<string>();
    for (const p of participantes) {
      const tel = telefoneDoParticipante(p);
      const nome = tel === undefined ? undefined : porChave.get(chaveTelefone(tel));
      if (nome) nomes.add(nome);
    }
    return {
      nome: g.Name ?? '',
      jid: g.JID,
      qtd_membros: g.ParticipantCount ?? participantes.length,
      time_no_grupo: [...nomes].join(', '),
      especialista: '',
      gestor: '',
    };
  });
}

const COLUNAS: (keyof LinhaGrupo)[] = ['nome', 'jid', 'qtd_membros', 'time_no_grupo', 'especialista', 'gestor'];

// Excel: texto que começa com = + - @ vira fórmula; o apóstrofo força texto.
export function celula(valor: string | number): string {
  let s = String(valor);
  if (typeof valor === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV para o Excel em português: UTF-8 com BOM, ponto e vírgula, CRLF. */
export function gerarCsv(linhas: LinhaGrupo[]): string {
  const corpo = [COLUNAS.join(';'), ...linhas.map((l) => COLUNAS.map((c) => celula(l[c])).join(';'))];
  return `\uFEFF${corpo.join('\r\n')}\r\n`;
}

/** Nome de instância: vira nome de variável e de arquivo, então só letras, números e _ (nada de ../). */
export const NOME_INSTANCIA = /^[a-z0-9_]+$/;

export interface Instancia {
  baseUrl: string;
  token: string;
  /** Nome do arquivo de saída dentro de var/. */
  arquivo: string;
  /** Nome da variável do token, para mensagens (nunca o valor). */
  variavelToken: string;
}

/**
 * Escolhe a instância pelos argumentos: sem --instancia, UAZAPI_INSTANCE_TOKEN e grupos.csv;
 * com --instancia ana, UAZAPI_TOKEN_ANA e grupos-ana.csv. O endereço é sempre UAZAPI_BASE_URL.
 * Erros citam só nomes de variáveis, nunca valores.
 */
export function escolherInstancia(argv: string[], env: NodeJS.ProcessEnv): Instancia {
  const i = argv.indexOf('--instancia');
  let nome: string | undefined;
  if (i !== -1) {
    nome = argv[i + 1]?.trim().toLowerCase();
    if (!nome || nome.startsWith('--')) throw new Error('Use --instancia NOME (ex.: --instancia ana).');
    if (!NOME_INSTANCIA.test(nome)) {
      throw new Error('O nome da instância só pode ter letras sem acento, números e _.');
    }
  }

  const variavelToken = nome ? `UAZAPI_TOKEN_${nome.toUpperCase()}` : 'UAZAPI_INSTANCE_TOKEN';
  const token = env[variavelToken]?.trim();
  if (!token) throw new Error(`Falta ${variavelToken} no .env.`);

  const baseUrl = env.UAZAPI_BASE_URL?.trim().replace(/\/+$/, '');
  if (!baseUrl || !URL.canParse(baseUrl)) throw new Error('Falta UAZAPI_BASE_URL (uma URL) no .env.');

  return { baseUrl, token, arquivo: nome ? `grupos-${nome}.csv` : 'grupos.csv', variavelToken };
}

/** Única saída para o terminal: contagens, nunca nomes nem números. */
export function resumo(linhas: LinhaGrupo[], temTime: boolean): string {
  const total = `grupos: ${linhas.length}`;
  if (!temTime) return `${total} · var/time.csv não encontrado (time_no_grupo vazio)`;
  return `${total} · com alguém do time: ${linhas.filter((l) => l.time_no_grupo !== '').length}`;
}
