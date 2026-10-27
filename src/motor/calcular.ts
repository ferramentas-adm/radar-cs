// Motor de regras do Radar (função pura, sem I/O). Devolve a resposta de GET /api/radar no formato
// de docs/api-contract.md. Mesma lógica do motor de demonstração do painel, com tempo de expediente.
// Nesta fatia: "sem resposta" (cada mensagem no prazo do seu nível de urgência; sem classificação
// vale médio) e "sem contato". Promessas e
// "Registrar ação feita" ficam vazios e saem como recursos ausentes (recursos.* = false), para o
// painel esconder o que ainda não existe em vez de mostrar zero.
// Conversa privada nunca vira linha (alertas, pendentes, clientes, resumo): entra só nos números
// por especialista (privadas sem resposta além do prazo de aviso; com atividade em 7 dias e no mês).
// "Aguardando definição do especialista principal": pela regra do responsável (planejarResponsaveis),
// só grupos, no máximo 20 itens com o total; só nome do grupo e nomes de especialista.
import { planejarResponsaveis, type EntradaResponsaveis } from '../conversas/responsavel.js';
import { inicioDoMes, somarDiasUteis, somarExpediente, type Calendario } from './expediente.js';

export type Urgencia = 'alto' | 'medio' | 'baixo';
export interface Prazo {
  minutos_aviso: number;
  minutos_gestor: number;
}

const MIN = 60_000;
const SETE_DIAS = 7 * 24 * 60 * MIN;
export const MAX_DEFINICOES = 20;

export interface GrupoMotor {
  id_grupo: string; // jid
  cliente: string;
  especialista: string;
  gestor: string;
  ativo: boolean;
  /** ms; início do "sem contato" de grupo que nunca teve mensagem do time. */
  observador_entrou_em: number | null;
  /** grupo (padrão) ou privada. */
  tipo?: 'grupo' | 'privada';
  /** Só na privada: ms da última mensagem de qualquer lado (conte ou não), para a atividade. */
  ultima_atividade_em?: number | null;
}

/** Só mensagens que contam (conta = true). */
export interface MensagemMotor {
  id_mensagem: string;
  id_grupo: string;
  autor_tipo: 'cliente' | 'time';
  enviada_em: number; // ms
  /** Só do cliente: nível dado pela IA. Ausente = não classificada, vale médio. */
  urgencia?: Urgencia;
}

export interface EntradaMotor {
  agora: number;
  grupos: GrupoMotor[];
  mensagens: MensagemMotor[];
  calendario: Calendario;
  /** Prazo de "sem resposta" do nível médio (prazos_urgencia); vale para quem não tem prazo do seu nível. */
  prazo: Prazo;
  /** Prazos por nível de urgência. Ausente = todos usam `prazo`. */
  prazos?: Partial<Record<Urgencia, Prazo>>;
  observador: { status: 'conectado' | 'conectando' | 'desconectado'; desde: number | null };
  ultimaMensagemEm: number | null;
  usuario: { nome: string; pode_marcar: boolean; admin?: boolean };
  /** Presença, time e varreduras (sem agora). Ausente = lista "aguardando definição" vazia. */
  responsaveis?: Omit<EntradaResponsaveis, 'agora'>;
}

type Nivel = 'aviso' | 'gestor';
interface Pendente {
  em: number;
  urgencia: Urgencia;
}
type Estado = Nivel | 'ok' | 'resolvido_por_fora';
/** Só o "sem resposta" do grupo, pela pendente mais antiga: ok = no prazo. */
type EstadoPendente = Nivel | 'ok';

interface Motivo {
  tipo: 'sem_resposta' | 'sem_contato' | 'retorno_vencido';
  nivel: Nivel;
  desde: string;
  aviso_em: string | null;
  gestor_em: string;
}

