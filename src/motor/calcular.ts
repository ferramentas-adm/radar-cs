// Motor de regras do Radar (função pura, sem I/O). Devolve a resposta de GET /api/radar no formato
// de docs/api-contract.md. Mesma lógica do motor de demonstração do painel, com tempo de expediente.
// Nesta fatia: só "sem resposta" (urgência fixa em médio) e "sem contato". Promessas e
// "Registrar ação feita" ficam vazios e saem como recursos ausentes (recursos.* = false), para o
// painel esconder o que ainda não existe em vez de mostrar zero.
// Conversa privada nunca vira linha (alertas, pendentes, clientes, resumo): entra só nos números
// por especialista (privadas sem resposta além do prazo de aviso; com atividade em 7 dias e no mês).
import { inicioDoMes, somarDiasUteis, somarExpediente, type Calendario } from './expediente.js';

const MIN = 60_000;
const SETE_DIAS = 7 * 24 * 60 * MIN;

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
}

export interface EntradaMotor {
  agora: number;
  grupos: GrupoMotor[];
  mensagens: MensagemMotor[];
  calendario: Calendario;
  /** Prazo de "sem resposta" (nível médio de prazos_urgencia). */
  prazo: { minutos_aviso: number; minutos_gestor: number };
  observador: { status: 'conectado' | 'conectando' | 'desconectado'; desde: number | null };
  ultimaMensagemEm: number | null;
  usuario: { nome: string; pode_marcar: boolean };
}

type Nivel = 'aviso' | 'gestor';
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
    const fila = msgs
      .filter((m) => m.autor_tipo === 'cliente' && (ultimaTime === null || m.enviada_em > ultimaTime))
      .map((m) => m.enviada_em)
      .sort((a, b) => a - b);
    return { ultimaTime, fila };
  };

  for (const g of grupos) {
    const { ultimaTime, fila } = situacao(g.id_grupo);

    const motivos: Motivo[] = [];
    // Sem resposta: cada pendente corre no seu prazo; a mais antiga é a mais grave (mesmo nível).
    // O mesmo nível vai para a pilha de mensagens (só o "sem resposta", sem o "sem contato").
    let estadoPendente: EstadoPendente = 'ok';
    if (fila.length > 0) {
      const t = fila[0]!;
      const a = somarExpediente(t, e.prazo.minutos_aviso, e.calendario);
      const k = somarExpediente(t, e.prazo.minutos_gestor, e.calendario);
      if (ag >= a) {
        estadoPendente = ag >= k ? 'gestor' : 'aviso';
        motivos.push({ tipo: 'sem_resposta', nivel: estadoPendente, desde: iso(t), aviso_em: iso(a), gestor_em: iso(k) });
      }
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
        mais_antiga_desde: iso(fila[0]!),
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
    const { fila } = situacao(p.id_grupo);
    if (fila.length > 0 && ag >= somarExpediente(fila[0]!, e.prazo.minutos_aviso, e.calendario)) {
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
  };
}

export type RespostaRadar = ReturnType<typeof calcular>;
