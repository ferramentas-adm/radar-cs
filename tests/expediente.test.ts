import { describe, expect, it } from 'vitest';
import { proximaAbertura, somarDiasUteis, somarExpediente, type Calendario } from '../src/motor/expediente.js';

// Semana de referência: seg 19/10/2026 ... sex 23/10, sáb 24, dom 25, seg 26.
const sp = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00-03:00`);
const fmt = (t: number) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(t);

const cal = (feriados: string[] = [], sobre: Partial<Calendario['expediente']> = {}): Calendario => ({
  expediente: { hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo', ...sobre },
  feriados: new Set(feriados),
});
const CAL = cal();

describe('proximaAbertura', () => {
  it('dentro do expediente: o próprio instante', () => {
    expect(fmt(proximaAbertura(sp('2026-10-20 15:00'), CAL))).toBe('2026-10-20 15:00');
  });
  it('antes das 9h: abre às 9h do mesmo dia', () => {
    expect(fmt(proximaAbertura(sp('2026-10-20 08:00'), CAL))).toBe('2026-10-20 09:00');
  });
  it('às 19h em ponto já está fechado: dia útil seguinte', () => {
    expect(fmt(proximaAbertura(sp('2026-10-20 19:00'), CAL))).toBe('2026-10-21 09:00');
  });
  it('sexta à noite e fim de semana: segunda às 9h', () => {
    expect(fmt(proximaAbertura(sp('2026-10-23 20:00'), CAL))).toBe('2026-10-26 09:00');
    expect(fmt(proximaAbertura(sp('2026-10-24 12:00'), CAL))).toBe('2026-10-26 09:00');
  });
});

describe('somarExpediente', () => {
  it('dentro do expediente: tempo corrido', () => {
    expect(fmt(somarExpediente(sp('2026-10-20 15:00'), 20, CAL))).toBe('2026-10-20 15:20');
  });
  it('fim de expediente: 18h50 + 10 min = 19h; + 20 min = 9h10 do dia seguinte', () => {
    expect(fmt(somarExpediente(sp('2026-10-20 18:50'), 10, CAL))).toBe('2026-10-20 19:00');
    expect(fmt(somarExpediente(sp('2026-10-20 18:50'), 20, CAL))).toBe('2026-10-21 09:10');
  });
  it('fim de semana: sexta 18h40 + 31 min = segunda 9h11', () => {
    expect(fmt(somarExpediente(sp('2026-10-23 18:40'), 20, CAL))).toBe('2026-10-23 19:00');
    expect(fmt(somarExpediente(sp('2026-10-23 18:40'), 31, CAL))).toBe('2026-10-26 09:11');
  });
  it('mensagem às 20h de segunda começa a contar na terça às 9h', () => {
    expect(fmt(somarExpediente(sp('2026-10-19 20:00'), 20, CAL))).toBe('2026-10-20 09:20');
  });
  it('feriado para o dia inteiro', () => {
    expect(fmt(somarExpediente(sp('2026-10-20 18:50'), 20, cal(['2026-10-21'])))).toBe('2026-10-22 09:10');
  });
  it('vários dias: 25 horas de expediente', () => {
    expect(fmt(somarExpediente(sp('2026-10-19 09:00'), 25 * 60, CAL))).toBe('2026-10-21 14:00');
  });
  it('expediente configurável: 8h–20h, seg–sáb', () => {
    const c = cal([], { hora_inicio: '08:00', hora_fim: '20:00', dias_uteis: [1, 2, 3, 4, 5, 6] });
    expect(fmt(somarExpediente(sp('2026-10-23 19:50'), 20, c))).toBe('2026-10-24 08:10');
  });
  it('horário de verão antigo (2018): mesma hora local', () => {
    expect(fmt(somarExpediente(sp('2018-11-05 18:50').valueOf() - 3600_000, 20, CAL))).toBe('2018-11-06 09:10');
  });
});

describe('somarDiasUteis', () => {
  it('sexta 17h: aviso segunda 17h, gestor terça 17h', () => {
    expect(fmt(somarDiasUteis(sp('2026-10-23 17:00'), 1, CAL))).toBe('2026-10-26 17:00');
    expect(fmt(somarDiasUteis(sp('2026-10-23 17:00'), 2, CAL))).toBe('2026-10-27 17:00');
  });
  it('com feriado na segunda, tudo anda um dia útil', () => {
    const c = cal(['2026-10-26']);
    expect(fmt(somarDiasUteis(sp('2026-10-23 17:00'), 1, c))).toBe('2026-10-27 17:00');
    expect(fmt(somarDiasUteis(sp('2026-10-23 17:00'), 2, c))).toBe('2026-10-28 17:00');
  });
  it('fora do expediente conta da próxima abertura: sábado 20h → terça 9h', () => {
    expect(fmt(somarDiasUteis(sp('2026-10-24 20:00'), 1, CAL))).toBe('2026-10-27 09:00');
  });
  it('terça 8h → quarta 9h', () => {
    expect(fmt(somarDiasUteis(sp('2026-10-20 08:00'), 1, CAL))).toBe('2026-10-21 09:00');
  });
});

describe('configuração sem dia útil', () => {
  it('erro claro em vez de laço infinito', () => {
    expect(() => somarExpediente(sp('2026-10-20 10:00'), 20, cal([], { dias_uteis: [] }))).toThrow('dia útil');
  });
});
