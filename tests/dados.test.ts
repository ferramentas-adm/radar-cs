import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { compararDadosRadar } from '../src/api/comparar.js';
import { carregarDadosRadarLegado } from '../src/api/dados-legado.js';
import { carregarDadosRadar, montarDadosRadar, type RadarDadosJson } from '../src/api/dados.js';
import { calcular, type EntradaMotor } from '../src/motor/calcular.js';

// Equivalência entre o carregamento antigo (2 ou 3 consultas por conversa) e o novo (uma chamada a
// public.radar_dados()). O antigo roda sobre um banco falso em memória; o novo recebe o jsonb que
// a função devolve para as mesmas tabelas (montado aqui com a mesma regra da SQL). A SQL de verdade
// é conferida no banco real com npm run radar:comparar (só leitura, "diferenças = 0").

type Linha = Record<string, unknown>;
interface Tabelas {
  grupos: Linha[];
  mensagens: Linha[];
  config_expediente: Linha[];
  feriados: Linha[];
  prazos_urgencia: Linha[];
  presencas: Linha[];
  time: Linha[];
  varreduras: Linha[];
}

/** Só o que o carregamento antigo usa do cliente Supabase. */
function bancoFalso(t: Tabelas): SupabaseClient {
  class Consulta implements PromiseLike<{ data: unknown; error: null }> {
    private linhas: Linha[];
    private ordem: [string, boolean][] = [];
    private teto = Infinity;
    private faixa: [number, number] | undefined;
    private uma = false;
    constructor(tabela: keyof Tabelas) {
      this.linhas = [...t[tabela]];
    }
    select() {
      return this;
    }
    eq(c: string, v: unknown) {
      this.linhas = this.linhas.filter((l) => l[c] === v);
      return this;
    }
    gt(c: string, v: string) {
      this.linhas = this.linhas.filter((l) => Date.parse(l[c] as string) > Date.parse(v));
      return this;
    }
    order(c: string, o: { ascending?: boolean } = {}) {
      this.ordem.push([c, o.ascending !== false]);
      return this;
    }
    limit(n: number) {
      this.teto = n;
      return this;
    }
    range(de: number, ate: number) {
      this.faixa = [de, ate];
      return this;
    }
    single() {
      this.uma = true;
      return this;
    }
    then<A, B>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, erro?: ((e: unknown) => B | PromiseLike<B>) | null) {
      const cmp = (a: unknown, b: unknown) => {
        const [x, y] = [a, b].map((v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.includes('T') ? Date.parse(v) : v)) as [number, number];
        return x < y ? -1 : x > y ? 1 : 0;
      };
      let r = [...this.linhas].sort((a, b) => {
        for (const [c, asc] of this.ordem) {
          const d = cmp(a[c], b[c]);
          if (d) return asc ? d : -d;
        }
        return 0;
      });
      if (this.faixa) r = r.slice(this.faixa[0], this.faixa[1] + 1);
      r = r.slice(0, this.teto);
      return Promise.resolve({ data: this.uma ? r[0] : r, error: null }).then(ok, erro);
    }
  }
  return { from: (tabela: keyof Tabelas) => new Consulta(tabela) } as unknown as SupabaseClient;
}

/** O jsonb de public.radar_dados() para as mesmas tabelas (mesma regra da SQL). */
function radarDadosEmMemoria(t: Tabelas): RadarDadosJson {
  const ms = (s: unknown) => Date.parse(s as string);
  const desc = (a: Linha, b: Linha) => ms(b.enviada_em) - ms(a.enviada_em) || String(b.id_mensagem).localeCompare(String(a.id_mensagem));
  const msg = (m: Linha | undefined) => (m ? { id_mensagem: m.id_mensagem as string, enviada_em: m.enviada_em as string } : null);
  const ativos = t.grupos.filter((g) => g.ativo).sort((a, b) => (a.id as number) - (b.id as number));
  return {
    conversas: ativos.map((c) => {
      const doGrupo = t.mensagens.filter((m) => m.jid === c.jid);
      const ultimaTime = doGrupo.filter((m) => m.conta && m.autor_tipo === 'time').sort(desc)[0];
      const pendentes = doGrupo
        .filter((m) => m.conta && m.autor_tipo === 'cliente' && (!ultimaTime || ms(m.enviada_em) > ms(ultimaTime.enviada_em)))
        .sort((a, b) => -desc(a, b))
        .slice(0, 1000);
      const atividade = c.tipo === 'privada' ? doGrupo.sort(desc)[0] : undefined;
      return {
        jid: c.jid as string,
        tipo: c.tipo as 'grupo' | 'privada',
        nome: (c.nome ?? null) as string | null,
        especialista: (c.especialista ?? null) as string | null,
        gestor: (c.gestor ?? null) as string | null,
        observador_entrou_em: (c.observador_entrou_em ?? null) as string | null,
        principal_definido_em: (c.principal_definido_em ?? null) as string | null,
        ultima_time: msg(ultimaTime),
        pendentes: pendentes.map((m) => msg(m)!),
        ultima_atividade_em: (atividade?.enviada_em ?? null) as string | null,
      };
    }),
    expediente: t.config_expediente[0] as unknown as RadarDadosJson['expediente'],
    feriados: t.feriados.map((f) => f.data as string).sort(),
    prazo: t.prazos_urgencia.find((p) => p.urgencia === 'medio') as unknown as RadarDadosJson['prazo'],
    ultima_mensagem_em: (t.mensagens.sort(desc)[0]?.enviada_em ?? null) as string | null,
    presencas: t.presencas as RadarDadosJson['presencas'],
    time: t.time.filter((m) => m.ativo) as unknown as RadarDadosJson['time'],
    varreduras: t.varreduras as RadarDadosJson['varreduras'],
  };
}

