// Casos de limite que o motor de regras REAL (passo 4 do CLAUDE.md) também deve cumprir.
// Hoje testa o motor de demonstração dentro de frontend/index.html. Rodar: node frontend/tests/engine-demo.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(process.argv[2] ?? new URL('../index.html', import.meta.url), 'utf8');
const body = html.match(/\/\/ <engine>([\s\S]*?)\/\/ <\/engine>/)[1];
const MIN = 60000, H = 3600000, D = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const ts = (s) => Date.parse(s);
const { calcular } = new Function('MIN', 'H', 'D', 'iso', 'ts', body + '; return { calcular };')(MIN, H, D, iso, ts);

const AG = Date.parse('2026-10-20T15:00:00-03:00');
const ago = (m) => AG - m * MIN;
const G = (o) => ({ id_grupo: 'g1@g.us', cliente: 'Cliente Teste', especialista: 'Esp A', gestor: 'Gestor X', ativo: true, ultima_time: ago(100), ultima_cliente: ago(500), ...o });
const run = (grupos, promessas = [], marc = {}) => calcular({ agora: AG, grupos, promessas, marcacoes: marc, observador: { status: 'conectado', desde: null }, usuario: { nome: 'x', pode_marcar: true } });
let n = 0; const t = (nome, fn) => { fn(); n++; console.log('ok  ' + nome); };

// sem resposta
t('cliente 19 min: sem alerta', () => assert.equal(run([G({ ultima_cliente: ago(19) })]).alertas.length, 0));
t('cliente 20 min: aviso', () => { const a = run([G({ ultima_cliente: ago(20) })]).alertas; assert.equal(a.length, 1); assert.equal(a[0].nivel, 'aviso'); assert.equal(a[0].motivos[0].tipo, 'sem_resposta'); });
t('cliente 30 min: ainda aviso', () => assert.equal(run([G({ ultima_cliente: ago(30) })]).alertas[0].nivel, 'aviso'));
t('cliente 31 min: gestor', () => assert.equal(run([G({ ultima_cliente: ago(31) })]).alertas[0].nivel, 'gestor'));
t('time respondeu depois: zera sem resposta', () => assert.equal(run([G({ ultima_cliente: ago(60), ultima_time: ago(5) })]).alertas.length, 0));
t('marcos de tempo do motivo', () => { const m = run([G({ ultima_cliente: ago(25) })]).alertas[0].motivos[0]; assert.equal(ts(m.aviso_em), ago(25) + 20 * MIN); assert.equal(ts(m.gestor_em), ago(25) + 31 * MIN); });

// sem contato
t('sem contato 23h59: nada', () => assert.equal(run([G({ ultima_time: ago(23 * 60 + 59), ultima_cliente: ago(2000) })]).alertas.length, 0));
t('sem contato 24h: aviso', () => assert.equal(run([G({ ultima_time: ago(24 * 60), ultima_cliente: ago(2000) })]).alertas[0].nivel, 'aviso'));
t('sem contato 47h59: aviso', () => assert.equal(run([G({ ultima_time: ago(47 * 60 + 59), ultima_cliente: ago(4000) })]).alertas[0].nivel, 'aviso'));
t('sem contato 48h: gestor', () => assert.equal(run([G({ ultima_time: ago(48 * 60), ultima_cliente: ago(4000) })]).alertas[0].nivel, 'gestor'));
t('grupo inativo não gera alerta', () => assert.equal(run([G({ ativo: false, ultima_time: ago(9999), ultima_cliente: ago(5) })]).alertas.length, 0));

// retorno
const P = (o) => ({ id: 'p', id_grupo: 'g1@g.us', texto: 'Enviar laudo', criada_em: ago(180), prazo: ago(60), ...o });
t('retorno vencido vai direto ao gestor', () => { const r = run([G({ ultima_time: ago(180), ultima_cliente: ago(400) })], [P()]); assert.equal(r.alertas[0].nivel, 'gestor'); assert.equal(r.alertas[0].motivos[0].tipo, 'retorno_vencido'); assert.equal(r.resumo.retornos_vencidos, 1); assert.equal(r.retornos[0].situacao, 'vencido'); });
t('retorno no prazo não alerta', () => { const r = run([G({ ultima_time: ago(180), ultima_cliente: ago(400) })], [P({ prazo: AG + 2 * H })]); assert.equal(r.alertas.length, 0); assert.equal(r.retornos[0].situacao, 'vence_hoje'); });
t('retorno a mais de 6h: no_prazo', () => assert.equal(run([G({ ultima_time: ago(180), ultima_cliente: ago(400) })], [P({ prazo: AG + 7 * H })]).retornos[0].situacao, 'no_prazo'));
t('mensagem do time depois da promessa: cumprido, sem alerta', () => { const r = run([G({ ultima_time: ago(10), ultima_cliente: ago(400) })], [P()]); assert.equal(r.alertas.length, 0); assert.equal(r.retornos[0].situacao, 'cumprido'); });
t('cumprido há mais de 24h some da lista', () => assert.equal(run([G({ ultima_time: ago(24 * 60 + 5), ultima_cliente: ago(5000) })], [P({ criada_em: ago(3000) })]).retornos.length, 0));

