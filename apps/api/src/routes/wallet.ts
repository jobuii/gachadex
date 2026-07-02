import type { FastifyInstance } from 'fastify';
import { WithdrawNonceRequest, WithdrawRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { rl } from './_ratelimit.ts';
import { lim } from './history.ts';
import { getOrCreateDepositAddress } from '../services/custody/wallet.ts';
import { requestWithdrawal, willAutoApprove } from '../services/custody/withdrawals.ts';
import { createWithdrawalNonce } from '../services/auth.ts';
import { getWalletTransactions } from '../services/history.ts';

/** Real-funds wallet endpoints (custody P1 deposits + P2 withdrawals). Disabled in play-money mode. */
export async function walletRoutes(app: FastifyInstance): Promise<void> {
  // Plugin-scoped gate: every wallet route — current and future — is real-funds-only, structurally.
  app.addHook('onRequest', async () => {
    if (!config.realFunds) {
      throw new HttpError(403, 'real-funds wallet is disabled (play-money mode — use the faucet)');
    }
  });

  app.get('/wallet/deposit-address', { preHandler: authenticate, config: { scope: 'full' } }, async (req) => {
    const r = await getOrCreateDepositAddress(await getDb(), req.userId!);
    return { address: r.address };
  });

  // Step 1 of a withdrawal: get the exact message the wallet must sign (binds amount + dest).
  app.post('/wallet/withdraw/nonce', rl(config.routeRateLimits.withdrawNonce, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const input = WithdrawNonceRequest.parse(req.body);
    return createWithdrawalNonce(await getDb(), req.pubkey!, {
      amountE6: BigInt(input.amountE6),
      dest: input.dest,
    });
  });

  // Step 2: submit the signed message. Validates + debits atomically; payout follows on approval.
  app.post('/wallet/withdraw', rl(config.routeRateLimits.withdraw, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const input = WithdrawRequest.parse(req.body);
    const db = await getDb();
    const w = await requestWithdrawal(db, req.userId!, req.pubkey!, {
      ...input,
      amountE6: BigInt(input.amountE6),
    });
    // Tell the client whether the worker will auto-process this one (toggle on + under cap + not frozen),
    // so it shows "approved, on its way" vs "follows approval".
    const autoApprove = await willAutoApprove(db, w.amountE6, req.userId!);
    return { id: w.id, status: w.status, amountE6: w.amountE6.toString(), dest: w.dest, duplicate: w.duplicate ?? false, autoApprove };
  });

  // Deposit/withdrawal lifecycle (the on-chain status the ledger history doesn't carry).
  app.get('/wallet/transactions', { preHandler: authenticate, config: { scope: 'full' } }, async (req) => {
    return { transactions: await getWalletTransactions(await getDb(), req.userId!, lim(req)) };
  });
}
