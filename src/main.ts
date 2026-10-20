import { ErroConfig, lerConfig } from './config.js';
import { criarClienteSupabase } from './db/supabase.js';
import { carregarEnv } from './env.js';
import { RepositorioArquivo, RepositorioSupabase } from './repositorio.js';
import { buildApp } from './server.js';

// Sobe o backend. Com --sem-banco grava os eventos em var/eventos-dev.jsonl (enquanto o Supabase não existe).

const ARQUIVO_PENDENTES = 'var/eventos-pendentes.jsonl';
const ARQUIVO_DEV = 'var/eventos-dev.jsonl';

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

  const repo =
    semBanco || !config.supabase
      ? new RepositorioArquivo(ARQUIVO_DEV)
      : new RepositorioSupabase(criarClienteSupabase(config.supabase));

  const { app, fila } = buildApp({
    segredo: config.webhookSegredo,
    tokenInstancia: config.uazapiToken,
    guardarTexto: config.guardarTexto,
    repo,
    arquivoPendentes: ARQUIVO_PENDENTES,
  });

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    app.log.info({ sinal, gravacoes_em_andamento: fila.pendentes }, 'encerrando');
    await app.close();
    await fila.esvaziar();
    process.exit(0);
  };
  process.on('SIGINT', () => void encerrar('SIGINT'));
  process.on('SIGTERM', () => void encerrar('SIGTERM'));

  // Só localhost: o túnel (e depois o proxy do servidor) é quem expõe para fora.
  await app.listen({ host: '127.0.0.1', port: config.porta });
  app.log.info(
    { destino: semBanco ? ARQUIVO_DEV : 'supabase', guardar_texto: config.guardarTexto },
    'receptor do webhook no ar',
  );

  const reenviados = await fila.reenviarPendentes();
  if (reenviados > 0) app.log.info({ reenviados }, 'eventos pendentes reenviados');
}

main().catch((e: unknown) => {
  console.error('falha ao subir:', (e as Error).name, (e as Error).message);
  process.exit(1);
});
