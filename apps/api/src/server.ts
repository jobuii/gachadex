import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.ts';
import { HttpError } from './errors.ts';
import { authRoutes } from './routes/auth.ts';
import { accountRoutes } from './routes/account.ts';
import { marketRoutes } from './routes/markets.ts';
import { orderRoutes } from './routes/orders.ts';
import { lpRoutes } from './routes/lp.ts';
import { socialRoutes } from './routes/social.ts';
import { historyRoutes } from './routes/history.ts';
import { chatRoutes } from './routes/chat.ts';
import { walletRoutes } from './routes/wallet.ts';
import { adminRoutes, type AdminChains } from './routes/admin.ts';
import { adminOpsRoutes } from './routes/admin-ops.ts';
import { registerWs } from './plugins/ws.ts';

// Bumped when the REST/WS contract the public SDK consumes changes in a way clients should notice.
// Surfaced on /health so the SDK can warn "upgrade gachadex" instead of failing mysteriously.
// Additive field/route changes do NOT bump this; breaking ones do.
export const API_VERSION = 1;

/** One route's auth/scope policy, collected at registration for the scope route-walk test. */
export interface RouteInfo {
  method: string | string[];
  url: string;
  preHandler: unknown;
  scope?: string;
}

export interface BuildServerOpts {
  /** Chain overrides for the operator routes — tests inject fakes; production lazily wires Solana. */
  adminChains?: AdminChains;
}

/**
 * Build the Fastify instance. Routes for auth/markets/orders/account/lp and the
 * WebSocket hub are registered here in later tasks; for now it boots with health.
 */
export async function buildServer(opts: BuildServerOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // behind a proxy (Vercel/Render/Fly), trust X-Forwarded-For so rate-limit keys on the real client IP
    trustProxy: config.trustProxy,
    logger: {
      level: config.env === 'production' ? 'info' : 'debug',
      transport:
        config.env === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
  });

  // Collect every route's auth policy at registration so a test can assert that each authenticated
  // route declares an explicit scope (fail-closed: a route that forgets defaults to 'full'). The
  // onRoute hook fires for routes registered in plugins added AFTER it, so register it up front.
  const routeTable: RouteInfo[] = [];
  app.addHook('onRoute', (r) => {
    routeTable.push({ method: r.method, url: r.url, preHandler: r.preHandler, scope: (r.config as { scope?: string } | undefined)?.scope });
  });
  app.decorate('routeTable', routeTable);

  await app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
  });

  // Global per-IP rate limit. Tighter caps on auth + write endpoints are set per-route via
  // `config.rateLimit` (see routes/*). Registered before routes so it covers all of them.
  if (!config.rateLimitDisabled) {
    await app.register(rateLimit, {
      global: true,
      max: config.rateLimitMax,
      timeWindow: config.rateLimitWindowMs,
    });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError)
      return reply.code(err.statusCode).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    // zod ValidationError (may be a different zod instance than ours, so check structurally)
    if (err && (err as { name?: string }).name === 'ZodError') {
      return reply.code(400).send({ error: 'validation failed', issues: (err as { issues?: unknown }).issues });
    }
    // honor framework/plugin errors carrying a 4xx status (e.g. @fastify/rate-limit -> 429, body-parse 400s)
    const sc = (err as { statusCode?: number }).statusCode;
    if (typeof sc === 'number' && sc >= 400 && sc < 500) {
      return reply.code(sc).send({ error: (err as { message?: string }).message ?? 'request rejected' });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'gachadex-api',
    env: config.env,
    realFunds: config.realFunds,
    apiVersion: API_VERSION,
    time: new Date().toISOString(),
  }));

  await registerWs(app);
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(marketRoutes);
  await app.register(orderRoutes);
  await app.register(lpRoutes);
  await app.register(socialRoutes);
  await app.register(historyRoutes);
  await app.register(chatRoutes);
  await app.register(walletRoutes);

  // Non-custody operator surface (manual price override, etc.): registers whenever an admin key is
  // set — including play-money mode — because it never moves real funds (ROADMAP §2).
  if (config.adminApiKey) {
    await app.register(adminOpsRoutes);
  }

  // Custody operator surface: real funds + a configured admin key only (otherwise the routes don't exist).
  if (config.realFunds && config.adminApiKey) {
    let chains = opts.adminChains;
    if (!chains) {
      // lazy: the Solana modules only load on the configured production path, never in tests
      const { solanaWithdrawChain, solanaTreasuryChain } = await import('./services/custody/solana.ts');
      chains = { withdrawChain: solanaWithdrawChain(), treasuryChain: solanaTreasuryChain() };
    }
    await app.register(adminRoutes(chains));
  }

  return app;
}
