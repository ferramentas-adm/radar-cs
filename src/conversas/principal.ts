// Definir à mão o especialista principal de um grupo (conversas:definir-principal). Funções puras.
// Marca o grupo como definido por pessoa (principal_definido_em): a varredura não troca mais sozinha.
// Serve também para confirmar uma troca sugerida. Gestor: o gestor padrão do novo especialista (sem
// ele, fica o do grupo); instância: a do novo especialista (sem ela, fica a do grupo). Com o mesmo
// especialista de hoje, só trava o grupo nele (gestor e instância ficam).
// Mensagens de erro sem nome de grupo nem jid.
import type { MembroResponsavel } from './responsavel.js';

export interface GrupoPrincipal {
  id: number;
  jid: string;
  tipo: 'grupo' | 'privada';
  especialista: string | null;
  gestor: string | null;
  instancia: string | null;
  principal_definido_em: string | null;
}

export type PlanoPrincipal =
  | { tipo: 'erro'; erro: string }
  | { tipo: 'sem_mudanca'; especialista: string }
  | {
      tipo: 'mudanca';
      de: { especialista: string | null; gestor: string | null };
      para: { especialista: string; gestor: string | null; instancia: string | null };
      /** Mesmo especialista, só passa a ser definido por pessoa. */
      soConfirma: boolean;
      /** Pela última varredura: 'sim' (está no grupo), 'nao' ou 'desconhecido' (sem presença). */
      noGrupo: 'sim' | 'nao' | 'desconhecido';
    };

const chaveNome = (nome: string) => nome.trim().replace(/\s+/g, ' ').toLowerCase();

/** --especialista "NOME". Erro cita só a opção. */
export function lerEspecialista(argv: string[]): string {
  const i = argv.indexOf('--especialista');
  const v = i === -1 ? undefined : argv[i + 1]?.trim();
  if (!v || v.startsWith('--')) throw new Error('Use --especialista "NOME" (como está na tabela time).');
  return v;
}

/**
 * grupo: a conversa pelo id (undefined se não existe). time: o time ativo. presentes: instâncias
 * presentes no grupo pela última varredura (vazio = sem presença registrada).
 */
export function planejarPrincipal(
  grupo: GrupoPrincipal | undefined,
  especialista: string,
  time: MembroResponsavel[],
  presentes: string[],
): PlanoPrincipal {
  if (!grupo) return { tipo: 'erro', erro: 'conversa não encontrada (confira o id em var/conversas.csv)' };
  if (grupo.tipo !== 'grupo') {
    return { tipo: 'erro', erro: 'conversa privada: o responsável é sempre o dono da instância' };
  }
  const membro = time.find((t) => chaveNome(t.nome) === chaveNome(especialista));
  if (!membro) return { tipo: 'erro', erro: 'especialista não está no time (ativo)' };
  if (membro.funcao !== 'especialista') {
    return { tipo: 'erro', erro: 'a pessoa não tem a função especialista (coluna funcao do time)' };
  }
  if (membro.nome === grupo.especialista && grupo.principal_definido_em !== null) {
    return { tipo: 'sem_mudanca', especialista: membro.nome };
  }
  // Mesmo especialista: o banco (trocar_responsavel) só trava o grupo nele, sem mexer em gestor nem
  // instância.
  const soConfirma = membro.nome === grupo.especialista;
  return {
    tipo: 'mudanca',
    de: { especialista: grupo.especialista, gestor: grupo.gestor },
    para: soConfirma
      ? { especialista: membro.nome, gestor: grupo.gestor, instancia: grupo.instancia }
      : {
          especialista: membro.nome,
          gestor: membro.gestor_padrao ?? grupo.gestor,
          instancia: membro.instancia ?? grupo.instancia,
        },
    soConfirma,
    noGrupo:
      presentes.length === 0 || !membro.instancia ? 'desconhecido' : presentes.includes(membro.instancia) ? 'sim' : 'nao',
  };
}

/** Saída do comando: id, nomes do time e o que muda; nunca nome do grupo, jid ou número. */
export function formatarPrincipal(id: number, p: PlanoPrincipal, gravar: boolean): string {
  const linhas = [`modo: ${gravar ? 'gravação' : 'simulação (nada gravado; use --gravar)'}`, `conversa: id ${id}`];
  if (p.tipo === 'erro') linhas.push(`erro: ${p.erro}`);
  else if (p.tipo === 'sem_mudanca') linhas.push(`sem mudança: ${p.especialista} já é o principal definido por pessoa`);
  else {
    linhas.push(
      p.soConfirma
        ? `confirma ${p.para.especialista} como principal (passa a ser definido por pessoa)`
        : `especialista: ${p.de.especialista ?? '(nenhum)'} → ${p.para.especialista}`,
    );
    if (p.de.gestor !== p.para.gestor) linhas.push(`gestor: ${p.de.gestor ?? '(nenhum)'} → ${p.para.gestor ?? '(nenhum)'}`);
    if (p.noGrupo === 'nao') linhas.push('aviso: pela última varredura, a instância dessa pessoa não está no grupo');
    if (p.noGrupo === 'desconhecido') linhas.push('aviso: sem presença registrada para conferir se a pessoa está no grupo');
  }
  return linhas.join('\n');
}
