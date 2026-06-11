import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { getOrderHistory, getTradeHistory, getTransactionHistory, getPositionHistory } from '../services/history.ts';

/** Parse an optional ?limit= query param (shared with the wallet lifecycle feed). */
export const lim = (req: { query?: unknown }) => Number((req.query as { limit?: string } | undefined)?.limit) || undefined;

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/history/orders', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => ({
    orders: await getOrderHistory(await getDb(), req.userId!, lim(req)),
  }));

  app.get('/history/trades', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => ({
    trades: await getTradeHistory(await getDb(), req.userId!, lim(req)),
  }));

  app.get('/history/transactions', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => ({
    transactions: await getTransactionHistory(await getDb(), req.userId!, lim(req)),
  }));

  app.get('/history/positions', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => ({
    positions: await getPositionHistory(await getDb(), req.userId!, lim(req)),
  }));
}
