import type { FastifyInstance } from 'fastify';
import { OrderRequest, ClosePositionRequest, RestingOrderRequest } from '@pokex/shared-types';
import { getDb } from '../db/client.ts';
import { config } from '../config.ts';
import { authenticate } from '../plugins/auth.ts';
import { openPosition, closePosition, getUserPositions, placeRestingOrder, cancelRestingOrder, getUserRestingOrders } from '../services/engine.ts';

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

  // Resting orders (limit / SL / TP). Flag-gated: 404 until RESTING_ORDERS_ENABLED=true so the surface
  // ships dark (docs/limit-stop-orders-spec.md). P1 supports kind='limit' (open).
  app.post('/orders/resting', TRADE, async (req, reply) => {
    if (!config.restingOrdersEnabled) return reply.code(404).send({ error: 'not found' });
    const body = RestingOrderRequest.parse(req.body);
    const r = await placeRestingOrder(await getDb(), req.userId!, {
      marketId: body.marketId,
      kind: body.kind as 'limit' | 'stop_loss' | 'take_profit',
      triggerPriceE6: BigInt(body.triggerPriceE6),
      side: body.side as 'long' | 'short' | undefined,
      qtyE6: body.qtyE6 != null ? BigInt(body.qtyE6) : undefined,
      leverage: body.leverage,
      slippageE6: body.slippageE6 != null ? BigInt(body.slippageE6) : undefined,
      positionId: body.positionId,
      reduceOnly: body.reduceOnly,
      idempotencyKey: body.idempotencyKey,
      actorPubkey: req.actor,
    });
    return { ok: true, ...r };
  });

  app.post('/orders/resting/:id/cancel', TRADE, async (req, reply) => {
    if (!config.restingOrdersEnabled) return reply.code(404).send({ error: 'not found' });
    const { id } = req.params as { id: string };
    const r = await cancelRestingOrder(await getDb(), req.userId!, id);
    return { ok: true, ...r };
  });

  app.get('/orders/resting', TRADE, async (req, reply) => {
    if (!config.restingOrdersEnabled) return reply.code(404).send({ error: 'not found' });
    return { orders: await getUserRestingOrders(await getDb(), req.userId!) };
  });
}
