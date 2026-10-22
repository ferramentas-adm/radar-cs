// Decide, para cada mensagem, se a conversa entra no Radar, e cadastra sozinho a conversa nova.
// - Conversa cadastrada: ativa grava; bloqueada (ativo = false) descarta.
// - Conversa nova, vista por uma instância de pessoa: cadastra (ativa), com o dono da instância como
//   especialista e o gestor padrão dele. A primeira instância que vê fica dona.
// - Grupo novo: se quem escreveu é de fora do time, é grupo de cliente sem consultar nada; se é do
//   time, consulta os participantes (/group/info). Falhou a consulta: não grava e tenta de novo na
//   próxima mensagem. Grupo interno fica num cache (só a decisão, nunca os participantes).
// - O observador não cadastra nada: continua só com os grupos já cadastrados, e descarta privada.
// Nenhum log daqui leva número, JID, hash ou texto: só instância, motivo e contagens.
import type { Cadastro } from '../cadastro.js';
import type { InstanciaConfig } from '../config.js';
import { ErroUazapi, type ParticipanteGrupo } from '../uazapi/cliente.js';
import { cifrar, jidPrivada, type ChavesConversa } from './chave.js';
import {
  classificarParticipantes,
  identificadorDoOutroLado,
  outroLadoDaPrivada,
  type ConversaDoEvento,
} from './classificar.js';

export interface NovaConversa {
  jid: string;
  tipo: 'grupo' | 'privada';
  nome: string | null;
  especialista: string;
  gestor: string | null;
  instancia: string;
  origem: 'automatico';
  ativo: true;
  observador_entrou_em: string | null;
  chat_cifrado: string | null;
}

/**
 * Falha ao gravar a conversa. A mensagem e o details do PostgREST podem trazer a linha que falhou
 * (jid, nome, chat_cifrado): aqui fica só uma frase fixa e o code do erro do banco.
 */
export class ErroCadastroConversa extends Error {
  override name = 'ErroCadastroConversa';
  constructor(readonly codigo: string) {
    super(`falha ao gravar conversa (código ${codigo})`);
  }
}

export type MotivoDescarte =
  | 'bloqueada'
  | 'interna'
  | 'nao_cadastrada' // observador (ou sem banco) vendo conversa fora do cadastro
  | 'privada_no_observador'
  | 'instancia_sem_dono'
  | 'sem_identificador'
  | 'falha_consulta'
  | 'falha_cadastro';

export type ResultadoConversa = { acao: 'gravar'; jid: string; nova: boolean } | { acao: 'descartar'; motivo: MotivoDescarte };

export interface LogCadastrador {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface DepsCadastrador {
  cadastro: Cadastro;
  /** Sem as chaves, conversa privada é descartada. */
  chaves?: ChavesConversa | undefined;
  /** Chave de telefone do observador: ignorado na classificação do grupo. */
  observadorNumero?: string | undefined;
  /** POST /group/info pela instância que viu o grupo. */
  consultarParticipantes?: ((instancia: string, jid: string) => Promise<ParticipanteGrupo[]>) | undefined;
  /** Grava (insert sem sobrescrever) e devolve o ativo que ficou no banco. Sem isto, nada é cadastrado. */
  gravarConversa?: ((c: NovaConversa) => Promise<boolean>) | undefined;
  log: LogCadastrador;
  validadeInternaMs?: number;
  agora?: () => number;
}

const VALIDADE_INTERNA_MS = 6 * 3600_000;
const ESPERA_429_MS = 5_000;

export class Cadastrador {
  private readonly internas = new Map<string, number>(); // jid → até quando vale "interna"
  private readonly emCurso = new Map<string, Promise<ResultadoConversa>>();
  private readonly pausaAte = new Map<string, number>(); // instância → fim da espera do 429
  private readonly validade: number;
  private readonly agora: () => number;

  constructor(private readonly d: DepsCadastrador) {
    this.validade = d.validadeInternaMs ?? VALIDADE_INTERNA_MS;
    this.agora = d.agora ?? Date.now;
  }

