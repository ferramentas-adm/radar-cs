// Resumo das mensagens gravadas, para conferir o piloto: só contagens por grupo, por autor e por
// "conta". Os grupos aparecem numerados ("grupo 1"...), nunca pelo JID ou pelo nome.

export interface LinhaResumo {
  jid: string;
  autor_tipo: 'cliente' | 'time';
  conta: boolean;
}

export interface ContagemGrupo {
  grupo: string;
  cliente_conta: number;
  cliente_nao_conta: number;
  time_conta: number;
  time_nao_conta: number;
}

/** gruposAtivos na ordem do cadastro; mensagens de grupo fora da lista vão para "outros". */
export function resumirMensagens(gruposAtivos: string[], linhas: LinhaResumo[]): ContagemGrupo[] {
  const zerado = (grupo: string): ContagemGrupo => ({
    grupo,
    cliente_conta: 0,
    cliente_nao_conta: 0,
    time_conta: 0,
    time_nao_conta: 0,
  });
  const porJid = new Map(gruposAtivos.map((jid, i) => [jid, zerado(`grupo ${i + 1}`)]));
  const outros = zerado('outros (inativos)');
  for (const l of linhas) {
    const c = porJid.get(l.jid) ?? outros;
    const campo = `${l.autor_tipo}_${l.conta ? 'conta' : 'nao_conta'}` as const;
    c[campo]++;
  }
  const total = zerado('total');
  const lista = [...porJid.values(), ...(linhas.some((l) => !porJid.has(l.jid)) ? [outros] : [])];
  for (const c of lista) {
    total.cliente_conta += c.cliente_conta;
    total.cliente_nao_conta += c.cliente_nao_conta;
    total.time_conta += c.time_conta;
    total.time_nao_conta += c.time_nao_conta;
  }
  return [...lista, total];
}

export function formatarResumo(contagens: ContagemGrupo[]): string {
  const cab = ['grupo', 'cliente conta', 'cliente não conta', 'time conta', 'time não conta'];
  const linhas = contagens.map((c) => [
    c.grupo,
    String(c.cliente_conta),
    String(c.cliente_nao_conta),
    String(c.time_conta),
    String(c.time_nao_conta),
  ]);
  const larguras = cab.map((h, i) => Math.max(h.length, ...linhas.map((l) => l[i]!.length)));
  const fmt = (l: string[]) => l.map((v, i) => (i === 0 ? v.padEnd(larguras[i]!) : v.padStart(larguras[i]!))).join('  ');
  return [fmt(cab), ...linhas.map(fmt)].join('\n');
}
