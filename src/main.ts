import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { servicoAdminSupabase } from './api/admin.js';
import { CacheRadar } from './api/cache.js';
import { carregarDadosRadar } from './api/dados.js';
import { encerrarMarcacoes, servicoMarcacoesSupabase } from './marcacoes/servico.js';
import { varrerInstancia } from './grupos/varredura.js';
import { limparRetencao } from './retencao.js';
import { criarDetectorRetornos } from './retornos/detector.js';
import { cumprirPromessas, gravarPromessasSupabase } from './retornos/repositorio.js';
import { criarClassificador } from './classificador/classificador.js';
import { CacheCadastro, carregadorSupabase } from './cadastro.js';
import { ErroConfig, lerConfig } from './config.js';
import { criarClienteSupabase } from './db/supabase.js';
import { carregarEnv } from './env.js';
import { comGanchos } from './instancias/alerta.js';
import { EstadoInstancias } from './instancias/estado.js';
import { reconciliarTodas } from './instancias/reconciliar.js';
import { registrarStatus } from './instancias/sync.js';
import { calcular } from './motor/calcular.js';
import { gravarConversaSupabase, RepositorioArquivo, RepositorioSupabase } from './repositorio.js';
import { buildApp } from './server.js';
import { ClienteUazapi } from './uazapi/cliente.js';

// Sobe o backend: receptor do webhook e, com banco, o painel (GET / e GET /api/radar).
// Com --sem-banco grava em var/eventos-dev.jsonl, sem painel e sem cadastro automático: nenhuma
// conversa passa pelo filtro, então serve só para testar a rota e o token.

const ARQUIVO_PENDENTES = 'var/eventos-pendentes.jsonl';
const ARQUIVO_DEV = 'var/eventos-dev.jsonl';
const ARQUIVO_PAINEL = 'frontend/index.html';
const ARQUIVO_ADMIN = 'frontend/admin.html';
const ARQUIVO_PROMPT_CLASSIFICADOR = 'prompts/classificador.md';
const ARQUIVO_PROMPT_RETORNOS = 'prompts/retornos.md';
const RECARGA_CADASTRO_MS = 60_000;
const CONSULTA_STATUS_MS = 2 * 60_000;
const RECONCILIA_MS = 5 * 60_000;
const ENCERRA_MARCACOES_MS = 60_000;
const VARREDURA_MS = 24 * 60 * 60_000;
/** Primeira varredura automática alguns minutos depois de subir (a reconciliação vai antes). */
const VARREDURA_INICIAL_MS = 10 * 60_000;
const RETENCAO_MS = 24 * 60 * 60_000;

