import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  criarClassificador,
  lerClassificacao,
  montarEntrada,
  type Classificacao,
  type Classificador,
} from '../src/classificador/classificador.js';
import { ErroConfig, lerConfig } from '../src/config.js';
import { montarDadosRadar, type RadarDadosJson } from '../src/api/dados.js';
import { calcular, type EntradaMotor, type GrupoMotor, type MensagemMotor } from '../src/motor/calcular.js';
import type { Calendario } from '../src/motor/expediente.js';
import type { EventoBruto, RepositorioEventos } from '../src/repositorio.js';
import { buildApp } from '../src/server.js';
import { cadastroFixo } from './fixtures/cadastro.js';
import { GRUPO, NUMERO_TIME, SEGREDO, TEXTO, TOKEN, TOKEN_RONI, mensagemGrupo } from './fixtures/payloads.js';

// ---------- leitura da resposta do modelo ----------
describe('lerClassificacao', () => {
  it('JSON puro e JSON dentro de ```', () => {
    const esperado = { categoria: 'reclamação', urgencia: 'alto', exige_resposta: true };
    expect(lerClassificacao(JSON.stringify(esperado))).toEqual(esperado);
    expect(lerClassificacao('```json\n' + JSON.stringify(esperado) + '\n```')).toEqual(esperado);
  });

  it('inválido: sem JSON, nível desconhecido, campo faltando ou tipo errado vira null', () => {
    expect(lerClassificacao('não sei')).toBeNull();
    expect(lerClassificacao('{"categoria":"x","urgencia":"urgentissimo","exige_resposta":true}')).toBeNull();
    expect(lerClassificacao('{"categoria":"x","urgencia":"alto"}')).toBeNull();
    expect(lerClassificacao('{"categoria":"x","urgencia":"alto","exige_resposta":"sim"}')).toBeNull();
    expect(lerClassificacao('{ quebrado')).toBeNull();
  });

  it('categoria comprida é cortada em 40 caracteres', () => {
    const r = lerClassificacao(JSON.stringify({ categoria: 'a'.repeat(100), urgencia: 'baixo', exige_resposta: false }));
    expect(r?.categoria).toHaveLength(40);
  });
});

describe('montarEntrada', () => {
  it('põe o texto entre <<< >>> e o contexto antes, com o autor', () => {
    const e = montarEntrada([{ autor: 'time', texto: 'oi' }, { autor: 'cliente', texto: 'tudo bem?' }], 'preciso do boleto');
    expect(e).toContain('TIME: oi');
    expect(e).toContain('CLIENTE: tudo bem?');
    expect(e).toContain('<<<\npreciso do boleto\n>>>');
  });

  it('corta texto muito longo', () => {
    expect(montarEntrada([], 'x'.repeat(5000)).length).toBeLessThan(2300);
  });
});

// ---------- chamada à API ----------
const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const saidaModelo = (texto: string) => resposta({ content: [{ type: 'text', text: texto }] });

function criar(fetchImpl: typeof fetch, extra: { concorrencia?: number } = {}) {
  const avisos: object[] = [];
  const c = criarClassificador({
    chave: 'CHAVE-SECRETA-ANTHROPIC',
    modelo: 'claude-haiku-5-5',
    prompt: 'PROMPT',
    log: { warn: (obj) => avisos.push(obj) },
    fetchImpl,
    ...extra,
  });
  return { c, avisos };
}

