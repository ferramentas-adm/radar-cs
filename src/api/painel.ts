// Painel do piloto: GET / (frontend/index.html em modo api) e GET /api/radar, somente leitura.
// A URL do túnel é pública: página e API exigem autenticação básica (PAINEL_USUARIO/PAINEL_SENHA).
// Tela de configurações (só administrador, conta PAINEL_ADMIN_USUARIO/PAINEL_ADMIN_SENHA): GET /admin
// e /api/admin/*. O papel é checado aqui, no servidor, em toda rota; esconder o link não basta.
// Sem a conta de administrador configurada, essas rotas nem existem (404).
// O webhook (/hooks/...) e /saude ficam fora: o webhook tem o segredo do caminho.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { validarMarcacao, type ServicoMarcacoes } from '../marcacoes/servico.js';
import type { RespostaRadar } from '../motor/calcular.js';
import { iguaisSeguro } from '../webhook/validar.js';
import { validarExpediente, validarFeriado, validarPrazo, type ServicoAdmin } from './admin.js';

export type Papel = 'admin' | 'comum';

export interface DepsAdmin {
  usuario: string;
  senha: string;
  /** Conteúdo de frontend/admin.html. */
  html: string;
  servico: ServicoAdmin;
}

export interface DepsPainel {
  usuario: string;
  senha: string;
  /** Conteúdo de frontend/index.html (sem alteração em disco). */
  html: string;
  /** Monta a resposta da API para o usuário autenticado (admin = conta de administrador). */
  radar(usuario: string, admin: boolean): Promise<RespostaRadar>;
  /** "Registrar ação feita" (POST e DELETE /api/marcacoes). Ausente = desligado (404). */
  marcacoes?: ServicoMarcacoes;
  /** Tela de configurações. Ausente = desligada. */
  admin?: DepsAdmin;
}

export const RADAR_CONFIG = { modo: 'api', apiBase: '/api', pollMs: 60000 } as const;

/** Injeta window.RADAR_CONFIG antes do </head>, para rodar antes do script do painel. */
export function injetarConfig(html: string): string {
  const script = `<script>window.RADAR_CONFIG = ${JSON.stringify(RADAR_CONFIG)};</script>`;
  const i = html.indexOf('</head>');
  if (i === -1) throw new Error('frontend/index.html sem </head>');
  return html.slice(0, i) + script + '\n' + html.slice(i);
}

/** Usuário da autenticação básica, se o cabeçalho bater; senão undefined. */
export function autenticar(cabecalho: string | undefined, usuario: string, senha: string): string | undefined {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(cabecalho ?? '');
  const decodificado = m ? Buffer.from(m[1]!, 'base64').toString('utf8') : '';
  const i = decodificado.indexOf(':');
  const u = i === -1 ? '' : decodificado.slice(0, i);
  const s = i === -1 ? '' : decodificado.slice(i + 1);
  // As duas comparações sempre rodam (tempo constante, sem dizer qual errou).
  const okUsuario = iguaisSeguro(u, usuario);
  const okSenha = iguaisSeguro(s, senha);
  return m && okUsuario && okSenha ? u : undefined;
}

export interface ContaPainel {
  usuario: string;
  senha: string;
  papel: Papel;
}

/**
 * Conta que bate com o cabeçalho, com o papel dela. Todas as contas são comparadas sempre (tempo
 * constante, sem dizer qual errou nem se o usuário existe).
 */
export function autenticarConta(
  cabecalho: string | undefined,
  contas: ContaPainel[],
): { usuario: string; papel: Papel } | undefined {
  let achada: { usuario: string; papel: Papel } | undefined;
  for (const c of contas) {
    const u = autenticar(cabecalho, c.usuario, c.senha);
    if (u !== undefined && !achada) achada = { usuario: c.usuario, papel: c.papel };
  }
  return achada;
}

