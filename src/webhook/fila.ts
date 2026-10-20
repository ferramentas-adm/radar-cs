import { appendFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EventoBruto, RepositorioEventos } from '../repositorio.js';

// A uazapi não reenvia o webhook se o receptor falhar. Por isso o receptor responde 200 na hora
// e a gravação acontece aqui, depois: algumas tentativas e, se o banco continuar fora,
// o evento (já sanitizado) vai para um arquivo local que é reenviado quando o serviço sobe.

export interface LogFila {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface OpcoesFila {
  arquivoPendentes: string;
  log: LogFila;
  tentativas?: number;
  esperaBaseMs?: number;
}

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FilaGravacao {
  private readonly emAndamento = new Set<Promise<void>>();
  private readonly tentativas: number;
  private readonly esperaBaseMs: number;

  constructor(
    private readonly repo: RepositorioEventos,
    private readonly opcoes: OpcoesFila,
  ) {
    this.tentativas = opcoes.tentativas ?? 3;
    this.esperaBaseMs = opcoes.esperaBaseMs ?? 500;
  }

  get pendentes(): number {
    return this.emAndamento.size;
  }

  enfileirar(evento: EventoBruto): void {
    const p = this.processar(evento).finally(() => this.emAndamento.delete(p));
    this.emAndamento.add(p);
  }

  /** Espera tudo o que já foi enfileirado terminar (gravado ou salvo no arquivo de pendentes). */
  async esvaziar(): Promise<void> {
    while (this.emAndamento.size > 0) await Promise.allSettled([...this.emAndamento]);
  }

  /** Reenvia o que ficou no arquivo de pendentes. Devolve quantos eventos foram reenfileirados. */
  async reenviarPendentes(): Promise<number> {
    const emReenvio = `${this.opcoes.arquivoPendentes}.${Date.now()}.reenvio`;
    try {
      await rename(this.opcoes.arquivoPendentes, emReenvio);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw e;
    }
    const linhas = (await readFile(emReenvio, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    for (const linha of linhas) this.enfileirar(JSON.parse(linha) as EventoBruto);
    // O que falhar de novo volta para o arquivo de pendentes; este pode sair.
    await this.esvaziar();
    await unlink(emReenvio);
    return linhas.length;
  }

  private async processar(evento: EventoBruto): Promise<void> {
    const meta = { evento: evento.evento, id_mensagem: evento.id_mensagem };
    for (let i = 1; i <= this.tentativas; i++) {
      try {
        await this.repo.gravar(evento);
        return;
      } catch (e) {
        this.opcoes.log.warn({ ...meta, tentativa: i, erro: (e as Error).message }, 'falha ao gravar evento');
        if (i < this.tentativas) await esperar(this.esperaBaseMs * 2 ** (i - 1));
      }
    }
    try {
      await mkdir(dirname(this.opcoes.arquivoPendentes), { recursive: true });
      await appendFile(this.opcoes.arquivoPendentes, JSON.stringify(evento) + '\n', 'utf8');
      this.opcoes.log.error(meta, 'evento salvo em pendentes para reenviar depois');
    } catch (e) {
      this.opcoes.log.error({ ...meta, erro: (e as Error).message }, 'evento perdido: falha ao salvar em pendentes');
    }
  }
}