const MIN = 60_000;
const sp = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00-03:00`);
const isoSp = (s: string) => new Date(sp(s)).toISOString();
const PRIV = (n: number) => `privada:${String(n).padStart(64, '0')}`;

function tabelas(): Tabelas {
  let id = 0;
  const m = (jid: string, autor: 'time' | 'cliente', quando: string, conta = true): Linha => ({
    id_mensagem: `m${++id}`,
    jid,
    autor_tipo: autor,
    conta,
    enviada_em: isoSp(quando),
  });
  const mensagens: Linha[] = [
    // a: cliente sem resposta, fora de ordem e com mensagem que não conta
    m('a@g.us', 'time', '2026-10-20 10:00'),
    m('a@g.us', 'cliente', '2026-10-20 14:30'),
    m('a@g.us', 'cliente', '2026-10-20 14:10'),
    m('a@g.us', 'cliente', '2026-10-20 14:50', false),
    m('a@g.us', 'cliente', '2026-10-20 09:00'), // antes do time: já respondida
    // b: time respondeu por último
    m('b@g.us', 'cliente', '2026-10-20 11:00'),
    m('b@g.us', 'time', '2026-10-20 11:05'),
    m('b@g.us', 'time', '2026-10-20 11:30', false), // reação do time: não conta
    // c: nunca teve mensagem do time (sem contato desde a entrada do observador)
    m('c@g.us', 'cliente', '2026-10-15 10:00'),
    // d: inativo, não entra
    m('d@g.us', 'cliente', '2026-10-20 14:00'),
    // privadas
    m(PRIV(1), 'time', '2026-10-20 08:00'),
    m(PRIV(1), 'cliente', '2026-10-20 13:00'),
    m(PRIV(1), 'cliente', '2026-10-20 14:55', false),
  ];
  // e: mais de 1000 pendentes (o teto vale nos dois caminhos)
  for (let i = 0; i < 1005; i++) mensagens.push({ id_mensagem: `e${i}`, jid: 'e@g.us', autor_tipo: 'cliente', conta: true, enviada_em: new Date(sp('2026-10-19 10:00') + i * MIN).toISOString() });
  return {
    grupos: [
      { id: 1, jid: 'a@g.us', tipo: 'grupo', nome: 'Cliente A', especialista: 'Ana', gestor: 'Julia', ativo: true, observador_entrou_em: null, principal_definido_em: null },
      { id: 2, jid: 'b@g.us', tipo: 'grupo', nome: null, especialista: null, gestor: null, ativo: true, observador_entrou_em: null, principal_definido_em: isoSp('2026-10-01 10:00') },
      { id: 3, jid: 'c@g.us', tipo: 'grupo', nome: 'Cliente C', especialista: 'Ana', gestor: 'Julia', ativo: true, observador_entrou_em: isoSp('2026-10-14 10:00'), principal_definido_em: null },
      { id: 4, jid: 'd@g.us', tipo: 'grupo', nome: 'Cliente D', especialista: 'Ana', gestor: 'Julia', ativo: false, observador_entrou_em: null, principal_definido_em: null },
      { id: 5, jid: 'e@g.us', tipo: 'grupo', nome: 'Cliente E', especialista: 'Bruno', gestor: 'Julia', ativo: true, observador_entrou_em: null, principal_definido_em: null },
      { id: 6, jid: PRIV(1), tipo: 'privada', nome: null, especialista: 'Ana', gestor: 'Julia', ativo: true, observador_entrou_em: null, principal_definido_em: null },
      { id: 7, jid: PRIV(2), tipo: 'privada', nome: null, especialista: 'Bruno', gestor: 'Julia', ativo: true, observador_entrou_em: null, principal_definido_em: null },
    ],
    mensagens,
    config_expediente: [{ hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' }],
    feriados: [{ data: '2026-11-02' }, { data: '2026-10-12' }],
    prazos_urgencia: [
      { urgencia: 'alto', minutos_aviso: 10, minutos_gestor: 15 },
      { urgencia: 'medio', minutos_aviso: 20, minutos_gestor: 31 },
    ],
    presencas: [
      { jid: 'a@g.us', instancia: 'ana' },
      { jid: 'a@g.us', instancia: 'bruno' },
    ],
    time: [
      { nome: 'Ana', instancia: 'ana', gestor_padrao: 'Julia', funcao: 'especialista', ativo: true },
      { nome: 'Bruno', instancia: 'bruno', gestor_padrao: 'Julia', funcao: 'especialista', ativo: true },
      { nome: 'Julia', instancia: null, gestor_padrao: null, funcao: 'gestor', ativo: true },
    ],
    varreduras: [
      { instancia: 'ana', concluida_em: isoSp('2026-10-20 08:00') },
      { instancia: 'bruno', concluida_em: isoSp('2026-10-20 08:00') },
    ],
  };
}

const AGORAS = ['2026-10-20 15:00', '2026-10-20 20:00', '2026-10-21 09:15', '2026-10-24 12:00', '2026-11-02 10:00', '2026-11-03 09:30'].map(sp);
const base = (d: Pick<EntradaMotor, 'grupos' | 'mensagens' | 'calendario' | 'prazo' | 'ultimaMensagemEm'>, agora: number): EntradaMotor => ({
  grupos: d.grupos,
  mensagens: d.mensagens,
  calendario: d.calendario,
  prazo: d.prazo,
  ultimaMensagemEm: d.ultimaMensagemEm,
  agora,
  observador: { status: 'conectado', desde: null },
  usuario: { nome: 'x', pode_marcar: false },
});

describe('GET /api/radar: carregamento novo (uma consulta) = antigo', () => {
  it('resposta do motor idêntica em vários momentos (expediente, noite, fim de semana, feriado)', async () => {
    const t = tabelas();
    const antigo = await carregarDadosRadarLegado(bancoFalso(t));
    const novo = montarDadosRadar(radarDadosEmMemoria(t));
    for (const agora of AGORAS) expect(calcular(base(novo, agora)), new Date(agora).toISOString()).toEqual(calcular(base(antigo, agora)));
    // o caso tem de tudo: alerta, pilha, privada e o teto de 1000
    const r = calcular(base(novo, AGORAS[0]!));
    expect(r.alertas.length).toBeGreaterThan(0);
    expect(r.pendentes.find((p) => p.id_grupo === 'e@g.us')!.quantidade).toBe(1000);
    expect(r.por_especialista.find((e) => e.especialista === 'Ana')!.conversas_privadas_7d).toBe(1);
  });

  it('compararDadosRadar: diferenças = 0 quando batem, e acusa quando não batem', async () => {
    const t = tabelas();
    const antigo = await carregarDadosRadarLegado(bancoFalso(t));
    const json = radarDadosEmMemoria(t);
    const r = compararDadosRadar(antigo, montarDadosRadar(json), AGORAS[0]!);
    expect(r).toMatchObject({ grupos: 4, privadas: 2, diferencas: 0, definicoes: 1, semVarredura: 0 });

    const errado = structuredClone(json);
    errado.conversas[0]!.pendentes.pop(); // uma pendente a menos no grupo a
    expect(compararDadosRadar(antigo, montarDadosRadar(errado), AGORAS[0]!).diferencas).toBeGreaterThan(0);
    const semFeriado = { ...structuredClone(json), feriados: [] };
    expect(compararDadosRadar(antigo, montarDadosRadar(semFeriado), AGORAS[0]!).diferencas).toBeGreaterThan(0);
  });

  it('montarDadosRadar: rótulos, privada sem nome e entrada da regra do responsável só com grupos', () => {
    const d = montarDadosRadar(radarDadosEmMemoria(tabelas()));
    const b = d.grupos.find((g) => g.id_grupo === 'b@g.us')!;
    expect([b.cliente, b.especialista, b.gestor]).toEqual(['(sem nome)', '(sem especialista)', '(sem gestor)']);
    expect(d.grupos.find((g) => g.id_grupo === PRIV(1))!.cliente).toBe('');
    expect(d.grupos.find((g) => g.id_grupo === PRIV(2))!.ultima_atividade_em).toBeNull();
    expect(d.responsaveis!.grupos.map((g) => g.jid)).toEqual(['a@g.us', 'b@g.us', 'c@g.us', 'e@g.us']);
    expect(d.responsaveis!.grupos[1]!.especialista).toBeNull(); // valor cru, sem rótulo
    expect([...d.calendario.feriados].sort()).toEqual(['2026-10-12', '2026-11-02']);
  });

  it('carregarDadosRadar: uma chamada só (rpc radar_dados) e erro sem dados', async () => {
    const chamadas: string[] = [];
    const json = radarDadosEmMemoria(tabelas());
    const ok = { rpc: async (f: string) => (chamadas.push(f), { data: json, error: null }) } as unknown as SupabaseClient;
    await carregarDadosRadar(ok);
    expect(chamadas).toEqual(['radar_dados']);
    const falha = { rpc: async () => ({ data: null, error: { message: 'permission denied for function radar_dados' } }) } as unknown as SupabaseClient;
    await expect(carregarDadosRadar(falha)).rejects.toThrow('supabase (radar_dados)');
  });
});