describe('criarClassificador', () => {
  it('chama a API com o modelo, a chave e o texto, e devolve a classificação', async () => {
    let req: { url: string; init: RequestInit } | undefined;
    const { c } = criar(async (url, init) => {
      req = { url: String(url), init: init! };
      return saidaModelo('{"categoria":"cancelamento","urgencia":"alto","exige_resposta":true}');
    });
    const r = await c.classificar({ jid: GRUPO, texto: 'quero cancelar tudo' });
    expect(r).toEqual({ categoria: 'cancelamento', urgencia: 'alto', exige_resposta: true });
    expect(req?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = req?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('CHAVE-SECRETA-ANTHROPIC');
    const corpo = JSON.parse(String(req?.init.body));
    expect(corpo.model).toBe('claude-haiku-5-5');
    expect(corpo.system).toBe('PROMPT');
    expect(corpo.messages[0].content).toContain('quero cancelar tudo');
  });

  it('o contexto lembrado (só em memória) vai na chamada seguinte do mesmo grupo', async () => {
    const corpos: string[] = [];
    const { c } = criar(async (_u, init) => {
      corpos.push(String(init!.body));
      return saidaModelo('{"categoria":"dúvida","urgencia":"medio","exige_resposta":true}');
    });
    c.lembrar(GRUPO, 'time', 'segue o boleto');
    c.lembrar('outro@g.us', 'cliente', 'mensagem de outro grupo');
    await c.classificar({ jid: GRUPO, texto: 'e o prazo?' });
    expect(corpos[0]).toContain('TIME: segue o boleto');
    expect(corpos[0]).not.toContain('outro grupo');
  });

  it('falhas viram null (vale médio) e o log não leva texto, chave nem corpo', async () => {
    const casos: typeof fetch[] = [
      async () => resposta({ erro: 'x' }, 500),
      async () => resposta({ erro: 'x' }, 429),
      async () => saidaModelo('isso não é JSON'),
      async () => {
        throw new TypeError('falha com CHAVE-SECRETA-ANTHROPIC e texto SEGREDO-DO-CLIENTE');
      },
      async () => new Response('não é json', { status: 200 }),
    ];
    for (const f of casos) {
      const { c, avisos } = criar(f);
      expect(await c.classificar({ jid: GRUPO, texto: 'SEGREDO-DO-CLIENTE' })).toBeNull();
      const log = JSON.stringify(avisos);
      expect(log).not.toContain('SEGREDO-DO-CLIENTE');
      expect(log).not.toContain('CHAVE-SECRETA');
    }
  });

  it('respeita o limite de chamadas ao mesmo tempo', async () => {
    let ativas = 0;
    let maximo = 0;
    const { c } = criar(
      async () => {
        ativas++;
        maximo = Math.max(maximo, ativas);
        await new Promise((r) => setTimeout(r, 5));
        ativas--;
        return saidaModelo('{"categoria":"dúvida","urgencia":"medio","exige_resposta":true}');
      },
      { concorrencia: 2 },
    );
    await Promise.all(Array.from({ length: 8 }, (_, i) => c.classificar({ jid: GRUPO, texto: `m${i}` })));
    expect(maximo).toBe(2);
  });
});

// ---------- webhook ----------
class RepoMemoria implements RepositorioEventos {
  gravados: EventoBruto[] = [];
  async gravar(e: EventoBruto) {
    this.gravados.push(e);
  }
}

class ClassificadorFalso implements Classificador {
  chamadas: { jid: string; texto: string }[] = [];
  lembrados: { jid: string; autor: string; texto: string }[] = [];
  constructor(private readonly saida: Classificacao | null) {}
  async classificar(e: { jid: string; texto: string }) {
    this.chamadas.push(e);
    return this.saida;
  }
  lembrar(jid: string, autor: 'cliente' | 'time', texto: string) {
    this.lembrados.push({ jid, autor, texto });
  }
}

const proximoTique = () => new Promise<void>((r) => setImmediate(r));

async function enviar(payload: unknown, classificador: Classificador | undefined) {
  const repo = new RepoMemoria();
  const pasta = await mkdtemp(join(tmpdir(), 'radar-cs-'));
  const { app, fila } = buildApp({
    segredo: SEGREDO,
    instancias: [
      { nome: 'observador', token: TOKEN, tipo: 'observador' },
      { nome: 'roni_ramos', token: TOKEN_RONI, tipo: 'pessoa' },
    ],
    cadastro: cadastroFixo({ ativas: [GRUPO], time: [NUMERO_TIME] }),
    repo,
    arquivoPendentes: join(pasta, 'pendentes.jsonl'),
    esperaBaseMs: 1,
    logger: false,
    ...(classificador ? { classificador } : {}),
  });
  await app.inject({
    method: 'POST',
    url: `/hooks/whatsapp/${SEGREDO}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
  await proximoTique();
  await fila.esvaziar();
  return repo.gravados;
}

describe('webhook com classificador', () => {
  const ALTO: Classificacao = { categoria: 'reclamação', urgencia: 'alto', exige_resposta: true };

  it('mensagem de texto do cliente: grava a classificação junto, e o texto continua só como máscara', async () => {
    const f = new ClassificadorFalso(ALTO);
    const gravados = await enviar(mensagemGrupo(), f);
    expect(f.chamadas).toEqual([{ jid: GRUPO, texto: TEXTO }]);
    expect(gravados).toHaveLength(1);
    expect(gravados[0]!.mensagem).toMatchObject({ categoria: 'reclamação', urgencia: 'alto', exige_resposta: true });
    expect(gravados[0]!.mensagem?.texto).toMatch(/^\[texto omitido: \d+ caracteres\]$/);
    expect(JSON.stringify(gravados)).not.toContain('boleto');
  });

  it('falha do classificador: grava sem classificação (vale médio) e não perde a mensagem', async () => {
    const gravados = await enviar(mensagemGrupo(), new ClassificadorFalso(null));
    expect(gravados).toHaveLength(1);
    const m = gravados[0]!.mensagem!;
    expect(m.urgencia).toBeUndefined();
    expect(m.exige_resposta).toBeUndefined();
  });

  it('sem classificador: nada muda', async () => {
    const gravados = await enviar(mensagemGrupo(), undefined);
    expect(gravados[0]!.mensagem?.urgencia).toBeUndefined();
  });

  it('mensagem do time não é classificada, mas vira contexto', async () => {
    const f = new ClassificadorFalso(ALTO);
    const gravados = await enviar(
      mensagemGrupo({ sender_pn: `${NUMERO_TIME}@s.whatsapp.net`, text: 'Já estou vendo' }),
      f,
    );
    expect(f.chamadas).toHaveLength(0);
    expect(f.lembrados).toEqual([{ jid: GRUPO, autor: 'time', texto: 'Já estou vendo' }]);
    expect(gravados[0]!.mensagem?.urgencia).toBeUndefined();
  });

  it('áudio do cliente e reação não são classificados (sem texto para a IA)', async () => {
    const f = new ClassificadorFalso(ALTO);
    await enviar(mensagemGrupo({ messageType: 'AudioMessage', text: '' }), f);
    await enviar(mensagemGrupo({ messageType: 'ReactionMessage', text: '👍', messageid: 'R1' }), f);
    expect(f.chamadas).toHaveLength(0);
  });
});

// ---------- motor: cada mensagem no prazo do seu nível ----------
const MIN = 60_000;
const sp = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00-03:00`);
const AG = sp('2026-10-20 15:00'); // terça, meio do expediente
const ago = (m: number) => AG - m * MIN;
const cal: Calendario = {
  expediente: { hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
  feriados: new Set(),
};
const PRAZOS = {
  alto: { minutos_aviso: 10, minutos_gestor: 15 },
  medio: { minutos_aviso: 20, minutos_gestor: 31 },
  baixo: { minutos_aviso: 60, minutos_gestor: 90 },
};

function rodar(msgs: Pick<MensagemMotor, 'enviada_em' | 'urgencia'>[], sobre: Partial<EntradaMotor> = {}, tipo: GrupoMotor['tipo'] = 'grupo', semPrazos = false) {
  const grupo: GrupoMotor = {
    id_grupo: 'g1@g.us',
    cliente: 'Cliente',
    especialista: 'Esp',
    gestor: 'Gest',
    ativo: true,
    observador_entrou_em: null,
    tipo,
    ultima_atividade_em: AG,
  };
  const mensagens: MensagemMotor[] = [
    { id_mensagem: 't', id_grupo: grupo.id_grupo, autor_tipo: 'time', enviada_em: ago(1000) },
    ...msgs.map((m, i) => ({ id_mensagem: `c${i}`, id_grupo: grupo.id_grupo, autor_tipo: 'cliente' as const, ...m })),
  ];
  return calcular({
    agora: AG,
    grupos: [grupo],
    mensagens,
    calendario: cal,
    prazo: PRAZOS.medio,
    ...(semPrazos ? {} : { prazos: PRAZOS }),
    observador: { status: 'conectado', desde: null },
    ultimaMensagemEm: null,
    usuario: { nome: 'p', pode_marcar: false },
    ...sobre,
  });
}
const nivelSemResposta = (r: ReturnType<typeof rodar>) => r.alertas[0]?.motivos.find((m) => m.tipo === 'sem_resposta')?.nivel;

describe('motor: prazo por nível de urgência', () => {
  it('alto: 9 min nada, 10 min aviso, 15 min gestor', () => {
    expect(rodar([{ enviada_em: ago(9), urgencia: 'alto' }]).alertas).toHaveLength(0);
    expect(nivelSemResposta(rodar([{ enviada_em: ago(10), urgencia: 'alto' }]))).toBe('aviso');
    expect(nivelSemResposta(rodar([{ enviada_em: ago(15), urgencia: 'alto' }]))).toBe('gestor');
  });

  it('baixo: 59 min nada, 60 min aviso, 90 min gestor', () => {
    expect(rodar([{ enviada_em: ago(59), urgencia: 'baixo' }]).alertas).toHaveLength(0);
    expect(nivelSemResposta(rodar([{ enviada_em: ago(60), urgencia: 'baixo' }]))).toBe('aviso');
    expect(nivelSemResposta(rodar([{ enviada_em: ago(90), urgencia: 'baixo' }]))).toBe('gestor');
  });

  it('sem classificação vale médio: 19 min nada, 20 aviso, 31 gestor', () => {
    expect(rodar([{ enviada_em: ago(19) }]).alertas).toHaveLength(0);
    expect(nivelSemResposta(rodar([{ enviada_em: ago(20) }]))).toBe('aviso');
    expect(nivelSemResposta(rodar([{ enviada_em: ago(31) }]))).toBe('gestor');
  });

  it('sem prazos por nível, tudo usa o prazo médio', () => {
    expect(nivelSemResposta(rodar([{ enviada_em: ago(20), urgencia: 'alto' }], {}, 'grupo', true))).toBe('aviso');
    expect(rodar([{ enviada_em: ago(10), urgencia: 'alto' }], {}, 'grupo', true).alertas).toHaveLength(0);
  });

  it('níveis diferentes: cada uma no seu prazo e o alerta mostra a mais grave', () => {
    // médio com 25 min (aviso) e alto com 16 min (gestor): o alerta é do alto, em gestor.
    const r = rodar([
      { enviada_em: ago(25), urgencia: 'medio' },
      { enviada_em: ago(16), urgencia: 'alto' },
    ]);
    const m = r.alertas[0]!.motivos.find((x) => x.tipo === 'sem_resposta')!;
    expect(m.nivel).toBe('gestor');
    expect(m.desde).toBe(new Date(ago(16)).toISOString());
    // A pilha mostra o estado pior e a mais antiga.
    expect(r.pendentes[0]).toMatchObject({ quantidade: 2, estado: 'gestor', mais_antiga_desde: new Date(ago(25)).toISOString() });
  });

  it('uma baixa antiga ainda no prazo não esconde uma média em aviso', () => {
    const r = rodar([
      { enviada_em: ago(50), urgencia: 'baixo' }, // 50 min: ainda no prazo (60)
      { enviada_em: ago(22), urgencia: 'medio' }, // aviso
    ]);
    expect(nivelSemResposta(r)).toBe('aviso');
    expect(r.alertas[0]!.motivos.find((x) => x.tipo === 'sem_resposta')!.desde).toBe(new Date(ago(22)).toISOString());
  });

  it('privada: conta como sem resposta se alguma pendente passou do aviso do seu nível', () => {
    const r = rodar([{ enviada_em: ago(12), urgencia: 'alto' }], {}, 'privada');
    expect(r.por_especialista[0]!.conversas_privadas_sem_resposta).toBe(1);
    const nao = rodar([{ enviada_em: ago(12), urgencia: 'baixo' }], {}, 'privada');
    expect(nao.por_especialista[0]!.conversas_privadas_sem_resposta).toBe(0);
  });
});

// ---------- carregamento ----------
describe('montarDadosRadar com classificação', () => {
  const base: RadarDadosJson = {
    conversas: [
      {
        jid: 'g@g.us',
        tipo: 'grupo',
        nome: 'G',
        especialista: 'E',
        gestor: 'X',
        observador_entrou_em: null,
        principal_definido_em: null,
        ultima_time: null,
        pendentes: [
          { id_mensagem: 'a', enviada_em: '2026-10-20T17:00:00Z', urgencia: 'alto' },
          { id_mensagem: 'b', enviada_em: '2026-10-20T17:01:00Z', urgencia: null },
          { id_mensagem: 'c', enviada_em: '2026-10-20T17:02:00Z' },
        ],
        ultima_atividade_em: null,
      },
    ],
    expediente: { hora_inicio: '09:00:00', hora_fim: '19:00:00', dias_uteis: [1, 2, 3, 4, 5], fuso: 'America/Sao_Paulo' },
    feriados: [],
    prazo: PRAZOS.medio,
    ultima_mensagem_em: null,
    presencas: [],
    time: [],
    varreduras: [],
  };

  it('leva a urgência das pendentes e os prazos por nível', () => {
    const d = montarDadosRadar({
      ...base,
      prazos: [
        { urgencia: 'alto', ...PRAZOS.alto },
        { urgencia: 'medio', ...PRAZOS.medio },
        { urgencia: 'baixo', ...PRAZOS.baixo },
      ],
    });
    expect(d.mensagens.map((m) => m.urgencia)).toEqual(['alto', undefined, undefined]);
    expect(d.prazos).toEqual(PRAZOS);
  });

  it('banco sem a migration (sem prazos nem urgência): tudo vale médio', () => {
    const d = montarDadosRadar(base);
    expect(d.prazos).toBeUndefined();
  });
});

// ---------- configuração ----------
describe('configuração do classificador', () => {
  const env = { WEBHOOK_SEGREDO: SEGREDO, UAZAPI_INSTANCE_TOKEN: TOKEN };
  const ler = (extra: Record<string, string>) => lerConfig({ ...env, ...extra }, { exigirBanco: false });

  it('desligado por padrão, mesmo com a chave da Anthropic no ambiente', () => {
    expect(ler({}).classificador).toBeUndefined();
    expect(ler({ ANTHROPIC_API_KEY: 'chave' }).classificador).toBeUndefined();
    expect(ler({ ANTHROPIC_API_KEY: 'chave', CLASSIFICADOR_ATIVO: 'false' }).classificador).toBeUndefined();
  });

  it('ligado: modelo padrão claude-haiku-5-5 ou o informado', () => {
    expect(ler({ ANTHROPIC_API_KEY: 'chave', CLASSIFICADOR_ATIVO: 'true' }).classificador).toEqual({
      chave: 'chave',
      modelo: 'claude-haiku-5-5',
    });
    expect(
      ler({ ANTHROPIC_API_KEY: 'chave', CLASSIFICADOR_ATIVO: 'true', CLASSIFICADOR_MODELO: 'claude-haiku-5-6' }).classificador?.modelo,
    ).toBe('claude-haiku-5-6');
  });

  it('ligado sem a chave: recusa, citando só o nome da variável', () => {
    expect(() => ler({ CLASSIFICADOR_ATIVO: 'true' })).toThrow(ErroConfig);
    expect(() => ler({ CLASSIFICADOR_ATIVO: 'true' })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
