import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { usdc } from '../money.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, getBalance, postTxn } from './ledger.ts';
import { publish } from './bus.ts';
import { handleFor } from './handles.ts';
import type { Db, Queryer } from '../db/client.ts';

/**
 * DROP pot (docs/chat-social-spec.md F6, Phase 2a). The pot is the DROP_POOL ledger system account;
 * players tip real USDC into it (USER_COLLATERAL -> DROP_POOL). The round worker that spends the pot on a
 * pack + draws a winner is a later phase — for now the pot just accumulates and is shown live.
 */

/** Current pot balance (micro-USDC). */
export async function dropPotE6(q: Queryer): Promise<bigint> {
  const pool = await getOrCreateSystemAccount(q, 'DROP_POOL');
  return getBalance(q, pool);
}

/** Lifetime total tipped into the pot (micro-USDC). */
export async function totalTippedE6(db: Db): Promise<bigint> {
  const r = await db.query<{ total: string }>(`SELECT COALESCE(SUM(amount_uusdc), 0)::text AS total FROM drop_tips`);
  return BigInt(r.rows[0].total);
}

export interface TipRow {
  id: string;
  handle: string;
  amountUusdc: string;
  at: string;
}

/** Recent tips (newest first) — for the admin CHAT view. */
export async function recentTips(db: Db, limit = 20): Promise<TipRow[]> {
  const r = await db.query<{ id: string; amount: string; at: string; dn: string | null; pk: string }>(
    `SELECT t.id, t.amount_uusdc::text AS amount, t.created_at AS at, u.display_name AS dn, u.solana_pubkey AS pk
     FROM drop_tips t JOIN users u ON u.id = t.user_id
     ORDER BY t.created_at DESC LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({ id: x.id, handle: handleFor(x.dn, x.pk), amountUusdc: x.amount, at: x.at }));
}

/**
 * Tip real USDC into the pot: debit the tipper's collateral, credit DROP_POOL, record the tip — all in one
 * transaction. Gated by DROP_TIPS_ENABLED (off in prod until the draw/payout is live). Validates the amount
 * against the min/max knobs and the tipper's available balance. Broadcasts the new pot so clients update live.
 */
export async function tipDrop(db: Db, userId: string, amountUusdc: bigint): Promise<{ potE6: string; balanceE6: string; amountE6: string }> {
  if (!config.dropTipsEnabled) throw new HttpError(403, 'DROP tips are not open yet');
  if (amountUusdc < usdc(config.dropTipMinUsd)) throw new HttpError(400, `minimum tip is $${config.dropTipMinUsd}`);
  if (amountUusdc > usdc(config.dropTipMaxUsd)) throw new HttpError(400, `maximum tip is $${config.dropTipMaxUsd}`);

  const { potE6, balanceE6 } = await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    // Lock the collateral row before reading the balance (same discipline as withdrawals) so two
    // concurrent tips can't both pass the check and overdraw.
    const lock = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
    const available = lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n;
    if (available < amountUusdc) throw new HttpError(400, 'insufficient balance');
    const pool = await getOrCreateSystemAccount(q, 'DROP_POOL');
    const tipId = randomUUID();
    const txnId = await postTxn(q, {
      reason: 'DROP_TIP',
      refType: 'drop_tip',
      refId: tipId,
      entries: [
        { accountId: coll, amount: -amountUusdc },
        { accountId: pool, amount: amountUusdc },
      ],
    });
    await q.query(`INSERT INTO drop_tips(id, user_id, amount_uusdc, txn_id) VALUES($1, $2, $3, $4)`, [tipId, userId, amountUusdc.toString(), txnId]);
    return { potE6: await getBalance(q, pool), balanceE6: available - amountUusdc };
  });
  publish('chat', 'drop', { potE6: potE6.toString() }); // after commit — the pot pill updates for everyone
  return { potE6: potE6.toString(), balanceE6: balanceE6.toString(), amountE6: amountUusdc.toString() };
}