export function registrarPainel(app: FastifyInstance, deps: DepsPainel): void {
  const pagina = injetarConfig(deps.html);
  const contas: ContaPainel[] = [
    { usuario: deps.usuario, senha: deps.senha, papel: 'comum' },
    ...(deps.admin ? [{ usuario: deps.admin.usuario, senha: deps.admin.senha, papel: 'admin' as const }] : []),
  ];

  const negar401 = (reply: FastifyReply) =>
    reply
      .code(401)
      .header('www-authenticate', 'Basic realm="Radar CS", charset="UTF-8"')
      .header('cache-control', 'no-store')
      .send({ erro: 'não autorizado' });

  const exigirLogin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!autenticarConta(req.headers.authorization, contas)) return negar401(reply);
  };

  const cabecalhos = (reply: FastifyReply) =>
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY');

  app.get('/', { onRequest: exigirLogin }, async (_req, reply) =>
    cabecalhos(reply).type('text/html; charset=utf-8').send(pagina),
  );

  app.get('/api/radar', { onRequest: exigirLogin }, async (req, reply) => {
    try {
      const conta = autenticarConta(req.headers.authorization, contas)!;
      return cabecalhos(reply).send(await deps.radar(conta.usuario, conta.papel === 'admin'));
    } catch (e) {
      // Erros do banco não carregam dados de mensagens; o painel mantém os últimos dados.
      req.log.error({ erro: (e as Error).message }, 'falha ao montar /api/radar');
      return cabecalhos(reply).code(500).send({ erro: 'erro interno' });
    }
  });

  // "Registrar ação feita". A conta é compartilhada: quem marcou vem do usuário da sessão (nunca do corpo)
  // e qualquer conta autenticada pode desfazer (não há identidade individual por trás do login).
  if (deps.marcacoes) {
    const marcacoes = deps.marcacoes;
    app.post('/api/marcacoes', { onRequest: exigirLogin }, async (req, reply) => {
      const v = validarMarcacao(req.body);
      if (!v.ok) return cabecalhos(reply).code(400).send({ erro: v.erro });
      try {
        const conta = autenticarConta(req.headers.authorization, contas)!;
        const r = await marcacoes.registrar(conta.usuario, v.valor.id_grupo, v.valor.como);
        if (r === 'grupo_inexistente') return cabecalhos(reply).code(404).send({ erro: 'Grupo inexistente ou inativo.' });
        if (r === 'ja_existe') return cabecalhos(reply).code(409).send({ erro: 'Já existe ação registrada para este grupo.' });
        return cabecalhos(reply).code(201).send({ ok: true });
      } catch (e) {
        req.log.error({ erro: (e as Error).message }, 'falha ao registrar ação feita');
        return cabecalhos(reply).code(500).send({ erro: 'erro interno' });
      }
    });

    app.delete<{ Params: { id_grupo: string } }>('/api/marcacoes/:id_grupo', { onRequest: exigirLogin }, async (req, reply) => {
      const v = validarMarcacao({ id_grupo: req.params.id_grupo, como: 'ligacao' });
      if (!v.ok) return cabecalhos(reply).code(400).send({ erro: v.erro });
      try {
        const n = await marcacoes.desfazer(v.valor.id_grupo);
        if (n === 0) return cabecalhos(reply).code(404).send({ erro: 'Nenhuma ação registrada para este grupo.' });
        return cabecalhos(reply).code(204).send();
      } catch (e) {
        req.log.error({ erro: (e as Error).message }, 'falha ao desfazer ação feita');
        return cabecalhos(reply).code(500).send({ erro: 'erro interno' });
      }
    });
  }

  if (!deps.admin) return;
  const admin = deps.admin;

  // Página: sem login de administrador (inclusive com login de conta comum) pede o login de novo,
  // para o navegador deixar entrar com a conta de administrador.
  app.get(
    '/admin',
    {
      onRequest: async (req, reply) => {
        if (autenticarConta(req.headers.authorization, contas)?.papel !== 'admin') return negar401(reply);
      },
    },
    async (_req, reply) => cabecalhos(reply).type('text/html; charset=utf-8').send(admin.html),
  );

  // API: sem login 401; com login de conta comum 403 (a checagem de papel é obrigatória aqui).
  const exigirAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const conta = autenticarConta(req.headers.authorization, contas);
    if (!conta) return negar401(reply);
    if (conta.papel !== 'admin') {
      return cabecalhos(reply).code(403).send({ erro: 'Sem permissão de administrador.' });
    }
  };

  const falhaInterna = (req: FastifyRequest, reply: FastifyReply, e: unknown) => {
    // Só o código do banco (a mensagem do PostgREST pode trazer a linha): vem do próprio serviço.
    req.log.error({ erro: (e as Error).message }, 'falha na configuração');
    return cabecalhos(reply).code(500).send({ erro: 'erro interno' });
  };

  app.get('/api/admin/config', { onRequest: exigirAdmin }, async (req, reply) => {
    try {
      return cabecalhos(reply).send(await admin.servico.ler());
    } catch (e) {
      return falhaInterna(req, reply, e);
    }
  });

  app.put('/api/admin/expediente', { onRequest: exigirAdmin }, async (req, reply) => {
    const v = validarExpediente(req.body);
    if (!v.ok) return cabecalhos(reply).code(400).send({ erro: v.erro });
    try {
      return cabecalhos(reply).send(await admin.servico.salvarExpediente(v.valor));
    } catch (e) {
      return falhaInterna(req, reply, e);
    }
  });

  app.put<{ Params: { urgencia: string } }>('/api/admin/prazos/:urgencia', { onRequest: exigirAdmin }, async (req, reply) => {
    const v = validarPrazo(req.params.urgencia, req.body);
    if (!v.ok) return cabecalhos(reply).code(400).send({ erro: v.erro });
    try {
      return cabecalhos(reply).send(await admin.servico.salvarPrazo(v.valor));
    } catch (e) {
      return falhaInterna(req, reply, e);
    }
  });

  app.put<{ Params: { data: string } }>('/api/admin/feriados/:data', { onRequest: exigirAdmin }, async (req, reply) => {
    const v = validarFeriado(req.params.data, req.body);
    if (!v.ok) return cabecalhos(reply).code(400).send({ erro: v.erro });
    try {
      return cabecalhos(reply).send(await admin.servico.salvarFeriado(v.valor));
    } catch (e) {
      return falhaInterna(req, reply, e);
    }
  });

  app.delete<{ Params: { data: string } }>('/api/admin/feriados/:data', { onRequest: exigirAdmin }, async (req, reply) => {
    const v = validarFeriado(req.params.data, { descricao: 'x' });
    if (!v.ok) return cabecalhos(reply).code(400).send({ erro: v.erro });
    try {
      await admin.servico.removerFeriado(v.valor.data);
      return cabecalhos(reply).code(204).send();
    } catch (e) {
      return falhaInterna(req, reply, e);
    }
  });
}
