import { z } from 'zod';
import { NOME_INSTANCIA } from './grupos/exportar.js';

// Configuração do backend, lida do ambiente (.env). Nunca imprime valores: segredos só no servidor.

/**
 * Instância da uazapi que entrega eventos ao receptor.
 * - observador: UAZAPI_INSTANCE_TOKEN. fromMe nunca conta como time (regra 8).
 * - pessoa: número corporativo de alguém do time (RADAR_INSTANCIAS=roni_ramos, token em
 *   UAZAPI_TOKEN_RONI_RAMOS). fromMe = mensagem da própria pessoa, conta como time.
 */
export interface InstanciaConfig {
  nome: string;
  token: string;
  tipo: 'observador' | 'pessoa';
}

export interface Config {
  porta: number;
  webhookSegredo: string;
  instancias: InstanciaConfig[];
  uazapiBaseUrl: string | undefined;
  webhookUrlPublica: string | undefined;
  supabase: { url: string; serviceRoleKey: string } | undefined;
  /** Autenticação básica da página e da API (obrigatória quando há banco). */
  painel: { usuario: string; senha: string } | undefined;
}

export class ErroConfig extends Error {
  override name = 'ErroConfig';
}

// Variável vazia no .env conta como ausente.
const opcional = <T extends z.ZodType>(tipo: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), tipo.optional());
const obrigatoria = <T extends z.ZodType>(tipo: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), tipo);

const esquema = z.object({
  PORT: opcional(z.coerce.number().int().min(1).max(65535)),
  WEBHOOK_SEGREDO: obrigatoria(z.string().min(32)),
  UAZAPI_INSTANCE_TOKEN: opcional(z.string().min(1)),
  RADAR_INSTANCIAS: opcional(z.string()),
  UAZAPI_BASE_URL: opcional(z.url()),
  WEBHOOK_URL_PUBLICA: opcional(z.url()),
  SUPABASE_URL: opcional(z.url()),
  SUPABASE_SERVICE_ROLE_KEY: opcional(z.string().min(1)),
  PAINEL_USUARIO: opcional(z.string().min(1).regex(/^[^:]+$/)),
  PAINEL_SENHA: opcional(z.string().min(16)),
});

const DESCRICAO: Record<string, string> = {
  PORT: 'precisa ser um número de porta',
  WEBHOOK_SEGREDO: 'obrigatório, com pelo menos 32 caracteres',
  UAZAPI_INSTANCE_TOKEN: 'inválido',
  RADAR_INSTANCIAS: 'inválido',
  UAZAPI_BASE_URL: 'precisa ser uma URL',
  WEBHOOK_URL_PUBLICA: 'precisa ser uma URL',
  SUPABASE_URL: 'precisa ser uma URL',
  SUPABASE_SERVICE_ROLE_KEY: 'inválido',
  PAINEL_USUARIO: 'inválido (não pode ter ":")',
  PAINEL_SENHA: 'precisa ter pelo menos 16 caracteres',
};

/** Instâncias do .env. Problemas citam só nomes de variáveis. */
function lerInstancias(env: NodeJS.ProcessEnv, problemas: string[]): InstanciaConfig[] {
  const instancias: InstanciaConfig[] = [];
  const observador = env.UAZAPI_INSTANCE_TOKEN?.trim();
  if (observador) instancias.push({ nome: 'observador', token: observador, tipo: 'observador' });

  const nomes = (env.RADAR_INSTANCIAS ?? '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n !== '');
  for (const nome of new Set(nomes)) {
    if (!NOME_INSTANCIA.test(nome) || nome === 'observador') {
      problemas.push('RADAR_INSTANCIAS: nomes só com letras sem acento, números e _ (e diferentes de "observador")');
      continue;
    }
    const variavel = `UAZAPI_TOKEN_${nome.toUpperCase()}`;
    const token = env[variavel]?.trim();
    if (!token) problemas.push(`${variavel}: obrigatório (instância ${nome} em RADAR_INSTANCIAS)`);
    else instancias.push({ nome, token, tipo: 'pessoa' });
  }

  if (!observador && nomes.length === 0) {
    problemas.push('UAZAPI_INSTANCE_TOKEN ou RADAR_INSTANCIAS: configure ao menos uma instância');
  }
  return instancias;
}

export function lerConfig(env: NodeJS.ProcessEnv, opcoes: { exigirBanco: boolean }): Config {
  const r = esquema.safeParse(env);
  const problemas: string[] = [];
  if (!r.success) {
    // Só o nome da variável e uma descrição fixa: a mensagem do zod poderia ecoar o valor.
    const nomes = new Set(r.error.issues.map((i) => String(i.path[0])));
    for (const nome of nomes) problemas.push(`${nome}: ${DESCRICAO[nome] ?? 'inválido'}`);
  }
  const instancias = lerInstancias(env, problemas);
  if (opcoes.exigirBanco) {
    if (!env.SUPABASE_URL?.trim()) problemas.push('SUPABASE_URL: obrigatório (ou rode com --sem-banco)');
    if (!env.SUPABASE_SERVICE_ROLE_KEY?.trim())
      problemas.push('SUPABASE_SERVICE_ROLE_KEY: obrigatório (ou rode com --sem-banco)');
    // Com banco o painel sobe junto, e a URL do túnel é pública.
    if (!env.PAINEL_USUARIO?.trim()) problemas.push('PAINEL_USUARIO: obrigatório (ou rode com --sem-banco)');
    if (!env.PAINEL_SENHA?.trim()) problemas.push('PAINEL_SENHA: obrigatório (ou rode com --sem-banco)');
  }
  if (problemas.length > 0 || !r.success) {
    throw new ErroConfig(`Configuração inválida no .env:\n- ${[...new Set(problemas)].join('\n- ')}`);
  }

  const e = r.data;
  return {
    porta: e.PORT ?? 3000,
    webhookSegredo: e.WEBHOOK_SEGREDO,
    instancias,
    uazapiBaseUrl: e.UAZAPI_BASE_URL?.replace(/\/+$/, ''),
    webhookUrlPublica: e.WEBHOOK_URL_PUBLICA?.replace(/\/+$/, ''),
    supabase:
      e.SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY
        ? { url: e.SUPABASE_URL, serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY }
        : undefined,
    painel:
      e.PAINEL_USUARIO && e.PAINEL_SENHA ? { usuario: e.PAINEL_USUARIO, senha: e.PAINEL_SENHA } : undefined,
  };
}
