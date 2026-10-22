// Motor de regras do Radar (função pura, sem I/O). Devolve a resposta de GET /api/radar no formato
// de docs/api-contract.md. Mesma lógica do motor de demonstração do painel, com tempo de expediente.
// Nesta fatia: só "sem resposta" (urgência fixa em médio) e "sem contato". Promessas e
// "Registrar ação feita" ficam vazios.
import { somarDiasUteis, somarExpediente, type Calendario } from './expediente.js';

const MIN = 60_000;

export interface GrupoMotor {
  id_grupo: string; // jid
  cliente: string;
  especialista: string;
  gestor: string;
  ativo: boolean;
  /** ms; início do "sem contato" de grupo que nunca teve mensagem do time. */
  observador_entrou_em: number | null;
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
  const grupos = e.grupos.filter((g) => g.ativo);

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
    estado: Estado;
  }[] = [];
  const estados = new Map<string, Estado>();

  for (const g of grupos) {
    const msgs = porGrupo.get(g.id_grupo) ?? [];
    let ultimaTime: number | null = null;
    for (const m of msgs) if (m.autor_tipo === 'time') ultimaTime = Math.max(ultimaTime ?? 0, m.enviada_em);
    // Mensagem do time zera todas as pendentes até aquele momento.
    const fila = msgs
      .filter((m) => m.autor_tipo === 'cliente' && (ultimaTime === null || m.enviada_em > ultimaTime))
      .map((m) => m.enviada_em)
      .sort((a, b) => a - b);

    const motivos: Motivo[] = [];
    // Sem resposta: cada pendente corre no seu prazo; a mais antiga é a mais grave (mesmo nível).
    if (fila.length > 0) {
      const t = fila[0]!;
      const a = somarExpediente(t, e.prazo.minutos_aviso, e.calendario);
      const k = somarExpediente(t, e.prazo.minutos_gestor, e.calendario);
      if (ag >= a) {
        motivos.push({ tipo: 'sem_resposta', nivel: ag >= k ? 'gestor' : 'aviso', desde: iso(t), aviso_em: iso(a), gestor_em: iso(k) });
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
        estado,
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
    }
  >();
  for (const g of grupos) {
    const item = porEsp.get(g.especialista) ?? {
      especialista: g.especialista,
      clientes: [],
      sem_contato: 0,
      sem_resposta: 0,
      retornos_vencidos: 0,
    };
    item.clientes.push({ id_grupo: g.id_grupo, cliente: g.cliente, estado: estados.get(g.id_grupo) ?? 'ok' });
    porEsp.set(g.especialista, item);
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