async function main(): Promise<void> {
  carregarEnv();
  const semBanco = process.argv.includes('--sem-banco');

  let config;
  try {
    config = lerConfig(process.env, { exigirBanco: !semBanco });
  } catch (e) {
    if (e instanceof ErroConfig) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const db = !semBanco && config.supabase ? criarClienteSupabase(config.supabase) : undefined;
  const repo = db ? new RepositorioSupabase(db) : new RepositorioArquivo(ARQUIVO_DEV);

  // O log do cadastro usa o logger do app, que só existe depois do buildApp.
  let app: FastifyInstance | undefined;
  const cadastro = new CacheCadastro(
    db ? carregadorSupabase(db) : async () => ({ conversas: [], time: [] }),
    {
      info: (obj, msg) => app?.log.info(obj, msg),
      warn: (obj, msg) => app?.log.warn(obj, msg),
    },
  );

  const estado = new EstadoInstancias(config.instancias.map((i) => i.nome));
  // Passo 5 (saúde): persiste o status por instância e avisa (hoje só por log; sem provedor de
  // e-mail configurado) quando uma instância que estava conectada cai.
  const estadoComGanchos = comGanchos(estado, {
    ...(db
      ? {
          aoRegistrar: (nome: string, status: string) => {
            void registrarStatus(db, nome, status).catch((e: unknown) =>
              app?.log.warn({ instancia: nome, erro: (e as Error).message }, 'falha ao gravar status em sync_estado'),
            );
          },
        }
      : {}),
    aoCair: (nome: string) => {
      app?.log.error({ instancia: nome }, 'ALERTA GESTOR: instância desconectada');
    },
  });
  const painelCfg = config.painel;
  // Uma consulta ao banco a cada 30 s, no máximo, por mais painéis que estejam abertos.
  const cacheRadar = db ? new CacheRadar(() => carregarDadosRadar(db)) : undefined;
  const painel =
    cacheRadar && painelCfg
      ? {
          usuario: painelCfg.usuario,
          senha: painelCfg.senha,
          html: await readFile(ARQUIVO_PAINEL, 'utf8'),
          radar: async (usuario: string, admin: boolean) =>
            calcular({
              ...(await cacheRadar.obter()),
              agora: Date.now(),
              observador: estado.resumo(),
              usuario: { nome: usuario, pode_marcar: true, admin },
            }),
          marcacoes: servicoMarcacoesSupabase(
            db!,
            async () => (await cacheRadar.obter()).calendario,
            () => cacheRadar.invalidar(),
          ),
          // Tela de configurações: só com a conta de administrador no .env. Gravou, o cache do radar
          // é descartado para o expediente, os feriados e os prazos novos valerem já no próximo pedido.
          ...(db && painelCfg.admin
            ? {
                admin: {
                  usuario: painelCfg.admin.usuario,
                  senha: painelCfg.admin.senha,
                  html: await readFile(ARQUIVO_ADMIN, 'utf8'),
                  servico: servicoAdminSupabase(db, () => cacheRadar.invalidar()),
                },
              }
            : {}),
        }
      : undefined;

  // Cadastro automático: só com banco. /group/info pela instância que viu o grupo.
  const baseUrl = config.uazapiBaseUrl;
  const clientes = new Map(
    baseUrl ? config.instancias.map((i) => [i.nome, new ClienteUazapi(baseUrl, i.token)] as const) : [],
  );
  const conversas = db
    ? {
        chaves: config.chaves,
        observadorNumero: config.observadorNumero,
        consultarParticipantes: baseUrl
          ? (instancia: string, jid: string) => clientes.get(instancia)!.participantesDoGrupo(jid)
          : undefined,
        gravarConversa: gravarConversaSupabase(db),
      }
    : undefined;

  // Classificador de urgência: só com CLASSIFICADOR_ATIVO=true e a chave da Anthropic. O texto das
  // mensagens do cliente (só de grupo) vai à API e não é guardado.
  const classificador = config.classificador
    ? criarClassificador({
        chave: config.classificador.chave,
        modelo: config.classificador.modelo,
        prompt: await readFile(ARQUIVO_PROMPT_CLASSIFICADOR, 'utf8'),
        log: { warn: (obj, msg) => app?.log.warn(obj, msg) },
      })
    : undefined;

  // IA dos retornos: só com RETORNOS_ATIVO=true, a chave da Anthropic e banco. O texto das mensagens
  // do time e do cliente (só de grupo) vai à API e não é guardado; no banco fica só o resumo e o prazo.
  const retornos =
    config.retornos && db
      ? {
          detector: criarDetectorRetornos({
            chave: config.retornos.chave,
            modelo: config.retornos.modelo,
            prompt: await readFile(ARQUIVO_PROMPT_RETORNOS, 'utf8'),
            log: { warn: (obj, msg) => app?.log.warn(obj, msg) },
          }),
          gravar: gravarPromessasSupabase(db),
        }
      : undefined;

  const montado = buildApp({
    segredo: config.webhookSegredo,
    instancias: config.instancias,
    cadastro,
    repo,
    arquivoPendentes: ARQUIVO_PENDENTES,
    estado: estadoComGanchos,
    ...(classificador ? { classificador } : {}),
    ...(retornos ? { retornos } : {}),
    ...(painel ? { painel } : {}),
    ...(conversas ? { conversas } : {}),
  });
  app = montado.app;
  const { fila } = montado;

  // Sem a primeira carga do cadastro o receptor descartaria tudo: não sobe.
  await cadastro.atualizar();
  cadastro.iniciar(RECARGA_CADASTRO_MS);

  // Instância de pessoa sem dono em time.instancia não cadastra conversa nova (só o nome da instância).
  const semDono = config.instancias.filter((i) => i.tipo === 'pessoa' && !cadastro.responsavel(i.nome));
  if (semDono.length > 0) {
    app.log.warn({ instancias: semDono.map((i) => i.nome) }, 'instância sem dono em time.instancia: não cadastra conversa nova');
  }

  // Status das instâncias: além dos eventos "connection", consulta /instance/status de cada uma.
  const consultarStatus = async () => {
    for (const i of config.instancias) {
      const cliente = clientes.get(i.nome);
      if (!cliente) break;
      try {
        const { status } = await cliente.instanceStatus();
        estadoComGanchos.registrar(i.nome, status, Date.now());
      } catch (e) {
        // Sem resposta da uazapi não dá para afirmar que está conectada.
        estadoComGanchos.registrar(i.nome, 'desconhecido', Date.now());
        app?.log.warn({ instancia: i.nome, erro: (e as Error).message }, 'falha ao consultar status');
      }
    }
  };
  if (!baseUrl) {
    app.log.warn(
      'sem UAZAPI_BASE_URL: status das instâncias só pelos eventos do webhook, e grupo novo em que o time ' +
        'escreveu primeiro não é cadastrado (falta a consulta de participantes)',
    );
  }
  const timerStatus = setInterval(() => void consultarStatus(), CONSULTA_STATUS_MS);
  timerStatus.unref();

  // Passo 5 (reconciliação): ao subir e a cada poucos minutos, busca o que o webhook não entregou.
  const reconciliar = async () => {
    if (!db) return;
    const resumos = await reconciliarTodas(db, config.instancias, clientes, config.chaves?.cifra, (instancia, e) => {
      app?.log.warn({ instancia, erro: (e as Error).message }, 'falha ao reconciliar instância');
    });
    const conversas = resumos.reduce((n, r) => n + r.conversas, 0);
    const falhas = resumos.reduce((n, r) => n + r.falhas, 0);
    const novas = resumos.reduce((n, r) => n + r.novas, 0);
    app?.log.info({ instancias: resumos.length, conversas, conversas_com_falha: falhas, mensagens_recuperadas: novas }, 'reconciliação');
  };
  const timerReconciliar = setInterval(() => void reconciliar(), RECONCILIA_MS);
  timerReconciliar.unref();

  // Marcações ("Registrar ação feita") que já acabaram: só histórico, o motor decide sozinho. Falha de
  // banco (ou migration ainda não aplicada) vira aviso, nunca derruba o serviço.
  const fecharMarcacoes = async () => {
    if (!db) return;
    try {
      await encerrarMarcacoes(db);
    } catch (e) {
      app?.log.warn({ erro: (e as Error).message }, 'falha ao encerrar marcações');
    }
    try {
      await cumprirPromessas(db);
    } catch (e) {
      app?.log.warn({ erro: (e as Error).message }, 'falha ao marcar promessas cumpridas');
    }
  };
  const timerMarcacoes = setInterval(() => void fecharMarcacoes(), ENCERRA_MARCACOES_MS);
  timerMarcacoes.unref();

  // Varredura automática (VARREDURA_AUTOMATICA=true): uma vez por dia, uma instância de pessoa por vez,
  // grava cadastro, presença e regra do responsável, como `grupos:varrer --gravar`. Log só com contagens.
  let varrendo = false;
  const varrerTodas = async () => {
    if (!db || varrendo) return;
    varrendo = true;
    try {
      for (const i of config.instancias.filter((x) => x.tipo === 'pessoa')) {
        const uazapi = clientes.get(i.nome);
        if (!uazapi) continue;
        try {
          const r = await varrerInstancia(db, { nome: i.nome, uazapi, gravar: true, observador: config.observadorNumero });
          if (!r.ok) {
            app?.log.warn({ instancia: i.nome }, 'varredura automática: instância sem dono em time.instancia');
            continue;
          }
          const c = r.contagens;
          app?.log.info(
            {
              instancia: i.nome,
              listagem_ok: c.listagem.ok,
              ...(c.listagem.ok ? {} : { motivo: c.listagem.motivo }),
              grupos_listados: c.classificacao?.listados ?? 0,
              cadastrados: c.cadastrados ?? 0,
              falhas_cadastro: c.falhasCadastro ?? 0,
              presencas: c.presencasGravadas ?? 0,
              trocas: c.trocasGravadas ?? 0,
              aguardando_definicao: c.responsaveis.aguardandoLista.length,
              sem_varredura_recente: c.responsaveis.semVarreduraRecente.length,
            },
            'varredura automática',
          );
        } catch (e) {
          app?.log.warn({ instancia: i.nome, erro: (e as Error).message }, 'falha na varredura automática');
        }
      }
    } finally {
      varrendo = false;
    }
  };
  const timersVarredura: NodeJS.Timeout[] = [];
  if (config.varreduraAutomatica && db && baseUrl) {
    const t1 = setTimeout(() => void varrerTodas(), VARREDURA_INICIAL_MS);
    const t2 = setInterval(() => void varrerTodas(), VARREDURA_MS);
    t1.unref();
    t2.unref();
    timersVarredura.push(t1, t2);
  }

  // Retenção (LGPD), uma vez por dia com RETENCAO_ATIVA=true. Apagar não tem volta: desligada por padrão.
  const limpar = async () => {
    if (!db) return;
    try {
      const r = await limparRetencao(db);
      app?.log.info({ mensagens_apagadas: r.mensagens, eventos_brutos_apagados: r.eventos_brutos }, 'retenção');
    } catch (e) {
      app?.log.warn({ erro: (e as Error).message }, 'falha na limpeza de retenção');
    }
  };
  if (config.retencaoAtiva && db) {
    const t = setInterval(() => void limpar(), RETENCAO_MS);
    t.unref();
    timersVarredura.push(t);
  }

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    app?.log.info({ sinal, gravacoes_em_andamento: fila.pendentes }, 'encerrando');
    cadastro.parar();
    clearInterval(timerStatus);
    clearInterval(timerReconciliar);
    clearInterval(timerMarcacoes);
    for (const t of timersVarredura) clearTimeout(t);
    await app?.close();
    await fila.esvaziar();
    process.exit(0);
  };
  process.on('SIGINT', () => void encerrar('SIGINT'));
  process.on('SIGTERM', () => void encerrar('SIGTERM'));

  // Só localhost: o túnel (e depois o proxy do servidor) é quem expõe para fora.
  await app.listen({ host: '127.0.0.1', port: config.porta });
  app.log.info({ classificador: classificador ? config.classificador?.modelo : 'desligado' }, 'classificador de urgência');
  app.log.info({ varredura_automatica: config.varreduraAutomatica && !!db && !!baseUrl }, 'varredura automática');
  app.log.info({ retencao: config.retencaoAtiva && !!db }, 'limpeza de retenção (LGPD)');
  app.log.info({ retornos: retornos ? config.retornos?.modelo : 'desligado' }, 'IA dos retornos');
  app.log.info(
    { destino: semBanco ? ARQUIVO_DEV : 'supabase', instancias: config.instancias.map((i) => i.nome) },
    'receptor do webhook no ar',
  );
  if (semBanco) app.log.warn('--sem-banco: sem cadastro e sem painel; todas as mensagens são descartadas');

  // Status e reconciliação da subida rodam depois de abrir a porta: com muitas conversas a
  // reconciliação demora minutos, e o painel e o webhook não podem esperar por ela.
  void (async () => {
    await consultarStatus();
    await reconciliar();
  })().catch((e: unknown) => app?.log.warn({ erro: (e as Error).message }, 'falha na verificação inicial'));

  const reenviados = await fila.reenviarPendentes();
  if (reenviados > 0) app.log.info({ reenviados }, 'eventos pendentes reenviados');
}

main().catch((e: unknown) => {
  console.error('falha ao subir:', (e as Error).name, (e as Error).message);
  process.exit(1);
});
