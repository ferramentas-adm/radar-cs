// Cadastro em memória para o receptor decidir na chegada, sem consultar o banco a cada evento:
// estado de cada conversa de public.grupos (ativa ou bloqueada), quem é do time (número e LID) e
// quem é dono de cada instância. Recarrega periodicamente; se uma recarga falhar, continua com a
// última lista boa. Conversas cadastradas pelo receptor entram no cache na hora (registrar).
import type { SupabaseClient } from '@supabase/supabase-js';
import { chaveTelefone } from './grupos/exportar.js';

export interface MembroCadastro {
  nome: string;
  numero: string;
  lid: string | null;
  instancia: string | null;
  gestor_padrao: string | null;
}

export interface DadosCadastro {
  conversas: { jid: string; ativo: boolean }[];
  time: MembroCadastro[];
}

export interface LogCadastro {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface Responsavel {
  especialista: string;
  gestor: string | null;
}

export interface Cadastro {
  /** ativa, inativa (bloqueada) ou undefined (não cadastrada). */
  estado(jid: string): 'ativa' | 'inativa' | undefined;
  /** Número (com ou sem sufixo, com ou sem o nono dígito) pertence a alguém do time ativo. */
  ehDoTime(numero: string): boolean;
  /** LID (@lid) de alguém do time: o da tabela time ou um aprendido dos eventos. */
  ehLidDoTime(lid: string): boolean;
  /** Número aprendido para um LID (dos eventos que trazem sender_lid e sender_pn juntos). */
  numeroDoLid(lid: string): string | undefined;
  aprenderLid(lid: string, numero: string): void;
  /** Dono da instância (time.instancia) e o gestor padrão dele. */
  responsavel(instancia: string): Responsavel | undefined;
  /** Conversa cadastrada agora pelo receptor (ou encontrada no banco): entra no cache na hora. */
  registrar(jid: string, ativo: boolean): void;
}

const MAX_LIDS = 50_000; // mapa LID → número só em memória; o mais antigo sai primeiro

export class CacheCadastro implements Cadastro {
  private conversas = new Map<string, boolean>();
  private time = new Set<string>();
  private lidsTime = new Set<string>();
  private donos = new Map<string, Responsavel>();
  private readonly lids = new Map<string, string>();
  private carregado = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly carregar: () => Promise<DadosCadastro>,
    private readonly log: LogCadastro,
  ) {}

  get pronto(): boolean {
    return this.carregado;
  }

  estado(jid: string): 'ativa' | 'inativa' | undefined {
    const ativo = this.conversas.get(jid);
    return ativo === undefined ? undefined : ativo ? 'ativa' : 'inativa';
  }

  ehDoTime(numero: string): boolean {
    const chave = chaveTelefone(numero);
    return chave !== '' && this.time.has(chave);
  }

  ehLidDoTime(lid: string): boolean {
    if (this.lidsTime.has(lid)) return true;
    const numero = this.lids.get(lid);
    return numero !== undefined && this.ehDoTime(numero);
  }

  numeroDoLid(lid: string): string | undefined {
    return this.lids.get(lid);
  }

  aprenderLid(lid: string, numero: string): void {
    const chave = chaveTelefone(numero);
    if (!lid.endsWith('@lid') || chave === '' || this.lids.get(lid) === chave) return;
    this.lids.delete(lid);
    this.lids.set(lid, chave);
    if (this.lids.size > MAX_LIDS) this.lids.delete(this.lids.keys().next().value!);
  }

  responsavel(instancia: string): Responsavel | undefined {
    return this.donos.get(instancia);
  }

  registrar(jid: string, ativo: boolean): void {
    this.conversas.set(jid, ativo);
  }

  /** Recarrega. Na primeira carga o erro sobe (o receptor não deve subir sem cadastro). */
  async atualizar(): Promise<void> {
    try {
      const d = await this.carregar();
      this.conversas = new Map(d.conversas.map((c) => [c.jid, c.ativo]));
      this.time = new Set(d.time.map((t) => chaveTelefone(t.numero)).filter((c) => c !== ''));
      this.lidsTime = new Set(d.time.map((t) => t.lid).filter((l): l is string => !!l));
      this.donos = new Map(
        d.time
          .filter((t) => t.instancia)
          .map((t) => [t.instancia!, { especialista: t.nome, gestor: t.gestor_padrao }]),
      );
      this.carregado = true;
      // Só contagens: nunca JIDs nem números.
      this.log.info(
        {
          conversas_ativas: [...this.conversas.values()].filter(Boolean).length,
          conversas_bloqueadas: [...this.conversas.values()].filter((a) => !a).length,
          time: this.time.size,
          instancias_com_dono: this.donos.size,
        },
        'cadastro carregado',
      );
    } catch (e) {
      if (!this.carregado) throw e;
      this.log.warn({ erro: (e as Error).message }, 'falha ao recarregar cadastro; mantendo o anterior');
    }
  }

  iniciar(intervaloMs: number): void {
    this.parar();
    this.timer = setInterval(() => void this.atualizar(), intervaloMs);
    this.timer.unref();
  }

  parar(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

const PAGINA = 1000; // o PostgREST devolve no máximo 1000 linhas por consulta

/** Lê todas as conversas (ativas e bloqueadas) e o time ativo do Supabase (service role). */
export function carregadorSupabase(db: SupabaseClient): () => Promise<DadosCadastro> {
  return async () => {
    const conversas: { jid: string; ativo: boolean }[] = [];
    for (let de = 0; ; de += PAGINA) {
      const r = await db.from('grupos').select('jid, ativo').order('id').range(de, de + PAGINA - 1);
      if (r.error) throw new Error(`supabase: ${r.error.message}`);
      conversas.push(...((r.data ?? []) as { jid: string; ativo: boolean }[]));
      if ((r.data ?? []).length < PAGINA) break;
    }
    const time = await db.from('time').select('nome, numero, lid, instancia, gestor_padrao').eq('ativo', true);
    if (time.error) throw new Error(`supabase: ${time.error.message}`);
    return { conversas, time: (time.data ?? []) as MembroCadastro[] };
  };
}
