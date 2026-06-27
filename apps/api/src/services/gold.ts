import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import type { Db, Queryer } from '../db/client.ts';

/**
 * Classic Gacha loyalty Gold (docs/classic-gacha-cc-packs-spec.md §6b). A per-player points currency,
 * 1 Gold = $0.001, separate from the USDC ledger and from on-chain $GDEX — non-transferable, non-withdrawable.
 * Its own double-entry-free ledger: the invariant is `Σ gold_ledger.delta == gold_balances.balance` per user
 * (there is no Σ=0 cross-account partner; a gold-bought pack's USDC cost is booked in the USDC ledger separately).
 * earn/spend run inside the caller's tx (a `Queryer`) so they're atomic with the open/charge.
 */

export const FREE_PACK_GOLD = 25_000n; // a free $25 pack at 1000 Gold/$ — the loyalty reward unit
export const GOLD_PER_USD = 0.001; // 1 Gold = $0.001 (for the wire)

/** A pack's Gold price = USD × 1000 (a $25 pack = 25,000 Gold). priceE6 is micro-USDC → /1000. */
export function goldPriceForPack(priceE6: bigint): bigint {
  return priceE6 / 1000n;
}

/** Gold earned on a paid (USDC) open: priceUSD × (FREE_PACK_GOLD / thresholdUSD), integer-floored.
 *  threshold $1000 → a $25 open earns 625 (≈2.5% rebate); $100 earns 2,500. */
export function goldEarnedForOpen(priceE6: bigint, thresholdUsd: number): bigint {
  if (thresholdUsd <= 0) return 0n;
  return (priceE6 * FREE_PACK_GOLD) / (BigInt(thresholdUsd) * 1_000_000n);
}

interface Ref { refType?: string; refId?: string }

/** Credit Gold (earn). No-op for delta ≤ 0. */
export async function earnGold(q: Queryer, userId: string, delta: bigint, reason: string, ref: Ref = {}): Promise<void> {
  if (delta <= 0n) return;
  await q.query(`INSERT INTO gold_ledger(id, user_id, delta, reason, ref_type, ref_id) VALUES($1,$2,$3,$4,$5,$6)`, [
    randomUUID(), userId, delta.toString(), reason, ref.refType ?? null, ref.refId ?? null,
  ]);
  await q.query(
    `INSERT INTO gold_balances(user_id, balance) VALUES($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET balance = gold_balances.balance + EXCLUDED.balance`,
    [userId, delta.toString()],
  );
}

/** Debit Gold (spend). Locks the balance row FOR UPDATE; throws 400 insufficient_gold if short. */
export async function spendGold(q: Queryer, userId: string, amount: bigint, ref: Ref = {}): Promise<void> {
  if (amount <= 0n) throw new HttpError(400, 'invalid gold amount');
  const lock = await q.query<{ balance: string }>(`SELECT balance FROM gold_balances WHERE user_id = $1 FOR UPDATE`, [userId]);
  const bal = lock.rows[0] ? BigInt(lock.rows[0].balance) : 0n;
  if (bal < amount) throw new HttpError(400, 'insufficient Gold', 'insufficient_gold');
  await q.query(`UPDATE gold_balances SET balance = balance - $2 WHERE user_id = $1`, [userId, amount.toString()]);
  await q.query(`INSERT INTO gold_ledger(id, user_id, delta, reason, ref_type, ref_id) VALUES($1,$2,$3,$4,$5,$6)`, [
    randomUUID(), userId, (-amount).toString(), 'PACK_BUY_GOLD', ref.refType ?? null, ref.refId ?? null,
  ]);
}

/** Reverse the loyalty Gold credited (PACK_OPEN_EARN) for a now-refunded gacha open. Gold is earned at payment,
 *  so a buy that later fails/refunds earned nothing and must give the Gold back. It locks the player's balance row
 *  (FOR UPDATE, like spendGold) then nets the original earn against any prior reversal for the same open — so
 *  re-running, or two reversals racing (the live refund vs the backfill), collapses to a single claw-back. Signed
 *  write with NO insufficient-balance guard: if the player already spent the Gold the balance may dip negative,
 *  which is correct (they owe it) and self-corrects as they earn again. Returns the amount reversed. */
