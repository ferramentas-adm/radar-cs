import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { montarDadosRadar, type RadarDadosJson } from '../src/api/dados.js';
import { lerConfig } from '../src/config.js';
import { calcular, type GrupoMotor, type MensagemMotor, type PromessaMotor } from '../src/motor/calcular.js';
import { formatarLocal, instanteLocal, type Calendario } from '../src/motor/expediente.js';
import type { EventoBruto, RepositorioEventos } from '../src/repositorio.js';
import {
  FUSO,
  criarDetectorRetornos,
  lerPromessas,
  montarPrompt,
  type DetectorRetornos,
  type MensagemContexto,
  type PromessaDetectada,
} from '../src/retornos/detector.js';
import { linhasPromessas } from '../src/retornos/repositorio.js';
import { buildApp } from '../src/server.js';
import { cadastroFixo } from './fixtures/cadastro.js';
import { GRUPO, NUMERO_TIME, SEGREDO, TOKEN, TOKEN_RONI, mensagemGrupo } from './fixtures/payloads.js';

const MIN = 60_000;
const H = 60 * MIN;
const sp = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00-03:00`);

// ---------- fuso ----------
describe('formatarLocal / instanteLocal', () => {
  it('ida e volta em São Paulo', () => {
    const t = sp('2026-10-23 18:00');
    expect(formatarLocal(t, FUSO)).toBe('2026-10-23 18:00');
    expect(instanteLocal('2026-10-23T18:00', FUSO)).toBe(t);
    expect(instanteLocal('2026-10-23 18:00', FUSO)).toBe(t);
  });

  it('data ou hora impossível = undefined', () => {
    for (const ruim of ['2026-02-30T10:00', '2026-10-23T24:00', '2026-10-23T10:60', 'amanhã', '2026-10-23']) {
      expect(instanteLocal(ruim, FUSO), ruim).toBeUndefined();
    }
  });
});

// ---------- leitura da resposta ----------
describe('lerPromessas', () => {
  it('só vale a promessa da mensagem alvo, com prazo convertido de São Paulo', () => {
    const r = lerPromessas(
      'Segue: [{"id_mensagem":"A1","promessa":"Enviar o boleto","prazo":"2026-10-24T18:00"},{"id_mensagem":"OUTRA","promessa":"x","prazo":"2026-10-24T18:00"}]',
      'A1',
    );
    expect(r).toEqual([{ id_mensagem: 'A1', promessa: 'Enviar o boleto', prazo: sp('2026-10-24 18:00') }]);
  });

  it('lista vazia, prazo inválido descartado, resumo cortado em 10 palavras', () => {
    expect(lerPromessas('[]', 'A1')).toEqual([]);
    expect(lerPromessas('[{"id_mensagem":"A1","promessa":"x","prazo":"sexta"}]', 'A1')).toEqual([]);
    const longa = lerPromessas(
      `[{"id_mensagem":"A1","promessa":"${'palavra '.repeat(20).trim()}","prazo":"2026-10-24T18:00"}]`,
      'A1',
    );
    expect(longa?.[0]?.promessa.split(' ')).toHaveLength(10);
  });

  it('JSON inválido ou fora do formato = null', () => {
    expect(lerPromessas('nada', 'A1')).toBeNull();
    expect(lerPromessas('[{"id_mensagem":1}]', 'A1')).toBeNull();
    expect(lerPromessas('[quebrado', 'A1')).toBeNull();
  });
});

describe('montarPrompt', () => {
  it('troca {agora} e {mensagens}, marca o alvo com >>> e mostra a hora local', () => {
    const ctx: MensagemContexto[] = [{ id: 'C1', autor: 'cliente', texto: 'cadê o boleto?', em: sp('2026-10-23 10:00') }];
    const alvo: MensagemContexto = { id: 'T1', autor: 'time', texto: 'amanhã te mando', em: sp('2026-10-23 10:05') };
    const p = montarPrompt('Agora: {agora}\n{mensagens}', sp('2026-10-23 10:06'), ctx, alvo);
    expect(p).toContain('Agora: 2026-10-23 10:06');
    expect(p).toContain('[C1] 2026-10-23 10:00 CLIENTE: cadê o boleto?');
    expect(p).toContain('>>> [T1] 2026-10-23 10:05 TIME: amanhã te mando');
  });
});

// ---------- chamada à API ----------
const respostaModelo = (texto: string, status = 200) =>
  new Response(JSON.stringify({ content: [{ type: 'text', text: texto }] }), { status });

describe('criarDetectorRetornos', () => {
  const alvo: MensagemContexto = { id: 'T1', autor: 'time', texto: 'SEGREDO-DO-TEXTO amanhã te mando', em: sp('2026-10-23 10:05') };

  it('devolve as promessas e usa o contexto lembrado do mesmo grupo', async () => {
    const corpos: string[] = [];
    const d = criarDetectorRetornos({
      chave: 'CHAVE-SECRETA',
      modelo: 'claude-haiku-5-5',
      prompt: '{agora}\n{mensagens}',
      log: { warn: () => {} },
      agora: () => sp('2026-10-23 10:06'),
      fetchImpl: async (_u, init) => {
        corpos.push(String(init!.body));
        return respostaModelo('[{"id_mensagem":"T1","promessa":"Mandar o boleto","prazo":"2026-10-24T18:00"}]');
      },
    });
    d.lembrar(GRUPO, { id: 'C1', autor: 'cliente', texto: 'cadê o boleto?', em: sp('2026-10-23 10:00') });
    d.lembrar('outro@g.us', { id: 'X', autor: 'cliente', texto: 'de outro grupo', em: sp('2026-10-23 10:00') });
    expect(await d.detectar(GRUPO, alvo)).toEqual([{ id_mensagem: 'T1', promessa: 'Mandar o boleto', prazo: sp('2026-10-24 18:00') }]);
    expect(corpos[0]).toContain('cadê o boleto?');
    expect(corpos[0]).not.toContain('de outro grupo');
  });

  it('falhas viram lista vazia e o log não leva texto nem chave', async () => {
    for (const f of [
      async () => respostaModelo('x', 500),
      async () => respostaModelo('isso não é json'),
      async () => {
        throw new TypeError('erro com CHAVE-SECRETA e SEGREDO-DO-TEXTO');
      },
    ] as (typeof fetch)[]) {
      const avisos: object[] = [];
      const d = criarDetectorRetornos({ chave: 'CHAVE-SECRETA', modelo: 'm', prompt: '{mensagens}', log: { warn: (o) => avisos.push(o) }, fetchImpl: f });
      expect(await d.detectar(GRUPO, alvo)).toEqual([]);
      expect(JSON.stringify(avisos)).not.toMatch(/SEGREDO-DO-TEXTO|CHAVE-SECRETA/);
    }
  });
});

describe('linhasPromessas', () => {
  it('uma linha por promessa; a segunda da mesma mensagem ganha #2', () => {
    const l = linhasPromessas(GRUPO, sp('2026-10-23 10:05'), [
      { id_mensagem: 'T1', promessa: 'a', prazo: sp('2026-10-24 18:00') },
      { id_mensagem: 'T1', promessa: 'b', prazo: sp('2026-10-24 18:00') },
    ]);
    expect(l.map((x) => x.id_mensagem_origem)).toEqual(['T1', 'T1#2']);
    expect(l[0]).toEqual({
      jid: GRUPO,
      promessa: 'a',
      prazo: new Date(sp('2026-10-24 18:00')).toISOString(),
      feita_em: new Date(sp('2026-10-23 10:05')).toISOString(),
      id_mensagem_origem: 'T1',
    });
  });
});

// ---------- webhook ----------
class RepoMemoria implements RepositorioEventos {
  gravados: EventoBruto[] = [];
  async gravar(e: EventoBruto) {
    this.gravados.push(e);
  }
}

async function enviar(payload: unknown, saida: PromessaDetectada[]) {
  const detectadas: string[] = [];
  const lembradas: string[] = [];
  const gravadas: { jid: string; lista: PromessaDetectada[] }[] = [];
  const detector: DetectorRetornos = {
    detectar: async (_jid, m) => (detectadas.push(m.id), saida),
    lembrar: (_jid, m) => void lembradas.push(`${m.autor}:${m.id}`),
  };
  const pasta = await mkdtemp(join(tmpdir(), 'radar-cs-ret-'));
  const { app, fila } = buildApp({
    segredo: SEGREDO,
    instancias: [
      { nome: 'observador', token: TOKEN, tipo: 'observador' },
      { nome: 'roni_ramos', token: TOKEN_RONI, tipo: 'pessoa' },
    ],
    cadastro: cadastroFixo({ ativas: [GRUPO], time: [NUMERO_TIME] }),
    repo: new RepoMemoria(),
    arquivoPendentes: join(pasta, 'p.jsonl'),
    esperaBaseMs: 1,
    logger: false,
    retornos: { detector, gravar: async (jid, _f, lista) => void gravadas.push({ jid, lista }) },
  });
  await app.inject({ method: 'POST', url: `/hooks/whatsapp/${SEGREDO}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  await new Promise<void>((r) => setImmediate(r));
  await fila.esvaziar();
  return { detectadas, lembradas, gravadas };
}

