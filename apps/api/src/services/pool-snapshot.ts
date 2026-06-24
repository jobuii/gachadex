import type { Db } from '../db/client.ts';
import { getLpTradingPct, getLpFundingPct, getLpLiquidationPct } from './fees.ts';
import { poolState, poolSharePriceE6 } from './lp.ts';

/**
 * Pool-page display snapshot. The LP-share knobs (fees.ts) drive the LIVE split mechanics; the public pool
 * page instead shows this PUBLISHED snapshot, so an operator tuning a share mid-flight doesn't flicker the
 * customer page. The admin "Refresh pool numbers" button recomputes + republishes it. Stored as one JSON
 * blob in `settings` (key `pool_display_snapshot`).
 */

const SETTING_KEY = 'pool_display_snapshot';

export interface PoolSnapshot {
  lpTradingPct: number;
  lpFundingPct: number;
  lpLiquidationPct: number;
  totalFeesEarnedE6: string; // NAV gained over net LP capital contributed (what LPs have earned, mark-to-market)
  apyPct: number; // since-inception APY from share-price growth (operator-published; see note in the UI)
  sharePriceE6: string;
  navUusdc: string;
  ageDays: number;
  snapshotAt: string;
}

/** Compute the live display values (does NOT persist them — see setPoolSnapshot). */
export async function computePoolSnapshot(db: Db): Promise<PoolSnapshot> {
  const { lp, nav, totalShares } = await poolState(db);
  const sharePriceE6 = poolSharePriceE6(nav, totalShares);

  // Both reads scan the LP_POOL ledger and don't depend on each other — run them together:
  //  - NAV gained = current NAV minus net capital LPs contributed (deposits − withdrawals) — what the pool
  //    has earned for LPs (fees + funding + trader P/L), marked to market.
  //  - pool age (days) from the first LP_POOL ledger entry, for the annualization.
  const [dep, age] = await Promise.all([
    db.query<{ net: string }>(
      `SELECT COALESCE(SUM(amount_uusdc), 0)::text AS net FROM ledger_entries
       WHERE account_id = $1 AND reason IN ('LP_DEPOSIT', 'LP_WITHDRAW')`,
      [lp],
    ),
    db.query<{ secs: number | string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::float8 AS secs FROM ledger_entries WHERE account_id = $1`,
      [lp],
    ),
  ]);
  const totalFeesEarnedE6 = nav - BigInt(dep.rows[0].net);
  const days = Number(age.rows[0]?.secs ?? 0) / 86_400;

  // APY from share-price growth since inception (the share price starts at $1.00 = 1e6). Annualizing a young
  // pool is noisy — the operator controls when this is republished, hence the snapshot.
  const priceRatio = Number(sharePriceE6) / 1_000_000;
  let apyPct = 0;
  if (days >= 0.5 && priceRatio > 0) apyPct = (Math.pow(priceRatio, 365 / days) - 1) * 100;
  if (!Number.isFinite(apyPct)) apyPct = 0;

  return {
    lpTradingPct: getLpTradingPct(),
    lpFundingPct: getLpFundingPct(),
    lpLiquidationPct: getLpLiquidationPct(),
    totalFeesEarnedE6: totalFeesEarnedE6.toString(),
    apyPct: Math.round(apyPct * 10) / 10,
    sharePriceE6: sharePriceE6.toString(),
    navUusdc: nav.toString(),
    ageDays: Math.round(days * 100) / 100,
    snapshotAt: new Date().toISOString(),
  };
}

/** Recompute + persist the snapshot (the admin "Refresh pool numbers" action). Returns what was published. */
export async function setPoolSnapshot(db: Db): Promise<PoolSnapshot> {
  const snap = await computePoolSnapshot(db);
  await db.query(
    `INSERT INTO settings(key, value) VALUES($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SETTING_KEY, JSON.stringify(snap)],
  );
  return snap;
}

/** The currently-published snapshot, or null if "Refresh pool numbers" has never been clicked. */
export async function getPoolSnapshot(db: Db): Promise<PoolSnapshot | null> {
  const r = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [SETTING_KEY]);
  if (!r.rows[0]) return null;
  try {
    return JSON.parse(r.rows[0].value) as PoolSnapshot;
  } catch {
    return null;
  }
}
