import type { FastifyInstance } from 'fastify';
import { NonceRequest, VerifyRequest, DelegateNonceRequest, DelegateCreateRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { HttpError } from '../errors.ts';
import {
  createNonce,
  verifyAndLogin,
  refresh,
  logout,
  createDelegateNonce,
  verifyAndCreateDelegate,
  listDelegates,
  revokeDelegate,
} from '../services/auth.ts';
import { authenticate } from '../plugins/auth.ts';
import { rl } from './_ratelimit.ts';

// tighter per-IP caps on the unauthenticated auth surface (brute-force / enumeration defense)
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/nonce', rl(config.routeRateLimits.authNonce), async (req) => {
    const { pubkey } = NonceRequest.parse(req.body);
    return createNonce(await getDb(), pubkey);
  });

  app.post('/auth/verify', rl(config.routeRateLimits.authVerify), async (req) => {
    const input = VerifyRequest.parse(req.body);
    return verifyAndLogin(await getDb(), input);
  });

  app.post('/auth/refresh', rl(config.routeRateLimits.authRefresh), async (req) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    if (!body.refreshToken) throw new HttpError(400, 'refreshToken required');
    return refresh(await getDb(), body.refreshToken);
  });

  // logout is trade-scoped so a delegate can end its own session; the "everywhere" variant is gated
  // by scope inside logout() (a trade key can't log the master out).
  app.post('/auth/logout', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    await logout(await getDb(), body.refreshToken, { userId: req.userId!, scope: req.scope!, actor: req.actor });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => ({
    id: req.userId,
    pubkey: req.pubkey, // always the ACCOUNT (master) pubkey
    scope: req.scope,
    ...(req.actor ? { act: req.actor } : {}), // the delegate pubkey that actually signed in, if any
  }));

  // --- delegated trading keys (master / full scope only — a delegate can't mint or revoke keys) ---
  app.post('/auth/delegate/nonce', rl(config.routeRateLimits.delegateNonce, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const input = DelegateNonceRequest.parse(req.body);
    return createDelegateNonce(await getDb(), req.pubkey!, input);
  });

  app.post('/auth/delegate', rl(config.routeRateLimits.delegateVerify, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const input = DelegateCreateRequest.parse(req.body);
    return verifyAndCreateDelegate(await getDb(), { userId: req.userId!, pubkey: req.pubkey! }, input);
  });

  app.get('/auth/delegates', { preHandler: authenticate, config: { scope: 'full' } }, async (req) => ({
    delegates: await listDelegates(await getDb(), req.userId!),
  }));

  app.post('/auth/delegates/:pubkey/revoke', { preHandler: authenticate, config: { scope: 'full' } }, async (req) => {
    const { pubkey } = req.params as { pubkey: string };
    await revokeDelegate(await getDb(), req.userId!, pubkey);
    return { ok: true };
  });
}