describe('webhook com IA dos retornos', () => {
  const P: PromessaDetectada = { id_mensagem: '3EB0BBBB0001', promessa: 'Mandar o boleto', prazo: sp('2026-10-24 18:00') };
  const doTime = { sender_pn: `${NUMERO_TIME}@s.whatsapp.net`, text: 'amanhã te mando' };

  it('mensagem de texto do time: detecta e grava a promessa', async () => {
    const r = await enviar(mensagemGrupo(doTime), [P]);
    expect(r.detectadas).toEqual(['3EB0BBBB0001']);
    expect(r.gravadas).toEqual([{ jid: GRUPO, lista: [P] }]);
    expect(r.lembradas).toEqual(['time:3EB0BBBB0001']);
  });

  it('mensagem do cliente: não detecta, só vira contexto', async () => {
    const r = await enviar(mensagemGrupo(), [P]);
    expect(r.detectadas).toEqual([]);
    expect(r.gravadas).toEqual([]);
    expect(r.lembradas).toEqual(['cliente:3EB0BBBB0001']);
  });

  it('reação do time não detecta nem vira contexto', async () => {
    const r = await enviar(mensagemGrupo({ ...doTime, messageType: 'ReactionMessage', text: '👍' }), [P]);
    expect(r).toEqual({ detectadas: [], lembradas: [], gravadas: [] });
  });

  it('sem promessa: nada gravado', async () => {
    const r = await enviar(mensagemGrupo(doTime), []);
    expect(r.gravadas).toEqual([]);
  });
});