export async function reverseEarnedGold(q: Queryer, userId: string, openId: string): Promise<bigint> {
  // Serialize concurrent reversals for this player; the row exists once PACK_OPEN_EARN credited the open.
  await q.query(`SELECT balance FROM gold_balances WHERE user_id = $1 FOR UPDATE`, [userId]);
  const r = await q.query<{ net: string }>(
    `SELECT COALESCE(SUM(delta), 0)::text AS net
       FROM gold_ledger
      WHERE user_id = $1 AND ref_type = 'gacha_open' AND ref_id = $2
        AND reason IN ('PACK_OPEN_EARN', 'PACK_OPEN_EARN_REVERSAL')`,
    [userId, openId],
  );
  const net = BigInt(r.rows[0].net); // earn (+) minus any prior reversal (−) = what's still owed back
  if (net <= 0n) return 0n; // nothing earned for this open, or already fully reversed
  const back = (-net).toString();
  await q.query(
    `INSERT INTO gold_ledger(id, user_id, delta, reason, ref_type, ref_id) VALUES($1,$2,$3,'PACK_OPEN_EARN_REVERSAL','gacha_open',$4)`,
    [randomUUID(), userId, back, openId],
  );
  await q.query(
    `INSERT INTO gold_balances(user_id, balance) VALUES($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET balance = gold_balances.balance + EXCLUDED.balance`,
    [userId, back],
  );
  return net;
}

export async function getGoldSummary(db: Db, userId: string): Promise<{ balance: string; perUsd: number; untilFreePackGold: string }> {
  const r = await db.query<{ balance: string }>(`SELECT balance FROM gold_balances WHERE user_id = $1`, [userId]);
  const bal = r.rows[0] ? BigInt(r.rows[0].balance) : 0n;
  const until = bal >= FREE_PACK_GOLD ? 0n : FREE_PACK_GOLD - bal;
  return { balance: bal.toString(), perUsd: GOLD_PER_USD, untilFreePackGold: until.toString() };
}

export async function getGoldHistory(db: Db, userId: string, limit = 50): Promise<Array<{ delta: string; reason: string; createdAt: string }>> {
  const r = await db.query<{ delta: string; reason: string; created_at: string }>(
    `SELECT delta::text AS delta, reason, created_at::text AS created_at FROM gold_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return r.rows.map((x) => ({ delta: x.delta, reason: x.reason, createdAt: x.created_at }));
}

/** Admin: zero EVERY player's Gold balance, writing a −balance ADMIN_RESET ledger entry per user so the
 *  Σ gold_ledger == gold_balances invariant still holds. Destructive — operator-gated. Returns the user count. */
export async function resetGoldBalances(db: Db): Promise<{ usersReset: number }> {
  return db.tx(async (q) => {
    // Lock the non-zero rows (FOR UPDATE) so a concurrent earn/spend can't change a balance between the read and
    // the zero — which would leave a stale −balance ledger and break the Σ invariant. Zero ONLY the rows we
    // ledgered (per-row, not a blanket UPDATE): a balance earned AFTER this SELECT isn't in the locked set and
    // keeps its own +ledger, so its invariant holds too instead of being silently zeroed without a matching row.
    const rows = (await q.query<{ user_id: string; balance: string }>(`SELECT user_id, balance FROM gold_balances WHERE balance <> 0 FOR UPDATE`)).rows;
    for (const r of rows) {
      await q.query(`INSERT INTO gold_ledger(id, user_id, delta, reason) VALUES($1,$2,$3,'ADMIN_RESET')`, [randomUUID(), r.user_id, (-BigInt(r.balance)).toString()]);
      await q.query(`UPDATE gold_balances SET balance = 0 WHERE user_id = $1`, [r.user_id]);
    }
    return { usersReset: rows.length };
  });
}