// resolvi por fora
const base = { ultima_time: ago(1700), ultima_cliente: ago(1800) };
t('ação por fora a 2h59: sai da lista de alertas e vai para ações por fora', () => { const r = run([G(base)], [], { 'g1@g.us': { por: 'Esp A', como: 'ligacao', em: ago(179) } }); assert.equal(r.alertas.length, 0); assert.equal(r.resolvidos_por_fora.length, 1); assert.equal(ts(r.resolvidos_por_fora[0].volta_em), ago(179) + 3 * H); assert.equal(r.por_especialista[0].clientes[0].estado, 'resolvido_por_fora'); });
t('marcação a 3h sem registro: volta em nível gestor com aviso', () => { const r = run([G(base)], [], { 'g1@g.us': { por: 'Esp A', como: 'privado', em: ago(180) } }); assert.equal(r.resolvidos_por_fora.length, 0); assert.equal(r.alertas[0].nivel, 'gestor'); assert.equal(r.alertas[0].voltou_de_marcacao.como, 'privado'); });
t('time escreveu depois da marcação: marcação encerrada, sem alerta', () => { const r = run([G({ ultima_time: ago(30), ultima_cliente: ago(1800) })], [], { 'g1@g.us': { por: 'Esp A', como: 'reuniao', em: ago(100) } }); assert.equal(r.alertas.length, 0); assert.equal(r.resolvidos_por_fora.length, 0); });
t('marcação sem alerta ativo não aparece em resolvidos', () => { const r = run([G({ ultima_time: ago(10), ultima_cliente: ago(900) })], [], { 'g1@g.us': { por: 'Esp A', como: 'ligacao', em: ago(20) } }); assert.equal(r.resolvidos_por_fora.length, 0); });

// ordenação, resumo e carteira
t('gestor antes de aviso; resumo e por_especialista batem', () => {
  const gs = [
    G({ id_grupo: 'a', cliente: 'A aviso', ultima_cliente: ago(22) }),
    G({ id_grupo: 'b', cliente: 'B gestor', ultima_cliente: ago(40) }),
    G({ id_grupo: 'c', cliente: 'C contato gestor', ultima_time: ago(3000), ultima_cliente: ago(4000) }),
    G({ id_grupo: 'd', cliente: 'D ok' }),
    G({ id_grupo: 'e', cliente: 'E aviso contato', especialista: 'Esp B', ultima_time: ago(1500), ultima_cliente: ago(2000) })
  ];
  const r = run(gs);
  assert.deepEqual(r.alertas.map((a) => a.id_grupo), ['c', 'b', 'a', 'e']);
  assert.equal(r.resumo.clientes_total, 5); assert.equal(r.resumo.em_alerta, 4); assert.equal(r.resumo.em_alerta_gestor, 2);
  assert.deepEqual(r.resumo.sem_resposta, { gestor: 1, aviso: 1 }); assert.deepEqual(r.resumo.sem_contato, { gestor: 1, aviso: 1 });
  const ea = r.por_especialista.find((e) => e.especialista === 'Esp A');
  assert.equal(ea.clientes.length, 4); assert.equal(ea.sem_contato, 1); assert.equal(ea.sem_resposta, 1);
  assert.deepEqual(ea.clientes.map((c) => c.estado), ['gestor', 'gestor', 'aviso', 'ok']);
});
t('retorno + sem contato no mesmo cliente: dois motivos, um alerta', () => { const r = run([G({ ultima_time: ago(3000), ultima_cliente: ago(3100) })], [P({ criada_em: ago(3000), prazo: ago(1500) })]); assert.equal(r.alertas.length, 1); assert.equal(r.alertas[0].motivos.length, 2); });
t('alerta nunca carrega texto de mensagem', () => assert.ok(!JSON.stringify(run([G({ ultima_cliente: ago(40) })])).includes('texto_mensagem')));

