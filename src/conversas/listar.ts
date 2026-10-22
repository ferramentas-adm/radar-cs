// Lista de conversas para o CS revisar e bloquear (var/conversas.csv). Funções puras.
// Sem JID nem número: a conversa é identificada pelo id interno. Na privada o nome fica vazio.
import { celula } from '../grupos/exportar.js';

export interface ConversaBanco {
  id: number;
  tipo: 'grupo' | 'privada';
  nome: string | null;
  especialista: string | null;
  gestor: string | null;
  instancia: string | null;
  origem: 'importado' | 'automatico';
  ativo: boolean;
}

const COLUNAS = ['id', 'tipo', 'nome', 'especialista', 'gestor', 'instancia', 'origem', 'ativo'] as const;

/** CSV para o Excel em português: UTF-8 com BOM, ponto e vírgula, CRLF. */
export function gerarCsvConversas(conversas: ConversaBanco[]): string {
  const linhas = conversas.map((c) =>
    COLUNAS.map((k) => (k === 'ativo' ? (c.ativo ? 'sim' : 'não') : celula(c[k] ?? ''))).join(';'),
  );
  return `﻿${[COLUNAS.join(';'), ...linhas].join('\r\n')}\r\n`;
}

/** Única saída para o terminal: contagens. */
export function resumoConversas(conversas: ConversaBanco[]): string {
  const conta = (f: (c: ConversaBanco) => boolean) => conversas.filter(f).length;
  return (
    `conversas: ${conversas.length} · grupos: ${conta((c) => c.tipo === 'grupo')} · ` +
    `privadas: ${conta((c) => c.tipo === 'privada')} · cadastradas sozinhas: ${conta((c) => c.origem === 'automatico')} · ` +
    `bloqueadas: ${conta((c) => !c.ativo)}`
  );
}

/** --id N (inteiro positivo). Erro cita só a opção. */
export function lerId(argv: string[]): number {
  const i = argv.indexOf('--id');
  const v = i === -1 ? undefined : argv[i + 1];
  if (!v || !/^[1-9][0-9]*$/.test(v)) throw new Error('Use --id N (o id da conversa em var/conversas.csv).');
  return Number(v);
}
