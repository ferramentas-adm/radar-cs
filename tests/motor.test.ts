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
      ...(g.tipo ? { tipo: g.tipo } : {}),
      ...(g.ultima_atividade_em !== undefined ? { ultima_atividade_em: g.ultima_atividade_em } : {}),
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
  it('estado: só o "sem resposta", pela pendente mais antiga (no prazo, aviso, gestor)', () => {
    const r = run([
      { id_grupo: 'a', cliente_msgs: [ago(5), ago(40)] },
      { id_grupo: 'b', cliente_msgs: [ago(3), ago(4)] },
      { id_grupo: 'c', cliente_msgs: [ago(5), ago(25)] },
    ]).pendentes;
    expect(r.find((x) => x.id_grupo === 'a')!.estado).toBe('gestor');
    expect(r.find((x) => x.id_grupo === 'b')!.estado).toBe('ok');
    expect(r.find((x) => x.id_grupo === 'c')!.estado).toBe('aviso');
  });
  it('estado não herda o "sem contato": grupo em gestor por contato, pendente no prazo = ok', () => {
    const r = run([{ time: [sp('2026-10-15 15:00')], cliente_msgs: [ago(5)] }]);
    expect(r.por_especialista[0]!.clientes[0]!.estado).toBe('gestor');
    expect(r.pendentes[0]!.estado).toBe('ok');
  });
  it('estado em tempo de expediente: fora do expediente o relógio da pendente para', () => {
    // segunda 18h50 → 10 min até 19h; às 9h05 de terça são 15 min: ainda no prazo
    const r = run([{ time: [sp('2026-10-19 18:00')], cliente_msgs: [sp('2026-10-19 18:50')] }], { agora: sp('2026-10-20 09:05') });
    expect(r.pendentes[0]!.estado).toBe('ok');
    const r2 = run([{ time: [sp('2026-10-19 18:00')], cliente_msgs: [sp('2026-10-19 18:50')] }], { agora: sp('2026-10-20 09:10') });
    expect(r2.pendentes[0]!.estado).toBe('aviso');
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
    // o que ainda não existe sai como recurso ausente (o painel esconde em vez de mostrar zero)
    expect(r.recursos).toEqual({ marcacoes: false, promessas: false });
    expect(r.alertas[0]!.voltou_de_marcacao).toBeNull();
    expect(r.usuario).toEqual({ nome: 'piloto', pode_marcar: false });
    expect(r.observador).toEqual({ status: 'desconectado', desde: new Date(ago(30)).toISOString(), ultima_mensagem_em: new Date(ago(2)).toISOString() });
    expect(JSON.stringify(r)).not.toMatch(/texto/i);
  });
});

describe('conversas privadas: só números por especialista', () => {
  const privada = (o: G): G => ({ tipo: 'privada', cliente: '', id_grupo: `privada:${String(seq++).padStart(64, '0')}`, time: [], cliente_msgs: [], ultima_atividade_em: null, ...o });
  const esp = (r: ReturnType<typeof run>, nome = 'Esp A') => r.por_especialista.find((e) => e.especialista === nome)!;

  it('nunca vira linha: fora de alertas, pendentes, clientes e resumo', () => {
    const r = run([privada({ cliente_msgs: [ago(500)], ultima_atividade_em: ago(500) })]);
    expect(r.alertas).toEqual([]);
    expect(r.pendentes).toEqual([]);
    expect(r.resumo.clientes_total).toBe(0);
    expect(r.resumo.em_alerta).toBe(0);
    expect(esp(r).clientes).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('privada:');
  });

  it('sem resposta: só depois do prazo de aviso (20 min de expediente), sem "sem contato"', () => {
    expect(esp(run([privada({ cliente_msgs: [ago(19)] })])).conversas_privadas_sem_resposta).toBe(0);
    expect(esp(run([privada({ cliente_msgs: [ago(20)] })])).conversas_privadas_sem_resposta).toBe(1);
    expect(esp(run([privada({ cliente_msgs: [ago(40)] })])).conversas_privadas_sem_resposta).toBe(1);
    // Time respondeu depois: zera. Time escreveu há dias e o cliente nunca: nada (sem contato não se aplica).
    expect(esp(run([privada({ cliente_msgs: [ago(60)], time: [ago(5)] })])).conversas_privadas_sem_resposta).toBe(0);
    expect(esp(run([privada({ time: [ago(5 * 24 * 60)] })])).conversas_privadas_sem_resposta).toBe(0);
  });

  it('sem resposta conta conversas, não mensagens; o relógio para fora do expediente', () => {
    const r = run([privada({ cliente_msgs: [ago(30), ago(25)] }), privada({ cliente_msgs: [ago(45)] })]);
    expect(esp(r).conversas_privadas_sem_resposta).toBe(2);
    // Segunda 20h → conta a partir de terça 9h: às 9h19 ainda não; às 9h20 sim.
    const seg20 = sp('2026-10-19 20:00');
    const p = [privada({ cliente_msgs: [seg20] })];
    expect(esp(run(p, { agora: sp('2026-10-20 09:19') })).conversas_privadas_sem_resposta).toBe(0);
    expect(esp(run(p, { agora: sp('2026-10-20 09:20') })).conversas_privadas_sem_resposta).toBe(1);
  });

  it('atividade: distintas nos últimos 7 dias e no mês corrente (fuso de São Paulo)', () => {
    const r = run([
      privada({ ultima_atividade_em: ago(10) }),
      privada({ ultima_atividade_em: AG - 7 * 24 * 60 * MIN }), // exatamente 7 dias: conta
      privada({ ultima_atividade_em: AG - 8 * 24 * 60 * MIN }), // 12/10: no mês, fora dos 7 dias
      privada({ ultima_atividade_em: sp('2026-10-01 00:00') }), // primeiro instante do mês
      privada({ ultima_atividade_em: sp('2026-09-30 23:59') }), // mês anterior
      privada({ ultima_atividade_em: null }),
    ]);
    expect([esp(r).conversas_privadas_7d, esp(r).conversas_privadas_mes]).toEqual([2, 4]);
  });

  it('privada bloqueada não conta; especialista só com privadas aparece', () => {
    const r = run([
      { especialista: 'Esp A' },
      privada({ especialista: 'Esp B', cliente_msgs: [ago(30)], ultima_atividade_em: ago(30) }),
      privada({ especialista: 'Esp B', ativo: false, cliente_msgs: [ago(30)], ultima_atividade_em: ago(30) }),
    ]);
    expect(esp(r, 'Esp B')).toMatchObject({ clientes: [], conversas_privadas_sem_resposta: 1, conversas_privadas_7d: 1, conversas_privadas_mes: 1 });
    expect(esp(r, 'Esp A')).toMatchObject({ conversas_privadas_sem_resposta: 0, conversas_privadas_7d: 0, conversas_privadas_mes: 0 });
  });
});

