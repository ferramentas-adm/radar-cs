import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { carregarDadosRadar } from './api/dados.js';
import { CacheCadastro, carregadorSupabase } from './cadastro.js';
import { ErroConfig, lerConfig } from './config.js';
import { criarClienteSupabase } from './db/supabase.js';
import { carregarEnv } from './env.js';
import { EstadoInstancias } from './instancias/estado.js';
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
const RECARGA_CADASTRO_MS = 60_000;
const CONSULTA_STATUS_MS = 2 * 60_000;

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
  const painelCfg = config.painel;
  const painel =
    db && painelCfg
      ? {
          usuario: painelCfg.usuario,
          senha: painelCfg.senha,
          html: await readFile(ARQUIVO_PAINEL, 'utf8'),
          radar: async (usuario: string) =>
            calcular({
              ...(await carregarDadosRadar(db)),
              agora: Date.now(),
              observador: estado.resumo(),
              usuario: { nome: usuario, pode_marcar: false }, // "Registrar ação feita" fora desta fatia
            }),
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

  const montado = buildApp({
    segredo: config.webhookSegredo,
    instancias: config.instancias,
    cadastro,
    repo,
    arquivoPendentes: ARQUIVO_PENDENTES,
    estado,
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
        estado.registrar(i.nome, status, Date.now());
      } catch (e) {
        // Sem resposta da uazapi não dá para afirmar que está conectada.
        estado.registrar(i.nome, 'desconhecido', Date.now());
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
  await consultarStatus();
  const timerStatus = setInterval(() => void consultarStatus(), CONSULTA_STATUS_MS);
  timerStatus.unref();

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    app?.log.info({ sinal, gravacoes_em_andamento: fila.pendentes }, 'encerrando');
    cadastro.parar();
    clearInterval(timerStatus);
    await app?.close();
    await fila.esvaziar();
    process.exit(0);
  };
  process.on('SIGINT', () => void encerrar('SIGINT'));
  process.on('SIGTERM', () => void encerrar('SIGTERM'));

  // Só localhost: o túnel (e depois o proxy do servidor) é quem expõe para fora.
  await app.listen({ host: '127.0.0.1', port: config.porta });
  app.log.info(
    { destino: semBanco ? ARQUIVO_DEV : 'supabase', instancias: config.instancias.map((i) => i.nome) },
    'receptor do webhook no ar',
  );
  if (semBanco) app.log.warn('--sem-banco: sem cadastro e sem painel; todas as mensagens são descartadas');

  const reenviados = await fila.reenviarPendentes();
  if (reenviados > 0) app.log.info({ reenviados }, 'eventos pendentes reenviados');
}

main().catch((e: unknown) => {
  console.error('falha ao subir:', (e as Error).name, (e as Error).message);
  process.exit(1);
});
