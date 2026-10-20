// Carrega o .env da raiz, se existir (Node 24: process.loadEnvFile, sem dotenv).
export function carregarEnv(arquivo = '.env'): void {
  try {
    process.loadEnvFile(arquivo);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
