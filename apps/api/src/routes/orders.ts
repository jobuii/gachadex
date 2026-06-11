import type { FastifyInstance } from 'fastify';
import { OrderRequest, ClosePositionRequest } from '@pokex/shared-types';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { openPosition, closePosition, getUserPositions } from '../services/engine.ts';

const TRADE = { preHandler: authenticate, config: { scope: 'trade' as const } };

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/orders', TRADE, async (req) => {
    const body = OrderRequest.parse(req.body);
    const r = await openPosition(await getDb(), req.userId!, {
      marketId: body.marketId,
      side: body.side as 'long' | 'short',
      qtyE6: BigInt(body.qtyE6),
      leverage: body.leverage,
      limitPriceE6: body.limitPriceE6 != null ? BigInt(body.limitPriceE6) : undefined,
      idempotencyKey: body.idempotencyKey,
      actorPubkey: req.actor, // delegate pubkey when a trading key placed it (audit); undefined for master
    });
    return { ok: true, ...r };
  });

  app.post('/positions/:id/close', TRADE, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ClosePositionRequest.parse({ positionId: id, ...(req.body as object) });
    const r = await closePosition(await getDb(), req.userId!, {
      positionId: id,
      fractionBps: parsed.fractionBps,
      idempotencyKey: parsed.idempotencyKey,
      actorPubkey: req.actor,
    });
    return { ok: true, ...r };
  });

  app.get('/positions', TRADE, async (req) => ({
    positions: await getUserPositions(await getDb(), req.userId!),
  }));
}
