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
