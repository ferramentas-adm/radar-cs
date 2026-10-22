import { describe, expect, it } from 'vitest';
import { EstadoInstancias, statusDoEventoConexao, statusDoPainel } from '../src/instancias/estado.js';

describe('statusDoPainel', () => {
  it('traduz o status da uazapi; desconhecido é desconectado', () => {
    expect(statusDoPainel('connected')).toBe('conectado');
    expect(statusDoPainel('connecting')).toBe('conectando');
    for (const s of ['disconnected', 'hibernated', 'desconhecido', '']) expect(statusDoPainel(s)).toBe('desconectado');
  });
});

describe('statusDoEventoConexao', () => {
  it('lê o status do evento connection; outros eventos não', () => {
    expect(statusDoEventoConexao({ EventType: 'connection', instance: { status: 'connected' } })).toBe('connected');
    expect(statusDoEventoConexao({ EventType: 'connection', status: 'disconnected' })).toBe('disconnected');
    expect(statusDoEventoConexao({ EventType: 'messages', instance: { status: 'connected' } })).toBeUndefined();
    expect(statusDoEventoConexao({ EventType: 'connection' })).toBeUndefined();
  });
});

describe('EstadoInstancias', () => {
  it('sem notícia de uma instância: desconectado (nunca "tudo em dia" no escuro)', () => {
    expect(new EstadoInstancias(['roni_ramos']).resumo()).toEqual({ status: 'desconectado', desde: null });
    expect(new EstadoInstancias([]).resumo().status).toBe('desconectado');
  });

  it('todas conectadas: conectado', () => {
    const e = new EstadoInstancias(['a', 'b']);
    e.registrar('a', 'connected', 1);
    e.registrar('b', 'connected', 2);
    expect(e.resumo().status).toBe('conectado');
  });

  it('vale o pior status, com o horário em que ele começou', () => {
    const e = new EstadoInstancias(['a', 'b']);
    e.registrar('a', 'connected', 1);
    e.registrar('b', 'connected', 1);
    e.registrar('b', 'disconnected', 50);
    e.registrar('b', 'disconnected', 90); // mesmo status: "desde" não muda
    expect(e.resumo()).toEqual({ status: 'desconectado', desde: 50 });
  });

  it('ignora instância que não está configurada', () => {
    const e = new EstadoInstancias(['a']);
    e.registrar('a', 'connected', 1);
    e.registrar('intrusa', 'disconnected', 2);
    expect(e.resumo().status).toBe('conectado');
  });
});
