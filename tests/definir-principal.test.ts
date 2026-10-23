import { describe, expect, it } from 'vitest';
import { formatarPrincipal, lerEspecialista, planejarPrincipal, type GrupoPrincipal } from '../src/conversas/principal.js';
import type { MembroResponsavel } from '../src/conversas/responsavel.js';

const TIME: MembroResponsavel[] = [
  { nome: 'Ana Lima', instancia: 'ana', gestor_padrao: 'Julia', funcao: 'especialista' },
  { nome: 'Bruno', instancia: 'bruno', gestor_padrao: null, funcao: 'especialista' },
  { nome: 'Julia', instancia: 'julia', gestor_padrao: null, funcao: 'gestor' },
];
const grupo = (o: Partial<GrupoPrincipal> = {}): GrupoPrincipal => ({
  id: 7,
  jid: '120363000000000001@g.us',
  tipo: 'grupo',
  especialista: 'Ana Lima',
  gestor: 'Julia',
  instancia: 'ana',
  principal_definido_em: null,
  ...o,
});

describe('lerEspecialista', () => {
  it('exige um valor', () => {
    expect(lerEspecialista(['--especialista', ' Bruno '])).toBe('Bruno');
    for (const argv of [[], ['--especialista'], ['--especialista', '--gravar']]) {
      expect(() => lerEspecialista(argv)).toThrow('--especialista');
    }
  });
});

describe('planejarPrincipal', () => {
  it('troca de especialista: gestor padrão do novo (sem ele, o do grupo) e instância dele', () => {
    const p = planejarPrincipal(grupo(), 'bruno', TIME, ['bruno', 'ana']);
    expect(p).toEqual({
      tipo: 'mudanca',
      de: { especialista: 'Ana Lima', gestor: 'Julia' },
      para: { especialista: 'Bruno', gestor: 'Julia', instancia: 'bruno' },
      soConfirma: false,
      noGrupo: 'sim',
    });
  });

  it('mesmo especialista num grupo provisório: só confirma (passa a definido)', () => {
    expect(planejarPrincipal(grupo(), 'ANA LIMA', TIME, [])).toMatchObject({ tipo: 'mudanca', soConfirma: true, noGrupo: 'desconhecido' });
  });

  it('mesmo especialista: trava sem mexer em gestor nem instância (como o trocar_responsavel)', () => {
    const p = planejarPrincipal(grupo({ gestor: 'Outro', instancia: 'ana_antiga' }), 'Ana Lima', TIME, ['ana']);
    expect(p).toMatchObject({
      tipo: 'mudanca',
      soConfirma: true,
      para: { especialista: 'Ana Lima', gestor: 'Outro', instancia: 'ana_antiga' },
    });
    const s = formatarPrincipal(7, p, true);
    expect(s).toContain('confirma Ana Lima como principal');
    expect(s).not.toContain('gestor:');
  });

  it('mesmo especialista já definido por pessoa: sem mudança', () => {
    expect(planejarPrincipal(grupo({ principal_definido_em: '2026-10-01T00:00:00Z' }), 'Ana Lima', TIME, [])).toEqual({
      tipo: 'sem_mudanca',
      especialista: 'Ana Lima',
    });
  });

  it('avisa quando a pessoa não está no grupo pela última varredura', () => {
    expect(planejarPrincipal(grupo(), 'Bruno', TIME, ['ana'])).toMatchObject({ noGrupo: 'nao' });
  });

  it('erros: id inexistente, privada, fora do time, sem função especialista', () => {
    expect(planejarPrincipal(undefined, 'Bruno', TIME, [])).toMatchObject({ tipo: 'erro' });
    expect(planejarPrincipal(grupo({ tipo: 'privada' }), 'Bruno', TIME, [])).toMatchObject({ erro: expect.stringContaining('privada') });
    expect(planejarPrincipal(grupo(), 'Zeca', TIME, [])).toMatchObject({ erro: 'especialista não está no time (ativo)' });
    expect(planejarPrincipal(grupo(), 'Julia', TIME, [])).toMatchObject({ erro: expect.stringContaining('função especialista') });
  });
});

describe('formatarPrincipal', () => {
  it('id e nomes do time; nunca o jid', () => {
    const s = formatarPrincipal(7, planejarPrincipal(grupo(), 'Bruno', TIME, ['ana']), false);
    expect(s).toContain('simulação');
    expect(s).toContain('conversa: id 7');
    expect(s).toContain('especialista: Ana Lima → Bruno');
    expect(s).toContain('aviso: pela última varredura');
    expect(s).not.toContain('@g.us');
  });
});
