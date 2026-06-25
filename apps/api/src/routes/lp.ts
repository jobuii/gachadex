import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { lpDeposit, lpWithdraw, getPool, getLpPosition } from '../services/lp.ts';
import { getPoolSnapshot } from '../services/pool-snapshot.ts';
import { usdc } from '../money.ts';

const DepositReq = z.object({ amountUsd: z.number().positive().max(1_000_000) });
const WithdrawReq = z.object({ shares: z.string().regex(/^\d+$/, 'shares must be an integer string') });

export async function lpRoutes(app: FastifyInstance): Promise<void> {
  // Live pool stats + the operator-published display snapshot (fee shares, NAV gain, APY). The two reads
  // are independent, so fetch them together.
  app.get('/lp/pool', async () => {
    const db = await getDb();
    const [pool, display] = await Promise.all([getPool(db), getPoolSnapshot(db)]);
    return { ...pool, display };
  });

  app.get('/lp/position', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => getLpPosition(await getDb(), req.userId!));

  app.post('/lp/deposit', { preHandler: authenticate, config: { scope: 'full' } }, async (req) => {
    const { amountUsd } = DepositReq.parse(req.body);
    return lpDeposit(await getDb(), req.userId!, usdc(amountUsd));
  });

  app.post('/lp/withdraw', { preHandler: authenticate, config: { scope: 'full' } }, async (req) => {
    const { shares } = WithdrawReq.parse(req.body);
    return lpWithdraw(await getDb(), req.userId!, BigInt(shares));
  });
}
