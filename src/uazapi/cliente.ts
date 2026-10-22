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

export interface PaginaMensagens {
  /** Objetos de mensagem como a uazapi devolve (com o texto): ficam só em memória. */
  messages: Record<string, unknown>[];
  pagination: { hasMore: boolean; nextOffset?: number };
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

  /**
   * POST /group/info: só os participantes do grupo (para saber se é grupo interno).
   * Resposta sem lista de participantes é erro: não dá para classificar às cegas.
   */
  async participantesDoGrupo(groupjid: string): Promise<ParticipanteGrupo[]> {
    const r = (await this.chamar('POST', '/group/info', { groupjid })) as Record<string, unknown>;
    const grupo = (r.group ?? r) as Record<string, unknown>;
    if (!Array.isArray(grupo.Participants)) throw new Error('uazapi /group/info: resposta sem participantes');
    return (grupo.Participants as ParticipanteGrupo[]).map((p) => ({
      ...(typeof p.JID === 'string' ? { JID: p.JID } : {}),
      ...(typeof p.LID === 'string' ? { LID: p.LID } : {}),
      ...(typeof p.PhoneNumber === 'string' ? { PhoneNumber: p.PhoneNumber } : {}),
    }));
  }

  /**
   * POST /message/find: uma página das mensagens de uma conversa, da mais recente para a mais antiga.
   * Não há filtro de data: quem chama para de paginar quando passa da janela.
   */
  async buscarMensagens(opcoes: { chatid: string; limit: number; offset: number }): Promise<PaginaMensagens> {
    const r = (await this.chamar('POST', '/message/find', opcoes)) as Record<string, unknown>;
    const lista = Array.isArray(r.messages) ? (r.messages as unknown[]) : [];
    const pag = (r.pagination ?? {}) as Record<string, unknown>;
    return {
      messages: lista.filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object' && !Array.isArray(m)),
      pagination: {
        hasMore: pag.hasMore === true,
        ...(typeof pag.nextOffset === 'number' ? { nextOffset: pag.nextOffset } : {}),
      },
    };
  }

  /** POST /webhook: configura para onde a instância entrega os eventos. */
  async configurarWebhook(cfg: ConfigWebhook): Promise<void> {
    await this.chamar('POST', '/webhook', { enabled: true, ...cfg });
  }
}