// ---------- motor ----------
const AG = sp('2026-10-20 15:00');
const cal: Calendario = {
  expediente: { hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: FUSO },
  feriados: new Set(),
};

function rodar(promessas: Partial<PromessaMotor>[], time: number[] = [AG - 2 * H]) {
  const g: GrupoMotor = { id_grupo: GRUPO, cliente: 'Cliente', especialista: 'Esp', gestor: 'Gest', ativo: true, observador_entrou_em: null };
  const mensagens: MensagemMotor[] = time.map((t, i) => ({ id_mensagem: `t${i}`, id_grupo: GRUPO, autor_tipo: 'time', enviada_em: t }));
  return calcular({
    agora: AG,
    grupos: [g],
    mensagens,
    calendario: cal,
    prazo: { minutos_aviso: 20, minutos_gestor: 31 },
    observador: { status: 'conectado', desde: null },
    ultimaMensagemEm: null,
    usuario: { nome: 'p', pode_marcar: true },
    recursos: { promessas: true },
    promessas: promessas.map((p, i) => ({ id: `p${i}`, id_grupo: GRUPO, promessa: 'Mandar o boleto', prazo: AG - H, feita_em: AG - 2 * H, ...p })),
  });
}

describe('motor: retorno vencido', () => {
  it('prazo passou sem mensagem do time depois: alerta direto ao gestor, com a promessa', () => {
    const r = rodar([{}]);
    expect(r.alertas).toHaveLength(1);
    expect(r.alertas[0]!.nivel).toBe('gestor');
    expect(r.alertas[0]!.motivos).toEqual([
      { tipo: 'retorno_vencido', nivel: 'gestor', desde: new Date(AG - H).toISOString(), aviso_em: null, gestor_em: new Date(AG - H).toISOString(), promessa: 'Mandar o boleto' },
    ]);
    expect(r.resumo.retornos_vencidos).toBe(1);
    expect(r.por_especialista[0]!.retornos_vencidos).toBe(1);
    expect(r.retornos[0]).toMatchObject({ situacao: 'vencido', promessa: 'Mandar o boleto' });
    expect(r.recursos.promessas).toBe(true);
  });

  it('mensagem do time depois da promessa: cumprida, sem alerta', () => {
    const r = rodar([{}], [AG - 2 * H, AG - 90 * MIN]);
    expect(r.alertas).toHaveLength(0);
    expect(r.retornos[0]!.situacao).toBe('cumprido');
  });

  it('vence o prazo combinado mesmo fora do expediente', () => {
    // Sábado 10h: o prazo das 9h já passou, mesmo sem expediente.
    const sab = sp('2026-10-24 10:00');
    const g: GrupoMotor = { id_grupo: GRUPO, cliente: 'C', especialista: 'E', gestor: 'G', ativo: true, observador_entrou_em: null };
    const r = calcular({
      agora: sab,
      grupos: [g],
      mensagens: [{ id_mensagem: 't', id_grupo: GRUPO, autor_tipo: 'time', enviada_em: sp('2026-10-23 17:00') }],
      calendario: cal,
      prazo: { minutos_aviso: 20, minutos_gestor: 31 },
      observador: { status: 'conectado', desde: null },
      ultimaMensagemEm: null,
      usuario: { nome: 'p', pode_marcar: true },
      recursos: { promessas: true },
      promessas: [{ id: 'p', id_grupo: GRUPO, promessa: 'x', prazo: sp('2026-10-24 09:00'), feita_em: sp('2026-10-23 17:00') }],
    });
    expect(r.alertas[0]!.motivos.map((m) => m.tipo)).toContain('retorno_vencido');
  });

  it('situação: vence hoje (até 6 h) e no prazo', () => {
    expect(rodar([{ prazo: AG + 5 * H }]).retornos[0]!.situacao).toBe('vence_hoje');
    expect(rodar([{ prazo: AG + 7 * H }]).retornos[0]!.situacao).toBe('no_prazo');
    expect(rodar([{ prazo: AG + 5 * H }]).alertas).toHaveLength(0);
  });

  it('cumprida gravada no banco não alerta', () => {
    expect(rodar([{ cumprida: true }]).alertas).toHaveLength(0);
  });
});