  async resolver(
    c: ConversaDoEvento,
    instancia: Pick<InstanciaConfig, 'nome' | 'tipo'>,
    enviadaEm: string,
  ): Promise<ResultadoConversa> {
    const { cadastro } = this.d;
    let jid: string;
    if (c.tipo === 'privada') {
      if (instancia.tipo === 'observador') return descartar('privada_no_observador');
      const outro = outroLadoDaPrivada(c, (lid) => cadastro.numeroDoLid(lid));
      // O número, quando conhecido, decide sozinho; o LID só vale quando não há número.
      const outroLadoEhTime =
        outro.numero !== undefined
          ? cadastro.ehDoTime(outro.numero)
          : outro.lid !== undefined && cadastro.ehLidDoTime(outro.lid);
      if (outroLadoEhTime) return descartar('interna');
      const id = identificadorDoOutroLado(outro);
      if (!id) return descartar('sem_identificador');
      if (!this.d.chaves) return descartar('nao_cadastrada');
      jid = jidPrivada(instancia.nome, id, this.d.chaves.conversa);
    } else {
      jid = c.chatid;
    }

    const estado = cadastro.estado(jid);
    if (estado === 'ativa') return { acao: 'gravar', jid, nova: false };
    if (estado === 'inativa') return descartar('bloqueada');
    if (instancia.tipo === 'observador' || !this.d.gravarConversa) return descartar('nao_cadastrada');

    // Mensagens simultâneas da mesma conversa nova: uma consulta e um cadastro só.
    const andamento = this.emCurso.get(jid);
    if (andamento) return andamento;
    const p = this.cadastrar(c, jid, instancia.nome, enviadaEm).finally(() => this.emCurso.delete(jid));
    this.emCurso.set(jid, p);
    return p;
  }

  private async cadastrar(
    c: ConversaDoEvento,
    jid: string,
    instancia: string,
    enviadaEm: string,
  ): Promise<ResultadoConversa> {
    const dono = this.d.cadastro.responsavel(instancia);
    if (!dono) return descartar('instancia_sem_dono');

    if (c.tipo === 'grupo') {
      const decisao = await this.classificarGrupo(c, jid, instancia);
      if (decisao !== 'cliente') return descartar(decisao);
    }

    const nova: NovaConversa = {
      jid,
      tipo: c.tipo,
      nome: c.tipo === 'grupo' ? c.nomeGrupo.trim() || null : null, // privada: o contato não é guardado
      especialista: dono.especialista,
      gestor: dono.gestor,
      instancia,
      origem: 'automatico',
      ativo: true,
      observador_entrou_em: c.tipo === 'grupo' ? enviadaEm : null,
      chat_cifrado: c.tipo === 'privada' ? cifrar(c.chatid, this.d.chaves!.cifra) : null,
    };
    let ativo: boolean;
    try {
      ativo = await this.d.gravarConversa!(nova);
    } catch (e) {
      // Nunca a mensagem do erro: só o código (vindo do banco) ou o nome do erro.
      const codigo = e instanceof ErroCadastroConversa ? e.codigo : (e as Error).name;
      this.d.log.warn({ instancia, tipo: c.tipo, codigo }, 'falha ao cadastrar conversa');
      return descartar('falha_cadastro');
    }
    this.d.cadastro.registrar(jid, ativo);
    this.internas.delete(jid);
    this.d.log.info({ instancia, tipo: c.tipo, ativa: ativo }, 'conversa cadastrada');
    return ativo ? { acao: 'gravar', jid, nova: true } : descartar('bloqueada');
  }

  private async classificarGrupo(
    c: ConversaDoEvento,
    jid: string,
    instancia: string,
  ): Promise<'cliente' | 'interna' | 'falha_consulta'> {
    const { cadastro } = this.d;
    // Como na privada: o número de quem escreveu decide; o LID só vale quando não há número.
    const autorDoTime =
      c.fromMe ||
      (c.autorNumero !== '' ? cadastro.ehDoTime(c.autorNumero) : c.autorLid !== '' && cadastro.ehLidDoTime(c.autorLid));
    // Alguém de fora escreveu: é grupo de cliente, sem consultar (e a decisão "interna" cai).
    if (!autorDoTime) return 'cliente';

    const agora = this.agora();
    if ((this.internas.get(jid) ?? 0) > agora) return 'interna';
    if (!this.d.consultarParticipantes || (this.pausaAte.get(instancia) ?? 0) > agora) return 'falha_consulta';

    let participantes: ParticipanteGrupo[];
    try {
      participantes = await this.d.consultarParticipantes(instancia, jid);
    } catch (e) {
      if (e instanceof ErroUazapi && e.status === 429) {
        this.pausaAte.set(instancia, agora + (e.retryAfterS ? e.retryAfterS * 1000 : ESPERA_429_MS));
      }
      this.d.log.warn({ instancia, erro: (e as Error).message }, 'falha ao consultar participantes; tenta na próxima mensagem');
      return 'falha_consulta';
    }
    const decisao = classificarParticipantes(participantes, {
      ehDoTime: (n) => cadastro.ehDoTime(n),
      ehLidDoTime: (l) => cadastro.ehLidDoTime(l),
      observador: this.d.observadorNumero,
    });
    if (decisao === undefined) {
      this.d.log.warn({ instancia }, 'grupo sem participantes na consulta; tenta na próxima mensagem');
      return 'falha_consulta';
    }
    if (decisao === 'interna') this.internas.set(jid, agora + this.validade);
    return decisao;
  }
}

const descartar = (motivo: MotivoDescarte): ResultadoConversa => ({ acao: 'descartar', motivo });
