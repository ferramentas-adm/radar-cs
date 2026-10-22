import { describe, expect, it } from 'vitest';
import { calcular, type EntradaMotor, type GrupoMotor, type MensagemMotor } from '../src/motor/calcular.js';
import type { Calendario } from '../src/motor/expediente.js';

// Casos de frontend/tests/engine-demo.test.mjs (sem resposta, sem contato, pilha, resumo e ordem),
// agora com tempo de expediente (9h–19h, seg–sex). Promessas e "Registrar ação feita" ficam fora
// desta fatia. "Agora" é terça 20/10/2026 15h, no meio do expediente.
const MIN = 60_000;
const sp = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00-03:00`);
const AG = sp('2026-10-20 15:00');
const ago = (m: number) => AG - m * MIN;
const ts = (s: string) => Date.parse(s);

const cal = (feriados: string[] = []): Calendario => ({
  expediente: { hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
  feriados: new Set(feriados),
});

interface G extends Partial<GrupoMotor> {
  time?: number[];
  cliente_msgs?: number[];
}

let seq = 0;
function montar(gs: G[], sobre: Partial<EntradaMotor> = {}): EntradaMotor {
  const grupos: GrupoMotor[] = [];
  const mensagens: MensagemMotor[] = [];
  for (const g of gs) {
    const grupo: GrupoMotor = {
      id_grupo: g.id_grupo ?? 'g1@g.us',
      cliente: g.cliente ?? 'Cliente Teste',
      especialista: g.especialista ?? 'Esp A',
      gestor: g.gestor ?? 'Gestor X',
      ativo: g.ativo ?? true,
      observador_entrou_em: g.observador_entrou_em ?? null,
    };
    grupos.push(grupo);
    for (const t of g.time ?? [ago(100)]) mensagens.push({ id_mensagem: `m${seq++}`, id_grupo: grupo.id_grupo, autor_tipo: 'time', enviada_em: t });
    for (const t of g.cliente_msgs ?? [ago(500)]) mensagens.push({ id_mensagem: `m${seq++}`, id_grupo: grupo.id_grupo, autor_tipo: 'cliente', enviada_em: t });
  }
  return {
    agora: AG,
    grupos,
    mensagens,
    calendario: cal(),
    prazo: { minutos_aviso: 20, minutos_gestor: 31 },
    observador: { status: 'conectado', desde: null },
    ultimaMensagemEm: null,
    usuario: { nome: 'piloto', pode_marcar: false },
    ...sobre,
  };
}
const run = (gs: G[], sobre: Partial<EntradaMotor> = {}) => calcular(montar(gs, sobre));

describe('sem resposta (médio: 20/31 min de expediente)', () => {
  it('cliente 19 min: sem alerta', () => expect(run([{ cliente_msgs: [ago(19)] }]).alertas).toHaveLength(0));
  it('cliente 20 min: aviso', () => {
    const a = run([{ cliente_msgs: [ago(20)] }]).alertas;
    expect(a).toHaveLength(1);
    expect(a[0]!.nivel).toBe('aviso');
    expect(a[0]!.motivos[0]!.tipo).toBe('sem_resposta');
  });
  it('cliente 30 min: ainda aviso', () => expect(run([{ cliente_msgs: [ago(30)] }]).alertas[0]!.nivel).toBe('aviso'));
  it('cliente 31 min: gestor', () => expect(run([{ cliente_msgs: [ago(31)] }]).alertas[0]!.nivel).toBe('gestor'));
  it('time respondeu depois: zera sem resposta', () =>
    expect(run([{ cliente_msgs: [ago(60)], time: [ago(5)] }]).alertas).toHaveLength(0));
  it('marcos de tempo do motivo', () => {
    const m = run([{ cliente_msgs: [ago(25)] }]).alertas[0]!.motivos[0]!;
    expect(ts(m.aviso_em!)).toBe(ago(25) + 20 * MIN);
    expect(ts(m.gestor_em)).toBe(ago(25) + 31 * MIN);
  });
  it('várias pendentes: vale a mais antiga (desde e prazos)', () => {
    const m = run([{ cliente_msgs: [ago(5), ago(25), ago(12)] }]).alertas[0]!.motivos[0]!;
    expect(ts(m.desde)).toBe(ago(25));
    expect(m.nivel).toBe('aviso');
  });
  it('mensagem do time zera todas as pendentes até aquele momento', () => {
    const r = run([{ cliente_msgs: [ago(90), ago(60), ago(3)], time: [ago(10)] }]);
    expect(r.alertas).toHaveLength(0);
    expect(r.pendentes[0]!.quantidade).toBe(1);
  });
});

describe('sem resposta fora do expediente', () => {
  it('fim de expediente: 18h50 → nada às 19h30; aviso às 9h10 do dia seguinte; gestor às 9h21', () => {
    const g = [{ cliente_msgs: [sp('2026-10-20 18:50')], time: [sp('2026-10-20 18:00')] }];
    expect(run(g, { agora: sp('2026-10-20 19:30') }).alertas).toHaveLength(0);
    expect(run(g, { agora: sp('2026-10-21 09:09') }).alertas).toHaveLength(0);
    expect(run(g, { agora: sp('2026-10-21 09:10') }).alertas[0]!.nivel).toBe('aviso');
    expect(run(g, { agora: sp('2026-10-21 09:21') }).alertas[0]!.nivel).toBe('gestor');
  });
  it('fim de semana: sexta 18h40 → aviso às 19h; não sobe no sábado; gestor segunda 9h11', () => {
    const g = [{ cliente_msgs: [sp('2026-10-23 18:40')], time: [sp('2026-10-23 18:00')] }];
    expect(run(g, { agora: sp('2026-10-23 19:00') }).alertas[0]!.nivel).toBe('aviso');
    expect(run(g, { agora: sp('2026-10-24 12:00') }).alertas[0]!.nivel).toBe('aviso');
    expect(run(g, { agora: sp('2026-10-26 09:10') }).alertas[0]!.nivel).toBe('aviso');
    expect(run(g, { agora: sp('2026-10-26 09:11') }).alertas[0]!.nivel).toBe('gestor');
  });
  it('retomada na manhã seguinte: segunda 20h → aviso terça 9h20', () => {
    const g = [{ cliente_msgs: [sp('2026-10-19 20:00')], time: [sp('2026-10-19 19:30')] }];
    expect(run(g, { agora: sp('2026-10-20 09:19') }).alertas).toHaveLength(0);
    expect(run(g, { agora: sp('2026-10-20 09:20') }).alertas[0]!.nivel).toBe('aviso');
  });
  it('feriado: o relógio fica parado o dia inteiro', () => {
    const g = [{ cliente_msgs: [sp('2026-10-20 18:50')], time: [sp('2026-10-20 18:00')] }];
    const feriado = { calendario: cal(['2026-10-21']) };
    expect(run(g, { ...feriado, agora: sp('2026-10-21 15:00') }).alertas).toHaveLength(0);
    expect(run(g, { ...feriado, agora: sp('2026-10-22 09:10') }).alertas[0]!.nivel).toBe('aviso');
  });
  it('mensagem do time fora do expediente zera do mesmo jeito', () => {
    const g = [{ cliente_msgs: [sp('2026-10-20 18:50')], time: [sp('2026-10-20 21:00')] }];
    expect(run(g, { agora: sp('2026-10-21 10:00') }).alertas).toHaveLength(0);
  });
});

describe('sem contato (dias úteis)', () => {
  // A mensagem do cliente vem antes da do time: não há "sem resposta".
  const contato = (time: string) => [{ time: [sp(time)], cliente_msgs: [sp(time) - 60 * MIN] }];
  it('segunda 15h01 (menos de 1 dia útil): nada', () => expect(run(contato('2026-10-19 15:01')).alertas).toHaveLength(0));
  it('segunda 15h (1 dia útil): aviso', () => {
    const a = run(contato('2026-10-19 15:00')).alertas[0]!;
    expect(a.nivel).toBe('aviso');
    expect(a.motivos[0]!.tipo).toBe('sem_contato');
  });
  it('sexta 15h01: ainda aviso (o fim de semana não conta)', () =>
    expect(run(contato('2026-10-16 15:01')).alertas[0]!.nivel).toBe('aviso'));
  it('sexta 15h (2 dias úteis): gestor', () => expect(run(contato('2026-10-16 15:00')).alertas[0]!.nivel).toBe('gestor'));
  it('sexta 17h: aviso segunda 17h, gestor terça 17h', () => {
    const g = contato('2026-10-23 17:00');
    expect(run(g, { agora: sp('2026-10-24 12:00') }).alertas).toHaveLength(0);
    expect(run(g, { agora: sp('2026-10-26 16:59') }).alertas).toHaveLength(0);
    expect(run(g, { agora: sp('2026-10-26 17:00') }).alertas[0]!.nivel).toBe('aviso');
    expect(run(g, { agora: sp('2026-10-27 17:00') }).alertas[0]!.nivel).toBe('gestor');
  });
  it('com feriado na segunda, tudo anda um dia útil', () => {
    const g = contato('2026-10-23 17:00');
    const c = { calendario: cal(['2026-10-26']) };
    expect(run(g, { ...c, agora: sp('2026-10-26 17:00') }).alertas).toHaveLength(0);
    expect(run(g, { ...c, agora: sp('2026-10-27 17:00') }).alertas[0]!.nivel).toBe('aviso');
  });
  it('time fora do expediente conta da próxima abertura: sábado 20h → aviso terça 9h', () => {
    const g = contato('2026-10-24 20:00');
    expect(run(g, { agora: sp('2026-10-27 08:59') }).alertas).toHaveLength(0);
    expect(run(g, { agora: sp('2026-10-27 09:00') }).alertas[0]!.nivel).toBe('aviso');
  });
  it('grupo novo sem mensagem do time: conta desde observador_entrou_em', () => {
    const g = [{ time: [], cliente_msgs: [], observador_entrou_em: sp('2026-10-19 15:00') }];
    expect(run(g).alertas[0]!.motivos[0]).toMatchObject({ tipo: 'sem_contato', nivel: 'aviso' });
  });
  it('sem mensagem do time e sem observador_entrou_em: sem "sem contato"', () =>
    expect(run([{ time: [], cliente_msgs: [] }]).alertas).toHaveLength(0));
  it('grupo inativo não gera alerta', () =>
    expect(run([{ ativo: false, time: [sp('2026-10-01 10:00')], cliente_msgs: [ago(5)] }]).alertas).toHaveLength(0));
});

describe('duplicadas e fora de ordem', () => {
  it('não mudam o resultado', () => {
    const base = montar([{ cliente_msgs: [ago(40), ago(25)], time: [ago(60)] }]);
    const bagunca: EntradaMotor = { ...base, mensagens: [...base.mensagens].reverse().concat(base.mensagens) };
    expect(calcular(bagunca)).toEqual(calcular(base));
  });
});

describe('pilha de mensagens', () => {
  it('cliente já respondido pelo time não entra', () =>
    expect(run([{ cliente_msgs: [ago(60)], time: [ago(5)] }]).pendentes).toHaveLength(0));
  it('conta só as mensagens depois da última do time', () => {
    const p = run([{ time: [ago(50)], cliente_msgs: [ago(5), ago(20), ago(40), ago(70)] }]).pendentes[0]!;
    expect(p.quantidade).toBe(3);
    expect(ts(p.mais_antiga_desde)).toBe(ago(40));
  });
  it('mais mensagens primeiro; empate pela mais antiga', () => {
    const r = run([
      { id_grupo: 'a', cliente: 'A', cliente_msgs: [ago(5)] },
      { id_grupo: 'b', cliente: 'B', cliente_msgs: [ago(5), ago(8), ago(9)] },
      { id_grupo: 'c', cliente: 'C', cliente_msgs: [ago(5), ago(15)] },
      { id_grupo: 'd', cliente: 'D', cliente_msgs: [ago(5), ago(30)] },
    ]).pendentes;
    expect(r.map((x) => x.id_grupo)).toEqual(['b', 'd', 'c', 'a']);
  });
  it('estado acompanha o alerta do cliente', () => {
    const r = run([
      { id_grupo: 'a', cliente_msgs: [ago(40), ago(45)] },
      { id_grupo: 'b', cliente_msgs: [ago(3), ago(4)] },
    ]).pendentes;
    expect(r.find((x) => x.id_grupo === 'a')!.estado).toBe('gestor');
    expect(r.find((x) => x.id_grupo === 'b')!.estado).toBe('ok');
  });
  it('grupo inativo não entra', () => expect(run([{ ativo: false, cliente_msgs: [ago(5)] }]).pendentes).toHaveLength(0));
});

describe('ordem, resumo e carteira', () => {
  it('gestor antes de aviso; resumo e por_especialista batem', () => {
    const r = run([
      { id_grupo: 'a', cliente: 'A aviso', cliente_msgs: [ago(22)] },
      { id_grupo: 'b', cliente: 'B gestor', cliente_msgs: [ago(40)] },
      { id_grupo: 'c', cliente: 'C contato gestor', time: [sp('2026-10-15 15:00')], cliente_msgs: [sp('2026-10-15 14:00')] },
      { id_grupo: 'd', cliente: 'D ok' },
      { id_grupo: 'e', cliente: 'E aviso contato', especialista: 'Esp B', time: [sp('2026-10-19 14:00')], cliente_msgs: [sp('2026-10-19 13:00')] },
    ]);
    expect(r.alertas.map((a) => a.id_grupo)).toEqual(['c', 'b', 'a', 'e']);
    expect(r.resumo).toMatchObject({ clientes_total: 5, em_alerta: 4, em_alerta_gestor: 2, retornos_vencidos: 0 });
    expect(r.resumo.sem_resposta).toEqual({ gestor: 1, aviso: 1 });
    expect(r.resumo.sem_contato).toEqual({ gestor: 1, aviso: 1 });
    const ea = r.por_especialista.find((e) => e.especialista === 'Esp A')!;
    expect(ea.clientes).toHaveLength(4);
    expect([ea.sem_contato, ea.sem_resposta]).toEqual([1, 1]);
    expect(ea.clientes.map((c) => c.estado)).toEqual(['gestor', 'gestor', 'aviso', 'ok']);
  });

  it('formato do contrato: campos fora desta fatia vazios, sem texto de mensagem', () => {
    const r = run([{ cliente_msgs: [ago(40)] }], {
      observador: { status: 'desconectado', desde: ago(30) },
      ultimaMensagemEm: ago(2),
    });
    expect(r.resolvidos_por_fora).toEqual([]);
    expect(r.retornos).toEqual([]);
    expect(r.alertas[0]!.voltou_de_marcacao).toBeNull();
    expect(r.usuario).toEqual({ nome: 'piloto', pode_marcar: false });
    expect(r.observador).toEqual({ status: 'desconectado', desde: new Date(ago(30)).toISOString(), ultima_mensagem_em: new Date(ago(2)).toISOString() });
    expect(JSON.stringify(r)).not.toMatch(/texto/i);
  });
});