// ---------- carregamento ----------
describe('montarDadosRadar com promessas', () => {
  const base: RadarDadosJson = {
    conversas: [],
    expediente: { hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: FUSO },
    feriados: [],
    prazo: { minutos_aviso: 20, minutos_gestor: 31 },
    ultima_mensagem_em: null,
    presencas: [],
    time: [],
    varreduras: [],
  };

  it('converte as promessas e liga o recurso', () => {
    const d = montarDadosRadar({
      ...base,
      recursos: { marcacoes: true, promessas: true },
      promessas: [{ id: 7, jid: GRUPO, promessa: 'x', prazo: '2026-10-24T21:00:00Z', feita_em: '2026-10-23T13:00:00Z', status: 'cumprida' }],
    });
    expect(d.recursos).toEqual({ marcacoes: true, promessas: true });
    expect(d.promessas).toEqual([
      { id: '7', id_grupo: GRUPO, promessa: 'x', prazo: Date.parse('2026-10-24T21:00:00Z'), feita_em: Date.parse('2026-10-23T13:00:00Z'), cumprida: true },
    ]);
  });

  it('banco sem a migration: sem promessas', () => {
    expect(montarDadosRadar(base).promessas).toBeUndefined();
  });
});

describe('RETORNOS_ATIVO', () => {
  const env = { WEBHOOK_SEGREDO: SEGREDO, UAZAPI_INSTANCE_TOKEN: TOKEN };
  it('desligado por padrão; ligado exige a chave', () => {
    expect(lerConfig({ ...env, ANTHROPIC_API_KEY: 'k' }, { exigirBanco: false }).retornos).toBeUndefined();
    expect(lerConfig({ ...env, ANTHROPIC_API_KEY: 'k', RETORNOS_ATIVO: 'true' }, { exigirBanco: false }).retornos).toEqual({
      chave: 'k',
      modelo: 'claude-haiku-5-5',
    });
    expect(() => lerConfig({ ...env, RETORNOS_ATIVO: 'true' }, { exigirBanco: false })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
