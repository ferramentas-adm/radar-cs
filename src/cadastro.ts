// Cadastro em memória para o receptor decidir na chegada, sem consultar o banco a cada evento:
// quais grupos estão ativos em public.grupos e quais números são do time.
// Recarrega periodicamente; se uma recarga falhar, continua com a última lista boa.
import type { SupabaseClient } from '@supabase/supabase-js';
import { chaveTelefone } from './grupos/exportar.js';

export interface DadosCadastro {
  gruposAtivos: string[];
  numerosTime: string[];
}

export interface LogCadastro {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface Cadastro {
  grupoAtivo(jid: string): boolean;
  /** Número (com ou sem sufixo, com ou sem o nono dígito) pertence a alguém do time ativo. */
  ehDoTime(numero: string): boolean;
}

export class CacheCadastro implements Cadastro {
  private grupos = new Set<string>();
  private time = new Set<string>();
  private carregado = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly carregar: () => Promise<DadosCadastro>,
    private readonly log: LogCadastro,
  ) {}

  get pronto(): boolean {
    return this.carregado;
  }

  grupoAtivo(jid: string): boolean {
    return this.grupos.has(jid);
  }

  ehDoTime(numero: string): boolean {
    const chave = chaveTelefone(numero);
    return chave !== '' && this.time.has(chave);
  }

  /** Recarrega. Na primeira carga o erro sobe (o receptor não deve subir sem cadastro). */
  async atualizar(): Promise<void> {
    try {
      const d = await this.carregar();
      this.grupos = new Set(d.gruposAtivos);
      this.time = new Set(d.numerosTime.map(chaveTelefone).filter((c) => c !== ''));
      this.carregado = true;
      // Só contagens: nunca JIDs nem números.
      this.log.info({ grupos_ativos: this.grupos.size, time: this.time.size }, 'cadastro carregado');
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

/** Lê grupos ativos e números do time ativo do Supabase (service role). */
export function carregadorSupabase(db: SupabaseClient): () => Promise<DadosCadastro> {
  return async () => {
    const grupos = await db.from('grupos').select('jid').eq('ativo', true);
    if (grupos.error) throw new Error(`supabase: ${grupos.error.message}`);
    const time = await db.from('time').select('numero').eq('ativo', true);
    if (time.error) throw new Error(`supabase: ${time.error.message}`);
    return {
      gruposAtivos: (grupos.data ?? []).map((g: { jid: string }) => g.jid),
      numerosTime: (time.data ?? []).map((t: { numero: string }) => t.numero),
    };
  };
}
