import { z } from 'zod';

// Configuração do backend, lida do ambiente (.env). Nunca imprime valores: segredos só no servidor.

export interface Config {
  porta: number;
  webhookSegredo: string;
  uazapiToken: string;
  uazapiBaseUrl: string | undefined;
  webhookUrlPublica: string | undefined;
  supabase: { url: string; serviceRoleKey: string } | undefined;
  /** Fase de descoberta: guardar o texto das mensagens em eventos_brutos. Padrão false. */
  guardarTexto: boolean;
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
  UAZAPI_INSTANCE_TOKEN: obrigatoria(z.string().min(1)),
  UAZAPI_BASE_URL: opcional(z.url()),
  WEBHOOK_URL_PUBLICA: opcional(z.url()),
  SUPABASE_URL: opcional(z.url()),
  SUPABASE_SERVICE_ROLE_KEY: opcional(z.string().min(1)),
  DESCOBERTA_GUARDAR_TEXTO: opcional(z.enum(['true', 'false'])),
});

const DESCRICAO: Record<string, string> = {
  PORT: 'precisa ser um número de porta',
  WEBHOOK_SEGREDO: 'obrigatório, com pelo menos 32 caracteres',
  UAZAPI_INSTANCE_TOKEN: 'obrigatório',
  UAZAPI_BASE_URL: 'precisa ser uma URL',
  WEBHOOK_URL_PUBLICA: 'precisa ser uma URL',
  SUPABASE_URL: 'precisa ser uma URL',
  SUPABASE_SERVICE_ROLE_KEY: 'inválido',
  DESCOBERTA_GUARDAR_TEXTO: 'precisa ser "true" ou "false"',
};

export function lerConfig(env: NodeJS.ProcessEnv, opcoes: { exigirBanco: boolean }): Config {
  const r = esquema.safeParse(env);
  const problemas: string[] = [];
  if (!r.success) {
    // Só o nome da variável e uma descrição fixa: a mensagem do zod poderia ecoar o valor.
    const nomes = new Set(r.error.issues.map((i) => String(i.path[0])));
    for (const nome of nomes) problemas.push(`${nome}: ${DESCRICAO[nome] ?? 'inválido'}`);
  }
  if (opcoes.exigirBanco) {
    if (!env.SUPABASE_URL?.trim()) problemas.push('SUPABASE_URL: obrigatório (ou rode com --sem-banco)');
    if (!env.SUPABASE_SERVICE_ROLE_KEY?.trim())
      problemas.push('SUPABASE_SERVICE_ROLE_KEY: obrigatório (ou rode com --sem-banco)');
  }
  if (problemas.length > 0 || !r.success) {
    throw new ErroConfig(`Configuração inválida no .env:\n- ${[...new Set(problemas)].join('\n- ')}`);
  }

  const e = r.data;
  return {
    porta: e.PORT ?? 3000,
    webhookSegredo: e.WEBHOOK_SEGREDO,
    uazapiToken: e.UAZAPI_INSTANCE_TOKEN,
    uazapiBaseUrl: e.UAZAPI_BASE_URL?.replace(/\/+$/, ''),
    webhookUrlPublica: e.WEBHOOK_URL_PUBLICA?.replace(/\/+$/, ''),
    supabase:
      e.SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY
        ? { url: e.SUPABASE_URL, serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY }
        : undefined,
    guardarTexto: e.DESCOBERTA_GUARDAR_TEXTO === 'true',
  };
}
