import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken, type Scope } from '../services/auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    pubkey?: string;
    scope?: Scope;
    actor?: string; // delegate pubkey (the `act` claim) when a trade-scoped key is acting
  }
  // Per-route scope policy, read by `authenticate` (default 'full' when a route omits it).
  interface FastifyContextConfig {
    scope?: Scope;
  }
}

/**
 * preHandler that requires a valid Bearer access token; sets req.userId / req.pubkey / req.scope /
 * req.actor. Scope is FAIL-CLOSED: a route requires 'full' scope unless it opts in to 'trade' via
 * its route `config: { scope: 'trade' }` (a 'full' token is a superset and satisfies a 'trade' route,
 * but a 'trade' token is rejected on a 'full' route). New routes that forget to declare a scope
 * default to 'full', so a delegated trading key can never reach them by omission.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers['authorization'];
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    await reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  let scope: Scope;
  try {
    const v = await verifyAccessToken(token);
    req.userId = v.userId;
    req.pubkey = v.pubkey;
    req.scope = v.scope;
    req.actor = v.act;
    scope = v.scope;
  } catch {
    await reply.code(401).send({ error: 'invalid or expired token' });
    return;
  }
  const required: Scope = (req.routeOptions?.config as { scope?: Scope } | undefined)?.scope ?? 'full';
  if (required === 'full' && scope !== 'full') {
    await reply.code(403).send({ error: 'this action requires the master wallet, not a trading key', code: 'scope_denied' });
    return; // stop here — never fall through to the route handler after denying scope
  }
}
