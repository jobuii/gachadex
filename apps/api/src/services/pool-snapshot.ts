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
  apyPct: number; // trailing-7d earnings run-rate on the current NAV, annualized — the "APY (7d)" figure
  sharePriceE6: string;
  navUusdc: string;
  ageDays: number;
  snapshotAt: string;
}

/** Compute the live display values (does NOT persist them — see setPoolSnapshot). */
export async function computePoolSnapshot(db: Db): Promise<PoolSnapshot> {
  const { lp, nav, totalShares } = await poolState(db);
  const sharePriceE6 = poolSharePriceE6(nav, totalShares);

  // Three independent LP_POOL ledger scans — run them together:
  //  - net LP capital in (deposits − withdrawals), for the all-time "NAV gained" figure.
  //  - pool age (days), to bound the annualization window for a young pool.
  //  - trailing-7d earnings (fees + funding + trader P/L) for the APY run-rate.
  const [dep, age, earn] = await Promise.all([
    db.query<{ net: string }>(
      `SELECT COALESCE(SUM(amount_uusdc), 0)::text AS net FROM ledger_entries
       WHERE account_id = $1 AND reason IN ('LP_DEPOSIT', 'LP_WITHDRAW')`,
      [lp],
    ),
    db.query<{ secs: number | string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::float8 AS secs FROM ledger_entries WHERE account_id = $1`,
      [lp],
    ),
    db.query<{ e: string }>(
      `SELECT COALESCE(SUM(amount_uusdc), 0)::text AS e FROM ledger_entries
       WHERE account_id = $1 AND reason IN ('OPEN_FEE', 'CLOSE_FEE', 'FUNDING', 'REALIZED_PNL')
         AND created_at > now() - interval '7 days'`,
      [lp],
    ),
  ]);
  const totalFeesEarnedE6 = nav - BigInt(dep.rows[0].net); // all-time earnings (NAV over net capital in)
  const days = Number(age.rows[0]?.secs ?? 0) / 86_400;

  // APY (7d): the trailing-7-day earnings as a run-rate on the CURRENT NAV, annualized (compounded) — the
  // standard "7d APY". Unlike a since-inception share-price figure (which stays stuck on the pool's early
  // high return and is hyper-sensitive — a 6% price move 5×'d it), this reflects the CURRENT earning rate on
  // the CURRENT pool size, so it correctly FALLS when fresh capital dilutes the same earnings. A pool younger
  // than 7d annualizes over its actual age; under ~12h old it's left at 0 (too little history to annualize).
  const navNum = Number(nav);
  const earn7d = Number(BigInt(earn.rows[0].e));
  let apyPct = 0;
  if (navNum > 0 && days >= 0.5) {
    const windowDays = Math.min(7, days);
    apyPct = (Math.pow(1 + earn7d / navNum, 365 / windowDays) - 1) * 100;
  }
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
