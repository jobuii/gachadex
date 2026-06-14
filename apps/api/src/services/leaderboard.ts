import { unrealizedPnl } from '@pokex/pricing';
import type { Db } from '../db/client.ts';
import { lpShareValue } from './lp.ts';

export interface LeaderboardRow {
  rank: number;
  userId: string;
  pubkey: string;
  realizedPnlUusdc: string; // net booked PnL: (cash + LP value) - net deposits  (fees & funding included)
  equityUusdc: string; // cash + LP value + unrealized PnL
  volumeUusdc: string; // Σ notional traded across all fills
}

/**
 * Trader leaderboard, ranked by net realized PnL. All figures are derived from the ledger so they
 * reconcile with balances:
 *   net deposits   = Σ faucet + referral credits to the user's collateral
 *   cash           = collateral balance + locked margin
 *   LP value       = current worth of the user's LP shares (shares * NAV / total shares)
 *   realized PnL   = cash + LP value - net deposits   (trading/fees/funding + LP yield)
 *   equity         = cash + LP value + unrealized PnL on open positions (marked to latest)
 * LP value must be included: providing to the pool moves capital out of collateral into the
 * LP_POOL system account, so without it a pure LP provider would look like a big trading loss.
 * Computed with a handful of set-based queries + in-memory aggregation (fine for the MVP's user count).
 */
interface RankedEntry {
  userId: string;
  pubkey: string;
  realized: bigint; // net booked PnL — the ranking key
  equity: bigint;
  volume: bigint;
}

/** The full field, ranked by net realized PnL (tie-broken by equity). The heavy part: a set of
 *  set-based queries + in-memory aggregation. Shared by getLeaderboard (top-N + viewer) and rankMap. */
async function computeRanked(db: Db): Promise<RankedEntry[]> {
  const [users, balances, deposits, volume, positions, marks, pool, lpShares] = await Promise.all([
    db.query<{ id: string; solana_pubkey: string }>(`SELECT id, solana_pubkey FROM users`),
    db.query<{ user_id: string; type: string; amt: string }>(
      `SELECT a.user_id, a.type, COALESCE(b.amount_uusdc, 0)::text AS amt
       FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
       WHERE a.user_id IS NOT NULL AND a.type IN ('USER_COLLATERAL', 'USER_POSITION_MARGIN')`,
    ),
    db.query<{ user_id: string; amt: string }>(
      `SELECT a.user_id, COALESCE(SUM(le.amount_uusdc), 0)::text AS amt
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE a.type = 'USER_COLLATERAL' AND le.reason IN ('FAUCET', 'REFERRAL_BONUS')
       GROUP BY a.user_id`,
    ),
    db.query<{ user_id: string; vol: string }>(
      `SELECT o.user_id, COALESCE(SUM(f.qty_e6 * f.exec_price_e6), 0)::text AS vol
       FROM fills f JOIN orders o ON o.id = f.order_id GROUP BY o.user_id`,
    ),
    db.query<{ user_id: string; side: 'long' | 'short'; qty_e6: string; avg_entry_e6: string; market_id: string }>(
      `SELECT user_id, side, qty_e6::text AS qty_e6, avg_entry_e6::text AS avg_entry_e6, market_id
       FROM positions WHERE status = 'open'`,
    ),
    // latest mark per market (one bounded scan, not a per-position probe), as in markets.ts
    db.query<{ market_id: string; mark_e6: string }>(
      `SELECT DISTINCT ON (market_id) market_id, mark_price_e6::text AS mark_e6 FROM marks ORDER BY market_id, computed_at DESC`,
    ),
    // LP pool NAV (the LP_POOL ledger balance) + outstanding shares, to value each LP position
    db.query<{ nav: string; shares: string }>(
      `SELECT COALESCE((SELECT b.amount_uusdc FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.type = 'LP_POOL' LIMIT 1), 0)::text AS nav,
              COALESCE((SELECT total_shares FROM lp_pool WHERE id = 'pool'), 0)::text AS shares`,
    ),
    db.query<{ user_id: string; shares: string }>(`SELECT user_id, shares::text AS shares FROM lp_positions WHERE shares > 0`),
  ]);

  const cash = new Map<string, bigint>(); // collateral + locked margin
  for (const r of balances.rows) cash.set(r.user_id, (cash.get(r.user_id) ?? 0n) + BigInt(r.amt));

  const deposited = new Map<string, bigint>();
  for (const r of deposits.rows) deposited.set(r.user_id, BigInt(r.amt));

  // value each user's LP shares at the current share price, using lp.ts's canonical formula
  const nav = BigInt(pool.rows[0]?.nav ?? '0');
  const totalShares = BigInt(pool.rows[0]?.shares ?? '0');
  const lpValue = new Map<string, bigint>();
  for (const r of lpShares.rows) lpValue.set(r.user_id, lpShareValue(BigInt(r.shares), nav, totalShares));

  const markByMarket = new Map<string, bigint>();
  for (const m of marks.rows) markByMarket.set(m.market_id, BigInt(m.mark_e6));

  const vol = new Map<string, bigint>();
  for (const r of volume.rows) vol.set(r.user_id, BigInt(r.vol) / 1_000_000n); // qty_e6*price_e6 (e12) -> notional micro-USDC (e6)

  const uPnl = new Map<string, bigint>();
  for (const p of positions.rows) {
    const mark = markByMarket.get(p.market_id);
    if (!mark) continue;
    const pnl = unrealizedPnl(p.side, BigInt(p.qty_e6), BigInt(p.avg_entry_e6), mark);
    uPnl.set(p.user_id, (uPnl.get(p.user_id) ?? 0n) + pnl);
  }

  return users.rows
    .map((u) => {
      const c = (cash.get(u.id) ?? 0n) + (lpValue.get(u.id) ?? 0n); // total cash incl. LP position value
      const realized = c - (deposited.get(u.id) ?? 0n);
      return {
        userId: u.id,
        pubkey: u.solana_pubkey,
        realized,
        equity: c + (uPnl.get(u.id) ?? 0n),
        volume: vol.get(u.id) ?? 0n,
      };
    })
    .sort((a, b) => (b.realized === a.realized ? cmp(b.equity, a.equity) : cmp(b.realized, a.realized)));
}

