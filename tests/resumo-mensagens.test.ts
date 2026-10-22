import { describe, expect, it } from 'vitest';
import { formatarResumo, resumirMensagens } from '../src/mensagens/resumo.js';

const G1 = '120363000000000001@g.us';
const G2 = '120363000000000002@g.us';

describe('resumirMensagens', () => {
  const r = resumirMensagens(
    [G1, G2],
    [
      { jid: G1, autor_tipo: 'cliente', conta: true },
      { jid: G1, autor_tipo: 'cliente', conta: true },
      { jid: G1, autor_tipo: 'cliente', conta: false },
      { jid: G1, autor_tipo: 'time', conta: true },
      { jid: '120363000000000009@g.us', autor_tipo: 'time', conta: false },
    ],
  );

  it('conta por grupo, autor e "conta"; inclui grupos sem mensagem e o total', () => {
    expect(r).toEqual([
      { grupo: 'grupo 1', cliente_conta: 2, cliente_nao_conta: 1, time_conta: 1, time_nao_conta: 0 },
      { grupo: 'grupo 2', cliente_conta: 0, cliente_nao_conta: 0, time_conta: 0, time_nao_conta: 0 },
      { grupo: 'outros (inativos)', cliente_conta: 0, cliente_nao_conta: 0, time_conta: 0, time_nao_conta: 1 },
      { grupo: 'total', cliente_conta: 2, cliente_nao_conta: 1, time_conta: 1, time_nao_conta: 1 },
    ]);
  });

  it('a saída formatada não tem JID', () => {
    const s = formatarResumo(r);
    expect(s).toContain('grupo 1');
    expect(s).not.toContain('@g.us');
    expect(s).not.toContain('120363');
  });

  it('conversas privadas numa linha só, sem o hash', () => {
    const p = `privada:${'a'.repeat(64)}`;
    const q = `privada:${'b'.repeat(64)}`;
    const r2 = resumirMensagens(
      [G1],
      [
        { jid: p, autor_tipo: 'cliente', conta: true },
        { jid: q, autor_tipo: 'time', conta: true },
      ],
    );
    expect(r2.map((c) => c.grupo)).toEqual(['grupo 1', 'conversas privadas', 'total']);
    expect(r2[1]).toMatchObject({ cliente_conta: 1, time_conta: 1 });
    expect(formatarResumo(r2)).not.toContain('aaaa');
  });

  it('sem "outros" quando todas as mensagens são de grupos ativos', () => {
    expect(resumirMensagens([G1], []).map((c) => c.grupo)).toEqual(['grupo 1', 'total']);
  });
});
