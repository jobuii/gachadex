import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, getBalance, postTxn } from './ledger.ts';
import { grossOpenNotional } from './oi.ts';

/**
 * LP pool, ERC-4626 style. NAV = the LP_POOL ledger balance (real USDC LPs put in, plus
 * net trader losses, minus net trader payouts — the pool is the counterparty). Deposits mint
 * shares at the current share price; withdrawals burn shares at the current share price.
 * Withdrawals cannot dip below the capital reserved against open trader interest.
 */

/** Value of an LP stake at the current share price: shares * NAV / total shares (0 when no shares). */
export function lpShareValue(shares: bigint, nav: bigint, totalShares: bigint): bigint {
  return totalShares > 0n ? (shares * nav) / totalShares : 0n;
}

/** Value of 1e6 shares at the current NAV — the scaled share price (1e6 == $1.00 when the pool bootstraps). */
export function poolSharePriceE6(nav: bigint, totalShares: bigint): bigint {
  return totalShares > 0n ? (nav * 1_000_000n) / totalShares : 1_000_000n;
}

async function poolMeta(q: Queryer): Promise<{ totalShares: bigint; reserved: bigint }> {
  const r = await q.query<{ s: string; r: string }>(
    `SELECT total_shares::text AS s, reserved_for_oi_uusdc::text AS r FROM lp_pool WHERE id='pool'`,
  );
  return { totalShares: BigInt(r.rows[0]?.s ?? '0'), reserved: BigInt(r.rows[0]?.r ?? '0') };
}

/** Pool snapshot: LP_POOL account id, NAV (ledger balance), outstanding shares, reserved capital. */
export async function poolState(q: Queryer): Promise<{ lp: string; nav: bigint; totalShares: bigint; reserved: bigint }> {
  const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
  const nav = await getBalance(q, lp);
  const { totalShares, reserved } = await poolMeta(q);
  return { lp, nav, totalShares, reserved };
}

export async function lpDeposit(db: Db, userId: string, amountUusdc: bigint): Promise<{ sharesMinted: string; navAfter: string }> {
  if (amountUusdc <= 0n) throw new HttpError(400, 'amount must be positive');
  return db.tx(async (q) => {
    const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const available = await getBalance(q, coll);
    if (available < amountUusdc) throw new HttpError(400, 'insufficient balance');

    const nav = await getBalance(q, lp);
    const { totalShares } = await poolMeta(q);
    // bootstrap (or recover from a depleted pool): 1 share == 1 micro-USDC
    const sharesMinted = totalShares <= 0n || nav <= 0n ? amountUusdc : (amountUusdc * totalShares) / nav;

    await postTxn(q, {
      reason: 'LP_DEPOSIT',
      entries: [
        { accountId: coll, amount: -amountUusdc },
        { accountId: lp, amount: amountUusdc },
      ],
    });
    await q.query(
      `UPDATE lp_pool SET total_shares = total_shares + $1, total_assets_uusdc = $2, version = version + 1, updated_at = now() WHERE id='pool'`,
      [sharesMinted.toString(), (nav + amountUusdc).toString()],
    );
    await q.query(
      `INSERT INTO lp_positions(id, user_id, shares, cost_basis_uusdc) VALUES($1,$2,$3,$4)
       ON CONFLICT(user_id) DO UPDATE SET shares = lp_positions.shares + EXCLUDED.shares,
         cost_basis_uusdc = lp_positions.cost_basis_uusdc + EXCLUDED.cost_basis_uusdc, updated_at = now()`,
      [randomUUID(), userId, sharesMinted.toString(), amountUusdc.toString()],
    );
    return { sharesMinted: sharesMinted.toString(), navAfter: (nav + amountUusdc).toString() };
  });
}

export async function lpWithdraw(db: Db, userId: string, shares: bigint): Promise<{ payoutUusdc: string; navAfter: string }> {
  if (shares <= 0n) throw new HttpError(400, 'shares must be positive');
  return db.tx(async (q) => {
    const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const pos = await q.query<{ s: string }>(`SELECT shares::text AS s FROM lp_positions WHERE user_id=$1`, [userId]);
    const userShares = BigInt(pos.rows[0]?.s ?? '0');
    if (shares > userShares) throw new HttpError(400, 'insufficient LP shares');

    const nav = await getBalance(q, lp);
    const { totalShares, reserved } = await poolMeta(q);
    if (totalShares <= 0n || nav <= 0n) throw new HttpError(400, 'pool is depleted');
    const payout = lpShareValue(shares, nav, totalShares);
    if (payout <= 0n) throw new HttpError(400, 'nothing to withdraw');
    if (nav - payout < reserved) throw new HttpError(400, 'withdrawal would dip into capital backing open trades');

    await postTxn(q, {
      reason: 'LP_WITHDRAW',
      entries: [
        { accountId: lp, amount: -payout },
        { accountId: coll, amount: payout },
      ],
    });
    await q.query(
      `UPDATE lp_pool SET total_shares = total_shares - $1, total_assets_uusdc = $2, version = version + 1, updated_at = now() WHERE id='pool'`,
      [shares.toString(), (nav - payout).toString()],
    );
    await q.query(`UPDATE lp_positions SET shares = shares - $1, updated_at = now() WHERE user_id=$2`, [shares.toString(), userId]);
    return { payoutUusdc: payout.toString(), navAfter: (nav - payout).toString() };
  });
}

export interface PoolView {
  navUusdc: string;
  totalShares: string;
  reservedUusdc: string;
  sharePriceE6: string; // value of 1e6 shares, scaled — NAV*1e6/totalShares
}

export async function getPool(db: Db): Promise<PoolView> {
  const { nav, totalShares, reserved } = await poolState(db);
  return {
    navUusdc: nav.toString(),
    totalShares: totalShares.toString(),
    reservedUusdc: reserved.toString(),
    sharePriceE6: poolSharePriceE6(nav, totalShares).toString(),
  };
}

export async function getLpPosition(db: Db, userId: string): Promise<{ shares: string; valueUusdc: string }> {
  const pos = await db.query<{ s: string }>(`SELECT shares::text AS s FROM lp_positions WHERE user_id=$1`, [userId]);
  const shares = BigInt(pos.rows[0]?.s ?? '0');
  const { nav, totalShares } = await poolState(db);
  return { shares: shares.toString(), valueUusdc: lpShareValue(shares, nav, totalShares).toString() };
}

/** Total current value of ALL customers' LP stakes (Σ share value). Equals NAV when the pool is
 *  entirely customer-funded; derived from shares so it stays correct if the house ever seeds the pool. */
export async function customerLpTotal(db: Db): Promise<bigint> {
  const { nav, totalShares } = await poolState(db);
  const r = await db.query<{ s: string }>(`SELECT COALESCE(SUM(shares), 0)::text AS s FROM lp_positions WHERE shares > 0`);
  return lpShareValue(BigInt(r.rows[0].s), nav, totalShares);
}

/** Recompute pool-wide reserved capital = gross open notional across all markets. */
export async function refreshReserved(q: Queryer): Promise<void> {
  const reserved = await grossOpenNotional(q);
  await q.query(`UPDATE lp_pool SET reserved_for_oi_uusdc = $1, updated_at = now() WHERE id='pool'`, [reserved.toString()]);
}