export async function getLeaderboard(
  db: Db,
  opts: { limit?: number; viewerUserId?: string } = {},
): Promise<{ rows: LeaderboardRow[]; you: LeaderboardRow | null; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const ranked = await computeRanked(db);

  const toRow = (e: RankedEntry, i: number): LeaderboardRow => ({
    rank: i + 1,
    userId: e.userId,
    pubkey: e.pubkey,
    realizedPnlUusdc: e.realized.toString(),
    equityUusdc: e.equity.toString(),
    volumeUusdc: e.volume.toString(),
  });

  const rows = ranked.slice(0, limit).map(toRow);
  let you: LeaderboardRow | null = null;
  if (opts.viewerUserId) {
    const idx = ranked.findIndex((e) => e.userId === opts.viewerUserId);
    if (idx >= 0) you = toRow(ranked[idx], idx);
  }
  return { rows, you, total: ranked.length };
}

// --- rank badges (F4) -------------------------------------------------------------------------------
const RANK_BADGE_CUTOFF = 100; // only the top 100 earn a badge, so the map only needs those entries
const RANK_CACHE_MS = 60_000; // every chat client polls this; the full scan is heavy -> cache ~60s

let rankCache: { at: number; ranks: Record<string, number>; total: number } | null = null;

/** userId -> rank (1-based) for the top RANK_BADGE_CUTOFF traders, cached ~60s. Drives the chat rank
 *  badges; users outside the top N are absent from the map (and get no badge). */
export async function rankMap(db: Db): Promise<{ ranks: Record<string, number>; total: number }> {
  if (rankCache && Date.now() - rankCache.at < RANK_CACHE_MS) return { ranks: rankCache.ranks, total: rankCache.total };
  const ranked = await computeRanked(db);
  const ranks: Record<string, number> = {};
  for (let i = 0; i < Math.min(ranked.length, RANK_BADGE_CUTOFF); i++) ranks[ranked[i].userId] = i + 1;
  rankCache = { at: Date.now(), ranks, total: ranked.length };
  return { ranks, total: ranked.length };
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
