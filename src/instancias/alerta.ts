// Passo 5 (saúde): avisa quando uma instância que estava conectada cai. Sem notícia ainda
// (primeiro registro) não é queda. Função pura: quem decide o que fazer com o aviso vem de fora
// (log, e-mail etc. — hoje só o log; não há provedor de e-mail configurado no projeto).
import type { StatusPainel } from './estado.js';

export interface FonteEstado {
  registrar(nome: string, statusUazapi: string, agora: number): void;
  statusDe(nome: string): StatusPainel | undefined;
}

export interface GatilhoEstado {
  registrar(nome: string, statusUazapi: string, agora: number): void;
}

export interface GanchosEstado {
  /** Instância que estava conectada (ou conectando) e passou a desconectada. */
  aoCair?: (nome: string, agora: number) => void;
  /** Todo registro, com o status já traduzido para o painel (para persistir, por exemplo). */
  aoRegistrar?: (nome: string, status: StatusPainel, agora: number) => void;
}

export function comGanchos(estado: FonteEstado, ganchos: GanchosEstado): GatilhoEstado {
  return {
    registrar(nome, statusUazapi, agora) {
      const antes = estado.statusDe(nome);
      estado.registrar(nome, statusUazapi, agora);
      const depois = estado.statusDe(nome);
      if (depois !== undefined) ganchos.aoRegistrar?.(nome, depois, agora);
      if (antes !== undefined && antes !== 'desconectado' && depois === 'desconectado') ganchos.aoCair?.(nome, agora);
    },
  };
}