// pilha de mensagens (ranking de pendentes por cliente)
t('pilha: sem lista de mensagens, vale só a última do cliente', () => { const p = run([G({ ultima_cliente: ago(10) })]).pendentes; assert.equal(p.length, 1); assert.equal(p[0].quantidade, 1); assert.equal(ts(p[0].mais_antiga_desde), ago(10)); });
t('pilha: cliente já respondido pelo time não entra', () => assert.equal(run([G({ ultima_cliente: ago(60), ultima_time: ago(5) })]).pendentes.length, 0));
t('pilha: conta só as mensagens depois da última do time', () => { const p = run([G({ ultima_time: ago(50), ultima_cliente: ago(5), pend: [ago(5), ago(20), ago(40), ago(70)] })]).pendentes[0]; assert.equal(p.quantidade, 3); assert.equal(ts(p.mais_antiga_desde), ago(40)); });
t('pilha: mais mensagens primeiro; empate pela mais antiga', () => {
  const r = run([
    G({ id_grupo: 'a', cliente: 'A', pend: [ago(5)], ultima_cliente: ago(5) }),
    G({ id_grupo: 'b', cliente: 'B', pend: [ago(5), ago(8), ago(9)], ultima_cliente: ago(5) }),
    G({ id_grupo: 'c', cliente: 'C', pend: [ago(5), ago(15)], ultima_cliente: ago(5) }),
    G({ id_grupo: 'd', cliente: 'D', pend: [ago(5), ago(30)], ultima_cliente: ago(5) })
  ]).pendentes;
  assert.deepEqual(r.map((x) => x.id_grupo), ['b', 'd', 'c', 'a']);
});
t('pilha: estado acompanha o alerta do cliente', () => { const r = run([G({ id_grupo: 'a', pend: [ago(40), ago(45)], ultima_cliente: ago(40) }), G({ id_grupo: 'b', pend: [ago(3), ago(4)], ultima_cliente: ago(3) })]).pendentes; assert.equal(r.find((x) => x.id_grupo === 'a').estado, 'gestor'); assert.equal(r.find((x) => x.id_grupo === 'b').estado, 'ok'); });
t('pilha: grupo inativo não entra', () => assert.equal(run([G({ ativo: false, ultima_cliente: ago(5) })]).pendentes.length, 0));
t('pilha: não carrega texto de mensagem', () => assert.ok(!/texto/i.test(JSON.stringify(run([G({ ultima_cliente: ago(40), pend: [ago(40), ago(50)] })]).pendentes))));

// conversas privadas: só contagens por especialista (nunca linha, nunca alerta)
const PV = (o) => ({ especialista: 'Esp A', ultima_time: ago(100), ultima_cliente: ago(500), ...o });
const runP = (grupos, privadas) => calcular({ agora: AG, grupos, privadas, promessas: [], marcacoes: {}, observador: { status: 'conectado', desde: null }, usuario: { nome: 'x', pode_marcar: true } });
const espA = (r) => r.por_especialista.find((e) => e.especialista === 'Esp A');
t('privada: sem resposta só a partir do prazo de aviso (19 min nada, 20 min conta)', () => {
  assert.equal(espA(runP([G()], [PV({ ultima_cliente: ago(19) })])).conversas_privadas_sem_resposta, 0);
  assert.equal(espA(runP([G()], [PV({ ultima_cliente: ago(20) }), PV({ ultima_cliente: ago(40) }), PV({ ultima_cliente: ago(60), ultima_time: ago(5) })])).conversas_privadas_sem_resposta, 2);
});
t('privada: não entra em alertas, pendentes, clientes nem em "clientes em alerta"', () => {
  const r = runP([G()], [PV({ ultima_cliente: ago(40) })]);
  assert.equal(r.alertas.length, 0); assert.equal(r.pendentes.length, 0);
  assert.equal(r.resumo.clientes_total, 1); assert.equal(r.resumo.em_alerta, 0);
  assert.equal(espA(r).clientes.length, 1);
});
t('privada: atividade em 7 dias e no mês corrente (conversas distintas)', () => {
  const r = runP([G()], [
    PV({ ultima_time: ago(10), ultima_cliente: ago(30) }),
    PV({ ultima_time: ago(6 * 24 * 60), ultima_cliente: ago(6 * 24 * 60 + 5) }),
    PV({ ultima_time: ago(8 * 24 * 60), ultima_cliente: ago(8 * 24 * 60 + 5) }), // 12/10: no mês
    PV({ ultima_time: ago(25 * 24 * 60), ultima_cliente: ago(25 * 24 * 60 + 5) }) // 25/09: mês anterior
  ]);
  assert.equal(espA(r).conversas_privadas_7d, 2); assert.equal(espA(r).conversas_privadas_mes, 3);
});
t('privada: sem privadas os campos vêm 0; especialista só com privadas aparece; inativa não conta', () => {
  const r = runP([G()], [PV({ especialista: 'Esp B', ultima_cliente: ago(40) }), PV({ especialista: 'Esp B', ativo: false, ultima_cliente: ago(40) })]);
  assert.deepEqual([espA(r).conversas_privadas_sem_resposta, espA(r).conversas_privadas_7d, espA(r).conversas_privadas_mes], [0, 0, 0]);
  const eb = r.por_especialista.find((e) => e.especialista === 'Esp B');
  assert.equal(eb.clientes.length, 0); assert.equal(eb.conversas_privadas_sem_resposta, 1);
  assert.equal(run([G()]).por_especialista[0].conversas_privadas_7d, 0);
});

console.log('\n' + n + ' casos passaram');
