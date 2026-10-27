// "Registrar ação feita" (passo 6). O especialista age fora do grupo (ligação, privado, reunião) e
// registra; a janela de 3 horas, em tempo de expediente, é a confirmação: mensagem do time no grupo
// encerra, 3 horas sem mensagem fazem o alerta voltar em nível gestor. A decisão fica no motor; aqui
// só se grava, com funções atômicas do banco (migration 20261029120000_marcacoes.sql).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ComoMarcacao } from '../motor/calcular.js';
import { somarExpediente, type Calendario } from '../motor/expediente.js';

export const JANELA_MIN = 3 * 60;
const COMO: readonly ComoMarcacao[] = ['ligacao', 'privado', 'reuniao'];

export type ResultadoMarcar = 'ok' | 'grupo_inexistente' | 'ja_existe';

export interface ServicoMarcacoes {
  /** Quem marcou vem da sessão, nunca do corpo. */
  registrar(usuario: string, idGrupo: string, como: ComoMarcacao): Promise<ResultadoMarcar>;
  /** Quantas marcações abertas foram desfeitas (0 ou 1). */
  desfazer(idGrupo: string): Promise<number>;
}

export type Validado<T> = { ok: true; valor: T } | { ok: false; erro: string };

/** Corpo de POST /api/marcacoes. */
export function validarMarcacao(corpo: unknown): Validado<{ id_grupo: string; como: ComoMarcacao }> {
  const c = corpo !== null && typeof corpo === 'object' ? (corpo as Record<string, unknown>) : {};
  const id = c.id_grupo;
  if (typeof id !== 'string' || id.length === 0 || id.length > 100 || !id.endsWith('@g.us')) {
    return { ok: false, erro: 'Grupo inválido.' };
  }
  if (typeof c.como !== 'string' || !(COMO as readonly string[]).includes(c.como)) {
    return { ok: false, erro: 'Informe como agiu: ligacao, privado ou reuniao.' };
  }
  return { ok: true, valor: { id_grupo: id, como: c.como as ComoMarcacao } };
}

// A mensagem do PostgREST pode trazer a linha (jid, nome): só o code sai daqui.
const codigo = (erro: { code?: string }) => (typeof erro.code === 'string' && erro.code !== '' ? erro.code : 'desconhecido');

export function servicoMarcacoesSupabase(
  db: SupabaseClient,
  /** Expediente e feriados atuais (da leitura do radar). */
  calendario: () => Promise<Calendario>,
  aoAlterar: () => void,
  agora: () => number = Date.now,
): ServicoMarcacoes {
  return {
    async registrar(usuario, idGrupo, como) {
      const marcadoEm = agora();
      const voltaEm = somarExpediente(marcadoEm, JANELA_MIN, await calendario());
      const r = await db.rpc('registrar_marcacao', {
        p_jid: idGrupo,
        p_como: como,
        p_por: usuario,
        p_volta_em: new Date(voltaEm).toISOString(),
      });
      if (r.error) throw new Error(`supabase (registrar_marcacao): código ${codigo(r.error)}`);
      if (r.data !== 'ok' && r.data !== 'grupo_inexistente' && r.data !== 'ja_existe') {
        throw new Error('supabase (registrar_marcacao): resposta inesperada');
      }
      if (r.data === 'ok') aoAlterar();
      return r.data;
    },

    async desfazer(idGrupo) {
      const r = await db.rpc('desfazer_marcacao', { p_jid: idGrupo });
      if (r.error) throw new Error(`supabase (desfazer_marcacao): código ${codigo(r.error)}`);
      const n = Number(r.data);
      if (n > 0) aoAlterar();
      return n;
    },
  };
}

/** Fecha no banco as marcações que já acabaram (histórico; o motor decide sozinho pelo estado). */
export async function encerrarMarcacoes(db: SupabaseClient): Promise<number> {
  const r = await db.rpc('encerrar_marcacoes');
  if (r.error) throw new Error(`supabase (encerrar_marcacoes): código ${codigo(r.error)}`);
  return Number(r.data);
}
