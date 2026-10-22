// Estado de conexão das instâncias (em memória). Alimentado pelos eventos "connection" do webhook
// e pela consulta periódica a /instance/status. O painel mostra a faixa vermelha se qualquer
// instância não estiver conectada: um painel "tudo em dia" com o número desconectado é pior que nenhum.

export type StatusPainel = 'conectado' | 'conectando' | 'desconectado';

/** connected → conectado; connecting → conectando; o resto (inclusive desconhecido) → desconectado. */
export function statusDoPainel(statusUazapi: string): StatusPainel {
  const s = statusUazapi.trim().toLowerCase();
  if (s === 'connected' || s === 'open') return 'conectado';
  if (s === 'connecting') return 'conectando';
  return 'desconectado';
}

/** Status num evento "connection" do webhook (formato ainda não confirmado com payload real). */
export function statusDoEventoConexao(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  if (p.EventType !== 'connection') return undefined;
  const instancia = p.instance as Record<string, unknown> | undefined;
  const candidatos = [instancia?.status, p.status, (p.data as Record<string, unknown> | undefined)?.status];
  const s = candidatos.find((c) => typeof c === 'string');
  return typeof s === 'string' ? s : undefined;
}

const GRAVIDADE: Record<StatusPainel, number> = { conectado: 0, conectando: 1, desconectado: 2 };

export class EstadoInstancias {
  private readonly estados = new Map<string, { status: StatusPainel; desde: number }>();

  constructor(private readonly nomes: string[]) {}

  registrar(nome: string, statusUazapi: string, agora: number): void {
    if (!this.nomes.includes(nome)) return;
    const status = statusDoPainel(statusUazapi);
    const atual = this.estados.get(nome);
    if (atual?.status !== status) this.estados.set(nome, { status, desde: agora });
  }

  /** O pior status entre as instâncias. Instância ainda sem notícia conta como desconectada. */
  resumo(): { status: StatusPainel; desde: number | null } {
    let pior: { status: StatusPainel; desde: number | null } = { status: 'conectado', desde: null };
    for (const nome of this.nomes) {
      const e = this.estados.get(nome) ?? { status: 'desconectado' as const, desde: null };
      const mais = GRAVIDADE[e.status] > GRAVIDADE[pior.status];
      const mesmoMaisAntigo =
        e.status === pior.status && e.desde !== null && (pior.desde === null || e.desde < pior.desde);
      if (mais || (mesmoMaisAntigo && e.status !== 'conectado')) pior = e;
    }
    if (this.nomes.length === 0) return { status: 'desconectado', desde: null };
    return pior;
  }
}
