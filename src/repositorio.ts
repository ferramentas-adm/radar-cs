import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErroCadastroConversa, type NovaConversa } from './conversas/cadastrador.js';
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

/**
 * Cadastra a conversa nova sem sobrescrever a que já existe (importada, bloqueada ou cadastrada por
 * outra instância antes) e devolve o ativo que ficou no banco.
 */
export function gravarConversaSupabase(db: SupabaseClient): (c: NovaConversa) => Promise<boolean> {
  // message e details do PostgREST podem trazer a linha (jid, nome, chat_cifrado): só o code sai daqui.
  const codigo = (erro: { code?: string }) => (typeof erro.code === 'string' && erro.code !== '' ? erro.code : 'desconhecido');
  return async (c) => {
    const ins = await db.from('grupos').upsert(c, { onConflict: 'jid', ignoreDuplicates: true });
    if (ins.error) throw new ErroCadastroConversa(codigo(ins.error));
    const r = await db.from('grupos').select('ativo').eq('jid', c.jid).single();
    if (r.error) throw new ErroCadastroConversa(codigo(r.error));
    return (r.data as { ativo: boolean }).ativo;
  };
}

/** Desenvolvimento sem banco: um evento por linha num arquivo local (pasta var/, fora do git). */
export class RepositorioArquivo implements RepositorioEventos {
  constructor(private readonly arquivo: string) {}

  async gravar(evento: EventoBruto): Promise<void> {
    await mkdir(dirname(this.arquivo), { recursive: true });
    await appendFile(this.arquivo, JSON.stringify(evento) + '\n', 'utf8');
  }
}
