import { describe, expect, it } from 'vitest';
import { comGanchos } from '../src/instancias/alerta.js';
import { EstadoInstancias } from '../src/instancias/estado.js';

describe('comGanchos', () => {
  it('primeiro registro (sem notícia antes) não é queda, mesmo já desconectado', () => {
    const estado = new EstadoInstancias(['a']);
    const caidas: string[] = [];
    const g = comGanchos(estado, { aoCair: (nome) => caidas.push(nome) });
    g.registrar('a', 'disconnected', 1);
    expect(caidas).toEqual([]);
  });

  it('conectado → desconectado avisa', () => {
    const estado = new EstadoInstancias(['a']);
    const caidas: string[] = [];
    const g = comGanchos(estado, { aoCair: (nome) => caidas.push(nome) });
    g.registrar('a', 'connected', 1);
    g.registrar('a', 'disconnected', 2);
    expect(caidas).toEqual(['a']);
  });

  it('conectando → desconectado também avisa', () => {
    const estado = new EstadoInstancias(['a']);
    const caidas: string[] = [];
    const g = comGanchos(estado, { aoCair: (nome) => caidas.push(nome) });
    g.registrar('a', 'connecting', 1);
    g.registrar('a', 'disconnected', 2);
    expect(caidas).toEqual(['a']);
  });

  it('desconectado → desconectado (mesmo status) não avisa de novo', () => {
    const estado = new EstadoInstancias(['a']);
    const caidas: string[] = [];
    const g = comGanchos(estado, { aoCair: (nome) => caidas.push(nome) });
    g.registrar('a', 'connected', 1);
    g.registrar('a', 'disconnected', 2);
    g.registrar('a', 'disconnected', 3);
    expect(caidas).toEqual(['a']);
  });

  it('reconectou e caiu de novo: avisa duas vezes', () => {
    const estado = new EstadoInstancias(['a']);
    const caidas: string[] = [];
    const g = comGanchos(estado, { aoCair: (nome) => caidas.push(nome) });
    g.registrar('a', 'connected', 1);
    g.registrar('a', 'disconnected', 2);
    g.registrar('a', 'connected', 3);
    g.registrar('a', 'disconnected', 4);
    expect(caidas).toEqual(['a', 'a']);
  });

  it('aoRegistrar chama em todo registro, com o status já traduzido', () => {
    const estado = new EstadoInstancias(['a']);
    const vistos: string[] = [];
    const g = comGanchos(estado, { aoRegistrar: (nome, status) => vistos.push(`${nome}:${status}`) });
    g.registrar('a', 'connected', 1);
    g.registrar('a', 'disconnected', 2);
    expect(vistos).toEqual(['a:conectado', 'a:desconectado']);
  });

  it('instância não configurada: nada acontece (nem aoRegistrar, nem aoCair)', () => {
    const estado = new EstadoInstancias(['a']);
    const vistos: string[] = [];
    const g = comGanchos(estado, { aoRegistrar: (nome) => vistos.push(nome), aoCair: (nome) => vistos.push(nome) });
    g.registrar('intrusa', 'disconnected', 1);
    expect(vistos).toEqual([]);
  });
});
