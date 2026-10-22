// Painel do piloto: GET / (frontend/index.html em modo api) e GET /api/radar, somente leitura.
// A URL do túnel é pública: página e API exigem autenticação básica (PAINEL_USUARIO/PAINEL_SENHA).
// O webhook (/hooks/...) e /saude ficam fora: o webhook tem o segredo do caminho.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RespostaRadar } from '../motor/calcular.js';
import { iguaisSeguro } from '../webhook/validar.js';

export interface DepsPainel {
  usuario: string;
  senha: string;
  /** Conteúdo de frontend/index.html (sem alteração em disco). */
  html: string;
  /** Monta a resposta da API para o usuário autenticado. */
  radar(usuario: string): Promise<RespostaRadar>;
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

export function registrarPainel(app: FastifyInstance, deps: DepsPainel): void {
  const pagina = injetarConfig(deps.html);

  const exigirLogin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!autenticar(req.headers.authorization, deps.usuario, deps.senha)) {
      return reply
        .code(401)
        .header('www-authenticate', 'Basic realm="Radar CS", charset="UTF-8"')
        .header('cache-control', 'no-store')
        .send({ erro: 'não autorizado' });
    }
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
      return cabecalhos(reply).send(await deps.radar(deps.usuario));
    } catch (e) {
      // Erros do banco não carregam dados de mensagens; o painel mantém os últimos dados.
      req.log.error({ erro: (e as Error).message }, 'falha ao montar /api/radar');
      return cabecalhos(reply).code(500).send({ erro: 'erro interno' });
    }
  });
}
