// Cliente da uazapi do Radar: SÓ LEITURA (regra inegociável 1).
// Permitido: configurar o webhook, /instance/status, /group/list, /group/info, /message/find.
// Nenhuma rota de envio nem de escrita em grupo. O teste tests/sem-envio.test.ts vigia isso.

export interface StatusInstancia {
  status: string; // connected, disconnected, connecting, hibernated...
}

export interface ConfigWebhook {
  url: string;
  events: string[];
  excludeMessages: string[];
}

export interface ParticipanteGrupo {
  JID?: string;
  LID?: string;
  PhoneNumber?: string; // pode faltar
}

export interface Grupo {
  JID: string;
  Name?: string;
  ParticipantCount?: number;
  Participants?: ParticipanteGrupo[] | null; // null com noParticipants: true
}

export interface PaginaGrupos {
  groups: Grupo[];
  pagination: { totalRecords?: number; hasMore: boolean; nextOffset?: number };
}

export class ErroUazapi extends Error {
  override name = 'ErroUazapi';
  constructor(
    readonly status: number,
    readonly rota: string,
    readonly retryAfterS: number | undefined,
  ) {
    super(`uazapi ${rota}: HTTP ${status}`);
  }
}

export class ClienteUazapi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async chamar(metodo: 'GET' | 'POST', rota: string, corpo?: unknown): Promise<unknown> {
    const resp = await this.fetchFn(`${this.baseUrl}${rota}`, {
      method: metodo,
      headers: { token: this.token, accept: 'application/json', 'content-type': 'application/json' },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
    if (!resp.ok) {
      const ra = Number(resp.headers.get('retry-after'));
      // Não incluir o corpo da resposta no erro: pode trazer dados da instância (inclusive o token).
      throw new ErroUazapi(resp.status, rota, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    return resp.json();
  }

  /** GET /instance/status. Devolve só o estado da sessão (a resposta completa traz o token). */
  async instanceStatus(): Promise<StatusInstancia> {
    const r = (await this.chamar('GET', '/instance/status')) as Record<string, unknown>;
    const instancia = (r.instance ?? {}) as Record<string, unknown>;
    const st = r.status as Record<string, unknown> | string | undefined;
    const status =
      (typeof instancia.status === 'string' && instancia.status) ||
      (typeof st === 'string' && st) ||
      (st && typeof st === 'object' && st.connected === true ? 'connected' : undefined) ||
      'desconhecido';
    return { status };
  }

  /** POST /group/list: uma página dos grupos da instância (limit máximo 1000). */
  async listarGrupos(opcoes: { limit: number; offset: number; noParticipants: boolean }): Promise<PaginaGrupos> {
    const r = (await this.chamar('POST', '/group/list', opcoes)) as Partial<PaginaGrupos>;
    return {
      groups: Array.isArray(r.groups) ? r.groups : [],
      pagination: r.pagination ?? { hasMore: false },
    };
  }

  /** POST /webhook: configura para onde a instância entrega os eventos. */
  async configurarWebhook(cfg: ConfigWebhook): Promise<void> {
    await this.chamar('POST', '/webhook', { enabled: true, ...cfg });
  }
}
