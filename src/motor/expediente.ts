// Tempo de expediente (funções puras). O relógio só corre dentro do expediente configurado
// (config_expediente), em dias úteis que não são feriado. Fora disso, para e retoma na abertura.
// Datas e horas são do fuso configurado (America/Sao_Paulo); instantes são ms UTC.

export interface Expediente {
  /** "09:00" ou "09:00:00" (formato do Postgres). */
  hora_inicio: string;
  hora_fim: string;
  /** ISO: 1 = segunda ... 7 = domingo. */
  dias_uteis: number[];
  fuso: string;
}

export interface Calendario {
  expediente: Expediente;
  /** Datas "AAAA-MM-DD" no fuso do expediente. */
  feriados: ReadonlySet<string>;
}

const MIN = 60_000;
const LIMITE_DIAS = 400; // proteção contra configuração sem nenhum dia útil

const formatos = new Map<string, Intl.DateTimeFormat>();
function formato(fuso: string): Intl.DateTimeFormat {
  let f = formatos.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    });
    formatos.set(fuso, f);
  }
  return f;
}

interface Local {
  data: string; // AAAA-MM-DD
  /** Minutos desde a meia-noite local (com fração de segundos). */
  minuto: number;
  /** Deslocamento do fuso em minutos (ex.: -180). */
  deslocamento: number;
}

function local(t: number, fuso: string): Local {
  const p = Object.fromEntries(formato(fuso).formatToParts(t).map((x) => [x.type, x.value]));
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(p.timeZoneName ?? '');
  const deslocamento = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const ms = ((t % 1000) + 1000) % 1000; // o formato não traz milissegundos
  return {
    data: `${p.year}-${p.month}-${p.day}`,
    minuto: Number(p.hour) * 60 + Number(p.minute) + (Number(p.second) * 1000 + ms) / MIN,
    deslocamento,
  };
}

/** Instante UTC de uma hora local (minutos desde a meia-noite) numa data do fuso. */
function instante(data: string, minuto: number, fuso: string): number {
  const [a, m, d] = data.split('-').map(Number) as [number, number, number];
  const comoUtc = Date.UTC(a, m - 1, d) + minuto * MIN;
  let t = comoUtc - local(comoUtc, fuso).deslocamento * MIN;
  t = comoUtc - local(t, fuso).deslocamento * MIN; // segunda passada: troca de horário de verão
  return t;
}

const dois = (n: number) => String(n).padStart(2, '0');

/** "AAAA-MM-DD HH:MM" no fuso (para mostrar à IA a hora das mensagens). */
export function formatarLocal(t: number, fuso: string): string {
  const l = local(t, fuso);
  return `${l.data} ${dois(Math.floor(l.minuto / 60))}:${dois(Math.floor(l.minuto % 60))}`;
}

/** Instante UTC de "AAAA-MM-DDTHH:MM" (hora local do fuso). Data ou hora impossível = undefined. */
export function instanteLocal(texto: string, fuso: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(texto.trim());
  if (!m) return undefined;
  const [a, mes, d, h, min] = m.slice(1).map(Number) as [number, number, number, number, number];
  const utc = new Date(Date.UTC(a, mes - 1, d));
  if (utc.getUTCFullYear() !== a || utc.getUTCMonth() !== mes - 1 || utc.getUTCDate() !== d || h > 23 || min > 59) return undefined;
  return instante(`${m[1]}-${m[2]}-${m[3]}`, h * 60 + min, fuso);
}

function minutosDe(hora: string): number {
  const [h, m] = hora.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

function diaSeguinte(data: string): string {
  const [a, m, d] = data.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
}

function diaDaSemana(data: string): number {
  const [a, m, d] = data.split('-').map(Number) as [number, number, number];
  return ((new Date(Date.UTC(a, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

export function ehDiaUtil(data: string, cal: Calendario): boolean {
  return cal.expediente.dias_uteis.includes(diaDaSemana(data)) && !cal.feriados.has(data);
}

function proximoDiaUtil(data: string, cal: Calendario): string {
  let d = data;
  for (let i = 0; i < LIMITE_DIAS; i++) {
    d = diaSeguinte(d);
    if (ehDiaUtil(d, cal)) return d;
  }
  throw new Error('expediente sem dia útil nos próximos 400 dias');
}

/** O próprio instante, se estiver no expediente; senão, a próxima abertura. */
export function proximaAbertura(t: number, cal: Calendario): number {
  const { fuso } = cal.expediente;
  const inicio = minutosDe(cal.expediente.hora_inicio);
  const fim = minutosDe(cal.expediente.hora_fim);
  const l = local(t, fuso);
  if (ehDiaUtil(l.data, cal)) {
    if (l.minuto < inicio) return instante(l.data, inicio, fuso);
    if (l.minuto < fim) return t;
  }
  return instante(proximoDiaUtil(l.data, cal), inicio, fuso);
}

/** Instante em que se completam `minutos` de expediente a partir de t. */
export function somarExpediente(t: number, minutos: number, cal: Calendario): number {
  const { fuso } = cal.expediente;
  const inicio = minutosDe(cal.expediente.hora_inicio);
  const fim = minutosDe(cal.expediente.hora_fim);
  let cursor = proximaAbertura(t, cal);
  let restante = minutos * MIN;
  for (let i = 0; i < LIMITE_DIAS; i++) {
    const data = local(cursor, fuso).data;
    const fechamento = instante(data, fim, fuso);
    if (restante <= fechamento - cursor) return cursor + restante;
    restante -= fechamento - cursor;
    cursor = instante(proximoDiaUtil(data, cal), inicio, fuso);
  }
  throw new Error('expediente sem dia útil nos próximos 400 dias');
}

/** Meia-noite do dia 1 do mês de t, no fuso (início do "mês corrente"). */
export function inicioDoMes(t: number, fuso: string): number {
  return instante(`${local(t, fuso).data.slice(0, 8)}01`, 0, fuso);
}

/**
 * n dias úteis depois de t, no mesmo horário. Fora do expediente, conta a partir da próxima
 * abertura (sábado 20h → segunda 9h → 1 dia útil = terça 9h).
 */
export function somarDiasUteis(t: number, n: number, cal: Calendario): number {
  const { fuso } = cal.expediente;
  const base = proximaAbertura(t, cal);
  const l = local(base, fuso);
  let data = l.data;
  for (let i = 0; i < n; i++) data = proximoDiaUtil(data, cal);
  return instante(data, l.minuto, fuso);
}
