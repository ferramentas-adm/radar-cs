// Cache dos dados do banco do GET /api/radar, compartilhado entre os painéis abertos.
// Guarda os dados (não a resposta pronta): o motor roda a cada pedido com o "agora" e o estado do
// observador ao vivo, então só as mensagens podem ter até CACHE_RADAR_MS de atraso.
// Pedidos simultâneos com o cache vencido esperam a mesma consulta. Erro não fica guardado.

export const CACHE_RADAR_MS = 30_000;

export class CacheRadar<T> {
  private valor: { dados: T; em: number } | undefined;
  private emAndamento: Promise<T> | undefined;

  constructor(
    private readonly carregar: () => Promise<T>,
    private readonly ttlMs: number = CACHE_RADAR_MS,
    private readonly agora: () => number = Date.now,
  ) {}

  obter(): Promise<T> {
    if (this.valor && this.agora() - this.valor.em < this.ttlMs) return Promise.resolve(this.valor.dados);
    this.emAndamento ??= this.carregar()
      .then((dados) => {
        this.valor = { dados, em: this.agora() };
        return dados;
      })
      .finally(() => {
        this.emAndamento = undefined;
      });
    return this.emAndamento;
  }
}
