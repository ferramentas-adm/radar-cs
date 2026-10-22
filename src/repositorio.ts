import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MensagemNormalizada } from './mensagens/normalizar.js';

// Onde os eventos que passaram pelo filtro do receptor são gravados.

export interface EventoBruto {
  recebido_em: string; // ISO UTC, hora em que o receptor recebeu
  evento: string | null; // EventType da uazapi (messages, connection...)
  id_mensagem: string | null; // message.messageid, quando houver
  instancia: string | null; // instância que entregou o evento (identificada pelo token)
  payload: unknown; // sem token e com o texto mascarado
  mensagem: MensagemNormalizada | null; // linha de public.mensagens (normalizada na chegada)
}

export interface RepositorioEventos {
  gravar(evento: EventoBruto): Promise<void>;
}

export class RepositorioSupabase implements RepositorioEventos {
  constructor(private readonly db: SupabaseClient) {}

  async gravar(evento: EventoBruto): Promise<void> {
    // Primeiro a mensagem (idempotente: messageid repetido é ignorado), depois o bruto.
    if (evento.mensagem) {
      const { error } = await this.db
        .from('mensagens')
        .upsert(evento.mensagem, { onConflict: 'id_mensagem', ignoreDuplicates: true });
      // Só a mensagem do erro: nunca o payload.
      if (error) throw new Error(`supabase (mensagens): ${error.message}`);
    }
    const { mensagem: _, ...bruto } = evento;
    const { error } = await this.db.from('eventos_brutos').insert(bruto);
    if (error) throw new Error(`supabase (eventos_brutos): ${error.message}`);
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