describe('aguardando definição do especialista principal', () => {
  const TIME = [
    { nome: 'Ana', instancia: 'ana', gestor_padrao: 'Gestor X', funcao: 'especialista' as const },
    { nome: 'Bruno', instancia: 'bruno', gestor_padrao: 'Gestor X', funcao: 'especialista' as const },
  ];
  const VARRIDO = [
    { instancia: 'ana', concluida_em: new Date(ago(60)).toISOString() },
    { instancia: 'bruno', concluida_em: new Date(ago(60)).toISOString() },
  ];
  const cenario = (n: number, extra: Partial<NonNullable<EntradaMotor['responsaveis']>> = {}) => {
    const gs: G[] = Array.from({ length: n }, (_, i) => ({ id_grupo: `g${String(i).padStart(2, '0')}@g.us`, cliente: `Cliente ${String(n - i).padStart(2, '0')}`, especialista: 'Ana' }));
    const responsaveis = {
      grupos: gs.map((g) => ({ jid: g.id_grupo!, especialista: 'Ana', gestor: 'Gestor X', principal_definido_em: null })),
      presencas: gs.flatMap((g) => [{ jid: g.id_grupo!, instancia: 'ana' }, { jid: g.id_grupo!, instancia: 'bruno' }]),
      time: TIME,
      varreduras: VARRIDO,
      ...extra,
    };
    return run(gs, { responsaveis });
  };

  it('no máximo 20 itens, com o total; ordem pelo nome do grupo; só nomes', () => {
    const d = cenario(25).definicoes_pendentes;
    expect(d.total).toBe(25);
    expect(d.sem_varredura_recente).toBe(0);
    expect(d.itens).toHaveLength(20);
    expect(d.itens[0]).toEqual({ id_grupo: 'g24@g.us', cliente: 'Cliente 01', especialista_atual: 'Ana', especialistas: ['Ana', 'Bruno'] });
    expect(d.itens.map((i) => i.cliente)).toEqual([...d.itens.map((i) => i.cliente)].sort());
    for (const i of d.itens) expect(Object.keys(i).sort()).toEqual(['cliente', 'especialista_atual', 'especialistas', 'id_grupo']);
  });

  it('varredura atrasada: nada decidido, lista vazia e quantas instâncias estão sem varredura', () => {
    const d = cenario(3, { varreduras: [VARRIDO[0]!] }).definicoes_pendentes;
    expect(d).toEqual({ total: 0, sem_varredura_recente: 1, itens: [] });
  });

  it('nunca privada nem grupo inativo; sem dados de presença, lista vazia', () => {
    const priv = `privada:${'0'.repeat(64)}`;
    const r = run(
      [
        { id_grupo: 'a@g.us', cliente: 'A' },
        { id_grupo: 'b@g.us', cliente: 'B', ativo: false },
        { id_grupo: priv, tipo: 'privada', cliente: '', time: [], cliente_msgs: [], ultima_atividade_em: null },
      ],
      {
        responsaveis: {
          grupos: ['a@g.us', 'b@g.us', priv].map((jid) => ({ jid, especialista: 'Ana', gestor: null, principal_definido_em: null })),
          presencas: ['a@g.us', 'b@g.us', priv].flatMap((jid) => [{ jid, instancia: 'ana' }, { jid, instancia: 'bruno' }]),
          time: TIME,
          varreduras: VARRIDO,
        },
      },
    );
    expect(r.definicoes_pendentes.itens.map((i) => i.id_grupo)).toEqual(['a@g.us']);
    expect(JSON.stringify(r.definicoes_pendentes)).not.toContain('privada:');
    expect(run([{}]).definicoes_pendentes).toEqual({ total: 0, sem_varredura_recente: 0, itens: [] });
  });
});
