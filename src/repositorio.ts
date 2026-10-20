import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

// Onde os eventos brutos (já sanitizados) são gravados.

export interface EventoBruto {
  recebido_em: string; // ISO UTC, hora em que o receptor recebeu
  evento: string | null; // EventType da uazapi (messages, connection...)
  id_mensagem: string | null; // message.messageid, quando houver
  payload: unknown; // sem token; texto mascarado salvo DESCOBERTA_GUARDAR_TEXTO=true
}

export interface RepositorioEventos {
  gravar(evento: EventoBruto): Promise<void>;
}

export class RepositorioSupabase implements RepositorioEventos {
  constructor(private readonly db: SupabaseClient) {}

  async gravar(evento: EventoBruto): Promise<void> {
    const { error } = await this.db.from('eventos_brutos').insert(evento);
    // Só a mensagem do erro: nunca o payload.
    if (error) throw new Error(`supabase: ${error.message}`);
  }
}

/** Desenvolvimento sem banco: um evento por linha num arquivo local (pasta var/, fora do git). */
export class RepositorioArquivo implements RepositorioEventos {
  constructor(private readonly arquivo: string) {}

  async gravar(evento: EventoBruto): Promise<void> {
    await mkdir(dirname(this.arquivo), { recursive: true });
    await appendFile(this.arquivo, JSON.stringify(evento) + '\n', 'utf8');
  }
}
