// Tela de configurações (só administrador): expediente, prazos por urgência e feriados.
// Validação pura (o servidor é quem manda; a tela só ajuda) e gravação no Supabase pela service role.
// A checagem de papel fica em painel.ts; o RLS das tabelas de configuração também só aceita admin.
import type { BancoRadar } from '../db/supabase.js';

export interface ExpedienteAdmin {
  hora_inicio: string; // HH:MM
  hora_fim: string; // HH:MM
  dias_uteis: number[]; // ISO: 1 = segunda ... 7 = domingo
  fuso: string; // IANA
}

export type Urgencia = 'alto' | 'medio' | 'baixo';
export const URGENCIAS: readonly Urgencia[] = ['alto', 'medio', 'baixo'];

export interface PrazoAdmin {
  urgencia: Urgencia;
  minutos_aviso: number;
  minutos_gestor: number;
}

export interface FeriadoAdmin {
  data: string; // AAAA-MM-DD
  descricao: string;
}

export interface ConfigAdmin {
  expediente: ExpedienteAdmin;
  prazos: PrazoAdmin[];
  feriados: FeriadoAdmin[];
}

export type Validado<T> = { ok: true; valor: T } | { ok: false; erro: string };

const falha = (erro: string): { ok: false; erro: string } => ({ ok: false, erro });

const objeto = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** "9:00", "09:00" ou "09:00:00" (como o Postgres devolve) → "09:00"; inválido → undefined. */
export function normalizarHora(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(v.trim());
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : undefined;
}

export function fusoValido(v: string): boolean {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

export function validarExpediente(corpo: unknown): Validado<ExpedienteAdmin> {
  const o = objeto(corpo);
  if (!o) return falha('Corpo inválido.');
  const inicio = normalizarHora(o.hora_inicio);
  const fim = normalizarHora(o.hora_fim);
  if (!inicio) return falha('Hora de início inválida (use HH:MM).');
  if (!fim) return falha('Hora de fim inválida (use HH:MM).');
  if (fim <= inicio) return falha('A hora de fim precisa ser depois da hora de início.');
  if (!Array.isArray(o.dias_uteis) || o.dias_uteis.length === 0) return falha('Escolha ao menos um dia útil.');
  const dias = o.dias_uteis.map(Number);
  if (!dias.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return falha('Dias úteis inválidos (1 = segunda ... 7 = domingo).');
  const fuso = typeof o.fuso === 'string' ? o.fuso.trim() : '';
  if (fuso === '' || !fusoValido(fuso)) return falha('Fuso horário inválido (ex.: America/Sao_Paulo).');
  return { ok: true, valor: { hora_inicio: inicio, hora_fim: fim, dias_uteis: [...new Set(dias)].sort((a, b) => a - b), fuso } };
}

export function validarPrazo(urgencia: string, corpo: unknown): Validado<PrazoAdmin> {
  if (!(URGENCIAS as readonly string[]).includes(urgencia)) return falha('Nível de urgência inválido.');
  const o = objeto(corpo);
  if (!o) return falha('Corpo inválido.');
  const aviso = o.minutos_aviso;
  const gestor = o.minutos_gestor;
  if (typeof aviso !== 'number' || !Number.isInteger(aviso) || aviso < 1) return falha('Minutos do aviso: informe um número inteiro de 1 em diante.');
  if (typeof gestor !== 'number' || !Number.isInteger(gestor) || gestor < 1) return falha('Minutos do gestor: informe um número inteiro de 1 em diante.');
  if (aviso > 10_080 || gestor > 10_080) return falha('Prazo máximo de 10080 minutos (7 dias).');
  if (gestor <= aviso) return falha('O prazo do gestor precisa ser maior que o do aviso.');
  return { ok: true, valor: { urgencia: urgencia as Urgencia, minutos_aviso: aviso, minutos_gestor: gestor } };
}

export function validarFeriado(data: string, corpo: unknown): Validado<FeriadoAdmin> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return falha('Data inválida (use AAAA-MM-DD).');
  const d = new Date(`${data}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== data) return falha('Data inválida.');
  const o = objeto(corpo);
  if (!o) return falha('Corpo inválido.');
  const descricao = typeof o.descricao === 'string' ? o.descricao.trim() : '';
  if (descricao === '') return falha('Informe a descrição do feriado.');
  if (descricao.length > 120) return falha('Descrição com no máximo 120 caracteres.');
  return { ok: true, valor: { data, descricao } };
}

/** O que a tela de configurações precisa do banco. Atrás de uma interface para testar sem Supabase. */
export interface ServicoAdmin {
  ler(): Promise<ConfigAdmin>;
  salvarExpediente(e: ExpedienteAdmin): Promise<ExpedienteAdmin>;
  salvarPrazo(p: PrazoAdmin): Promise<PrazoAdmin>;
  salvarFeriado(f: FeriadoAdmin): Promise<FeriadoAdmin>;
  removerFeriado(data: string): Promise<void>;
}

const codigo = (erro: { code?: string }) => (typeof erro.code === 'string' && erro.code !== '' ? erro.code : 'desconhecido');
const falhou = (onde: string, erro: { code?: string } | null): void => {
  if (erro) throw new Error(`falha em ${onde} (código ${codigo(erro)})`);
};

/** `aoAlterar` roda depois de toda gravação (invalida o cache dos dados do radar). */
export function servicoAdminSupabase(db: BancoRadar, aoAlterar: () => void): ServicoAdmin {
  return {
    async ler() {
      const [exp, prazos, feriados] = await Promise.all([
        db.from('config_expediente').select('hora_inicio, hora_fim, dias_uteis, fuso').single(),
        db.from('prazos_urgencia').select('urgencia, minutos_aviso, minutos_gestor'),
        db.from('feriados').select('data, descricao').order('data'),
      ]);
      falhou('config_expediente', exp.error);
      falhou('prazos_urgencia', prazos.error);
      falhou('feriados', feriados.error);
      const e = exp.data as { hora_inicio: string; hora_fim: string; dias_uteis: number[]; fuso: string };
      const ordem = (u: string) => URGENCIAS.indexOf(u as Urgencia);
      return {
        expediente: {
          hora_inicio: normalizarHora(e.hora_inicio) ?? e.hora_inicio,
          hora_fim: normalizarHora(e.hora_fim) ?? e.hora_fim,
          dias_uteis: e.dias_uteis.map(Number),
          fuso: e.fuso,
        },
        prazos: ((prazos.data ?? []) as PrazoAdmin[]).sort((a, b) => ordem(a.urgencia) - ordem(b.urgencia)),
        feriados: (feriados.data ?? []) as FeriadoAdmin[],
      };
    },

    async salvarExpediente(e) {
      // Uma linha só (id sempre true).
      const r = await db.from('config_expediente').upsert({ id: true, ...e }, { onConflict: 'id' });
      falhou('config_expediente', r.error);
      aoAlterar();
      return e;
    },

    async salvarPrazo(p) {
      const r = await db.from('prazos_urgencia').upsert(p, { onConflict: 'urgencia' });
      falhou('prazos_urgencia', r.error);
      aoAlterar();
      return p;
    },

    async salvarFeriado(f) {
      const r = await db.from('feriados').upsert(f, { onConflict: 'data' });
      falhou('feriados', r.error);
      aoAlterar();
      return f;
    },

    async removerFeriado(data) {
      const r = await db.from('feriados').delete().eq('data', data);
      falhou('feriados', r.error);
      aoAlterar();
    },
  };
}
