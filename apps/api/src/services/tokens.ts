import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import type { Db, Queryer } from '../db/client.ts';

/**
 * Classic Gacha loyalty Tokens (docs/classic-gacha-cc-packs-spec.md §6b). A per-player points currency,
 * 1 Token = $0.001, separate from the USDC ledger and from on-chain $GDEX — non-transferable, non-withdrawable.
 * Its own double-entry-free ledger: the invariant is `Σ token_ledger.delta == token_balances.balance` per user
 * (there is no Σ=0 cross-account partner; a token-bought pack's USDC cost is booked in the USDC ledger separately).
 * earn/spend run inside the caller's tx (a `Queryer`) so they're atomic with the open/charge.
 */

export const FREE_PACK_TOKENS = 25_000n; // a free $25 pack at 1000 Tokens/$ — the loyalty reward unit
export const TOKEN_PER_USD = 0.001; // 1 Token = $0.001 (for the wire)

/** A pack's Token price = USD × 1000 (a $25 pack = 25,000 Tokens). priceE6 is micro-USDC → /1000. */
export function tokenPriceForPack(priceE6: bigint): bigint {
  return priceE6 / 1000n;
}

/** Tokens earned on a paid (USDC) open: priceUSD × (FREE_PACK_TOKENS / thresholdUSD), integer-floored.
 *  threshold $1000 → a $25 open earns 625 (≈2.5% rebate); $100 earns 2,500. */
export function tokensEarnedForOpen(priceE6: bigint, thresholdUsd: number): bigint {
  if (thresholdUsd <= 0) return 0n;
  return (priceE6 * FREE_PACK_TOKENS) / (BigInt(thresholdUsd) * 1_000_000n);
}

interface Ref { refType?: string; refId?: string }

/** Credit Tokens (earn). No-op for delta ≤ 0. */
export async function earnTokens(q: Queryer, userId: string, delta: bigint, reason: string, ref: Ref = {}): Promise<void> {
  if (delta <= 0n) return;
  await q.query(`INSERT INTO token_ledger(id, user_id, delta, reason, ref_type, ref_id) VALUES($1,$2,$3,$4,$5,$6)`, [
    randomUUID(), userId, delta.toString(), reason, ref.refType ?? null, ref.refId ?? null,
  ]);
  await q.query(
    `INSERT INTO token_balances(user_id, balance) VALUES($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET balance = token_balances.balance + EXCLUDED.balance`,
    [userId, delta.toString()],
  );
}

/** Debit Tokens (spend). Locks the balance row FOR UPDATE; throws 400 insufficient_tokens if short. */
export async function spendTokens(q: Queryer, userId: string, amount: bigint, ref: Ref = {}): Promise<void> {
  if (amount <= 0n) throw new HttpError(400, 'invalid token amount');
  const lock = await q.query<{ balance: string }>(`SELECT balance FROM token_balances WHERE user_id = $1 FOR UPDATE`, [userId]);
  const bal = lock.rows[0] ? BigInt(lock.rows[0].balance) : 0n;
  if (bal < amount) throw new HttpError(400, 'insufficient Tokens', 'insufficient_tokens');
  await q.query(`UPDATE token_balances SET balance = balance - $2 WHERE user_id = $1`, [userId, amount.toString()]);
  await q.query(`INSERT INTO token_ledger(id, user_id, delta, reason, ref_type, ref_id) VALUES($1,$2,$3,$4,$5,$6)`, [
    randomUUID(), userId, (-amount).toString(), 'PACK_BUY_TOKENS', ref.refType ?? null, ref.refId ?? null,
  ]);
}

export async function getTokenSummary(db: Db, userId: string): Promise<{ balance: string; perUsd: number; untilFreePackTokens: string }> {
  const r = await db.query<{ balance: string }>(`SELECT balance FROM token_balances WHERE user_id = $1`, [userId]);
  const bal = r.rows[0] ? BigInt(r.rows[0].balance) : 0n;
  const until = bal >= FREE_PACK_TOKENS ? 0n : FREE_PACK_TOKENS - bal;
  return { balance: bal.toString(), perUsd: TOKEN_PER_USD, untilFreePackTokens: until.toString() };
}

export async function getTokenHistory(db: Db, userId: string, limit = 50): Promise<Array<{ delta: string; reason: string; createdAt: string }>> {
  const r = await db.query<{ delta: string; reason: string; created_at: string }>(
    `SELECT delta::text AS delta, reason, created_at::text AS created_at FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return r.rows.map((x) => ({ delta: x.delta, reason: x.reason, createdAt: x.created_at }));
}