interface Alerta {
  id_grupo: string;
  cliente: string;
  especialista: string;
  gestor: string;
  nivel: Nivel;
  motivos: Motivo[];
  voltou_de_marcacao: null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ts = (s: string) => Date.parse(s);

export function calcular(e: EntradaMotor) {
  const ag = e.agora;
  const grupos = e.grupos.filter((g) => g.ativo && (g.tipo ?? 'grupo') === 'grupo');
  const privadas = e.grupos.filter((g) => g.ativo && g.tipo === 'privada');

  // Mensagens por grupo, sem duplicadas (mesmo id_mensagem) e em ordem de envio.
  const porGrupo = new Map<string, MensagemMotor[]>();
  const vistas = new Set<string>();
  for (const m of e.mensagens) {
    if (vistas.has(m.id_mensagem)) continue;
    vistas.add(m.id_mensagem);
    const lista = porGrupo.get(m.id_grupo) ?? [];
    lista.push(m);
    porGrupo.set(m.id_grupo, lista);
  }

  const alertas: Alerta[] = [];
  const pendentes: {
    id_grupo: string;
    cliente: string;
    especialista: string;
    quantidade: number;
    mais_antiga_desde: string;
    estado: EstadoPendente;
  }[] = [];
  const estados = new Map<string, Estado>();

  /** Última mensagem do time e as do cliente depois dela (em ordem). Mensagem do time zera todas. */
  const situacao = (id: string) => {
    const msgs = porGrupo.get(id) ?? [];
    let ultimaTime: number | null = null;
    for (const m of msgs) if (m.autor_tipo === 'time') ultimaTime = Math.max(ultimaTime ?? 0, m.enviada_em);
    const fila: Pendente[] = msgs
      .filter((m) => m.autor_tipo === 'cliente' && (ultimaTime === null || m.enviada_em > ultimaTime))
      .map((m) => ({ em: m.enviada_em, urgencia: m.urgencia ?? 'medio' }))
      .sort((a, b) => a.em - b.em);
    // No mesmo nível o prazo é o mesmo, então a mais antiga é a pior: só ela precisa de conta (no máximo 3).
    const vistos = new Set<Urgencia>();
    const candidatas = fila.filter((p) => (vistos.has(p.urgencia) ? false : (vistos.add(p.urgencia), true)));
    return { ultimaTime, fila, candidatas };
  };
  /** Prazos de uma pendente, em tempo de expediente, pelo nível dela. */
  const prazosDe = (p: Pendente) => {
    const prazo = e.prazos?.[p.urgencia] ?? e.prazo;
    return {
      aviso: somarExpediente(p.em, prazo.minutos_aviso, e.calendario),
      gestor: somarExpediente(p.em, prazo.minutos_gestor, e.calendario),
    };
  };

  for (const g of grupos) {
    const { ultimaTime, fila, candidatas } = situacao(g.id_grupo);

    const motivos: Motivo[] = [];
    // Sem resposta: cada pendente corre no prazo do seu nível; o alerta mostra a mais grave (gestor
    // antes de aviso; entre iguais, a que sobe ao gestor primeiro). O mesmo nível vai para a pilha de
    // mensagens (só o "sem resposta", sem o "sem contato").
    let estadoPendente: EstadoPendente = 'ok';
    let pior: { p: Pendente; aviso: number; gestor: number; nivel: Nivel } | undefined;
    for (const p of candidatas) {
      const { aviso, gestor } = prazosDe(p);
      if (ag < aviso) continue;
      const nivel: Nivel = ag >= gestor ? 'gestor' : 'aviso';
      if (!pior || (nivel === 'gestor' && pior.nivel === 'aviso') || (nivel === pior.nivel && gestor < pior.gestor)) {
        pior = { p, aviso, gestor, nivel };
      }
    }
    if (pior) {
      estadoPendente = pior.nivel;
      motivos.push({ tipo: 'sem_resposta', nivel: pior.nivel, desde: iso(pior.p.em), aviso_em: iso(pior.aviso), gestor_em: iso(pior.gestor) });
    }
    // Sem contato: dias úteis desde a última do time (ou desde a entrada do observador).
    const base = ultimaTime ?? g.observador_entrou_em;
    if (base !== null) {
      const a = somarDiasUteis(base, 1, e.calendario);
      const k = somarDiasUteis(base, 2, e.calendario);
      if (ag >= a) {
        motivos.push({ tipo: 'sem_contato', nivel: ag >= k ? 'gestor' : 'aviso', desde: iso(base), aviso_em: iso(a), gestor_em: iso(k) });
      }
    }

    let estado: Estado = 'ok';
    if (motivos.length > 0) {
      const nivel: Nivel = motivos.some((m) => m.nivel === 'gestor') ? 'gestor' : 'aviso';
      alertas.push({
        id_grupo: g.id_grupo,
        cliente: g.cliente,
        especialista: g.especialista,
        gestor: g.gestor,
        nivel,
        motivos,
        voltou_de_marcacao: null,
      });
      estado = nivel;
    }
    estados.set(g.id_grupo, estado);
    if (fila.length > 0) {
      pendentes.push({
        id_grupo: g.id_grupo,
        cliente: g.cliente,
        especialista: g.especialista,
        quantidade: fila.length,
        mais_antiga_desde: iso(fila[0]!.em),
        estado: estadoPendente,
      });
    }
  }

  pendentes.sort(
    (x, y) =>
      y.quantidade - x.quantidade ||
      ts(x.mais_antiga_desde) - ts(y.mais_antiga_desde) ||
      x.cliente.localeCompare(y.cliente, 'pt-BR'),
  );
  // Gestor antes de aviso; entre gestores, o mais antigo; entre avisos, o mais perto de subir.
  const chave = (a: Alerta) => {
    let maxMin = 0;
    let maxFr = 0;
    for (const m of a.motivos) {
      const d = ts(m.desde);
      const k = ts(m.gestor_em);
      maxMin = Math.max(maxMin, (ag - d) / MIN);
      maxFr = Math.max(maxFr, (ag - d) / Math.max(1, k - d));
    }
    return a.nivel === 'gestor' ? 1e6 + maxMin : maxFr * 1000;
  };
  alertas.sort((x, y) => chave(y) - chave(x) || x.cliente.localeCompare(y.cliente, 'pt-BR'));

  const ord: Record<Estado, number> = { gestor: 0, aviso: 1, resolvido_por_fora: 2, ok: 3 };
  const porEsp = new Map<
    string,
    {
      especialista: string;
      clientes: { id_grupo: string; cliente: string; estado: Estado }[];
      sem_contato: number;
      sem_resposta: number;
      retornos_vencidos: number;
      conversas_privadas_sem_resposta: number;
      conversas_privadas_7d: number;
      conversas_privadas_mes: number;
    }
  >();
  const itemDe = (especialista: string) => {
    let item = porEsp.get(especialista);
    if (!item) {
      item = {
        especialista,
        clientes: [],
        sem_contato: 0,
        sem_resposta: 0,
        retornos_vencidos: 0,
        conversas_privadas_sem_resposta: 0,
        conversas_privadas_7d: 0,
        conversas_privadas_mes: 0,
      };
      porEsp.set(especialista, item);
    }
    return item;
  };
  for (const g of grupos) {
    itemDe(g.especialista).clientes.push({ id_grupo: g.id_grupo, cliente: g.cliente, estado: estados.get(g.id_grupo) ?? 'ok' });
  }

  // Privadas: só contagens. Sem resposta = a pendente mais antiga já passou do prazo de aviso
  // (em tempo de expediente, como nos grupos). Atividade = última mensagem dentro da janela.
  const inicioMes = inicioDoMes(ag, e.calendario.expediente.fuso);
  for (const p of privadas) {
    const item = itemDe(p.especialista);
    const { candidatas } = situacao(p.id_grupo);
    if (candidatas.some((c) => ag >= prazosDe(c).aviso)) {
      item.conversas_privadas_sem_resposta++;
    }
    const ultima = p.ultima_atividade_em ?? null;
    if (ultima !== null && ultima <= ag) {
      if (ultima >= ag - SETE_DIAS) item.conversas_privadas_7d++;
      if (ultima >= inicioMes) item.conversas_privadas_mes++;
    }
  }
  for (const a of alertas) {
    const item = porEsp.get(a.especialista);
    if (!item) continue;
    if (a.motivos.some((m) => m.tipo === 'sem_contato' && m.nivel === 'gestor')) item.sem_contato++;
    if (a.motivos.some((m) => m.tipo === 'sem_resposta' && m.nivel === 'gestor')) item.sem_resposta++;
  }
  const por_especialista = [...porEsp.values()].sort((x, y) => x.especialista.localeCompare(y.especialista, 'pt-BR'));
  for (const item of por_especialista) {
    item.clientes.sort((x, y) => ord[x.estado] - ord[y.estado] || x.cliente.localeCompare(y.cliente, 'pt-BR'));
  }

  // Aguardando definição: só grupos ativos (privada nunca entra), ordenados pelo nome do grupo.
  const porJid = new Map(grupos.map((g) => [g.id_grupo, g]));
  const plano = e.responsaveis
    ? planejarResponsaveis({
        ...e.responsaveis,
        grupos: e.responsaveis.grupos.filter((g) => porJid.has(g.jid)),
        agora: ag,
      })
    : undefined;
  const aguardando = (plano?.aguardandoLista ?? [])
    .map((a) => {
      const g = porJid.get(a.jid)!;
      return { id_grupo: a.jid, cliente: g.cliente, especialista_atual: g.especialista, especialistas: a.especialistas };
    })
    .sort((x, y) => x.cliente.localeCompare(y.cliente, 'pt-BR') || x.id_grupo.localeCompare(y.id_grupo));
  const definicoes_pendentes = {
    total: aguardando.length,
    sem_varredura_recente: plano?.semVarreduraRecente.length ?? 0,
    itens: aguardando.slice(0, MAX_DEFINICOES),
  };

  const conta = (tipo: Motivo['tipo'], nivel: Nivel) =>
    alertas.filter((a) => a.motivos.some((m) => m.tipo === tipo && m.nivel === nivel)).length;

  return {
    gerado_em: iso(ag),
    // Ainda não implementados: o painel esconde as seções em vez de mostrar zero.
    recursos: { marcacoes: false, promessas: false },
    usuario: e.usuario,
    observador: {
      status: e.observador.status,
      desde: e.observador.desde === null ? null : iso(e.observador.desde),
      ultima_mensagem_em: e.ultimaMensagemEm === null ? null : iso(e.ultimaMensagemEm),
    },
    resumo: {
      clientes_total: grupos.length,
      em_alerta: alertas.length,
      em_alerta_gestor: alertas.filter((a) => a.nivel === 'gestor').length,
      sem_contato: { gestor: conta('sem_contato', 'gestor'), aviso: conta('sem_contato', 'aviso') },
      sem_resposta: { gestor: conta('sem_resposta', 'gestor'), aviso: conta('sem_resposta', 'aviso') },
      retornos_vencidos: 0,
    },
    alertas,
    pendentes,
    resolvidos_por_fora: [],
    por_especialista,
    retornos: [],
    definicoes_pendentes,
  };
}

export type RespostaRadar = ReturnType<typeof calcular>;
