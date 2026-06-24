import type { FastifyInstance } from 'fastify';
import { FaucetRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { rl } from './_ratelimit.ts';
import { creditFaucet, getUserBalances } from '../services/faucet.ts';
import { getUserUnrealizedPnl } from '../services/engine.ts';
import { getCashbackTotal } from '../services/affiliate.ts';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/account/balance', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => {
    const db = await getDb();
    const [b, uPnl, cashback] = await Promise.all([
      getUserBalances(db, req.userId!),
      getUserUnrealizedPnl(db, req.userId!),
      getCashbackTotal(db, req.userId!),
    ]);
    return {
      availableUusdc: b.availableUusdc.toString(),
      lockedMarginUusdc: b.lockedMarginUusdc.toString(),
      reservedUusdc: b.reservedUusdc.toString(), // margin earmarked against resting limit orders
      unrealizedPnlUusdc: uPnl.toString(),
      equityUusdc: (b.availableUusdc + b.lockedMarginUusdc + b.reservedUusdc + uPnl).toString(),
      cashbackTotalUusdc: cashback.toString(),
    };
  });

  app.post('/faucet', rl(config.routeRateLimits.faucet, { preHandler: authenticate, config: { scope: 'trade' as const } }), async (req) => {
    const { amountUsd } = FaucetRequest.parse(req.body ?? {});
    const r = await creditFaucet(await getDb(), req.userId!, amountUsd);
    return { ok: true, txnId: r.txnId, availableUusdc: r.availableUusdc.toString() };
  });
}
