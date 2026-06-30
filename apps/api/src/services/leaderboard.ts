import { unrealizedPnl } from '@pokex/pricing';
import type { Db } from '../db/client.ts';
import { lpShareValue } from './lp.ts';

// Ledger reasons that move EXTERNAL capital in/out of a user's collateral — everything that is NOT a
// trading result. Subtracted from (cash + LP value) to leave pure realized PnL; the ledger's natural
// signs net (deposits/faucet/referral/reversals are +, withdrawals/tips are -). NB this is deliberately
// NOT history.ts's "Transfer" set: LP_DEPOSIT/LP_WITHDRAW are EXCLUDED (LP capital is valued separately
// via lpValue), and DROP_TIP is INCLUDED (a tip is capital leaving collateral). If a new external-flow
// reason is added to the ledger, add it here too — otherwise the leaderboard silently counts it as PnL.
const EXTERNAL_CAPITAL_REASONS = ['FAUCET', 'REFERRAL_BONUS', 'DEPOSIT', 'WITHDRAWAL', 'WITHDRAWAL_REVERSAL', 'DROP_TIP', 'SIGNUP_CREDIT', 'SIGNUP_CREDIT_EXPIRE'];

export interface LeaderboardRow {
  rank: number;
  userId: string;
  pubkey: string;
  realizedPnlUusdc: string; // net booked PnL: (cash + LP value) - net external capital in  (fees & funding included)
  equityUusdc: string; // cash + LP value + unrealized PnL (kept for API back-compat + tests; no longer shown in the UI)
  volumeUusdc: string; // Σ notional traded across all fills
  goldEarned: string; // lifetime Gold earned from pack opens (PACK_OPEN_EARN − refund reversals; whole Gold)
}

/**
 * Trader leaderboard, ranked by net realized PnL. All figures are derived from the ledger so they
 * reconcile with balances:
 *   net capital in = Σ external collateral flows that ARE NOT a trading result — faucet, referral,
 *                    real deposits, minus withdrawals and DROP tips (the ledger's natural signs net)
 *   cash           = collateral balance + locked margin
 *   LP value       = current worth of the user's LP shares (shares * NAV / total shares)
 *   realized PnL   = cash + LP value - net capital in   (deposits/withdrawals/tips net out; what is
 *                    left is pure trading/fees/funding + LP yield)
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
  goldEarned: bigint;
}

/** The full field, ranked by net realized PnL (tie-broken by equity). The heavy part: a set of
 *  set-based queries + in-memory aggregation. Shared by getLeaderboard (top-N + viewer) and rankMap. */
async function computeRanked(db: Db): Promise<RankedEntry[]> {
  const [users, balances, netCapital, volume, positions, marks, pool, lpShares, gold] = await Promise.all([
    db.query<{ id: string; solana_pubkey: string }>(`SELECT id, solana_pubkey FROM users`),
    db.query<{ user_id: string; type: string; amt: string }>(
      `SELECT a.user_id, a.type, COALESCE(b.amount_uusdc, 0)::text AS amt
       FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
       WHERE a.user_id IS NOT NULL AND a.type IN ('USER_COLLATERAL', 'USER_POSITION_MARGIN')`,
    ),
    // Σ external capital into each user's collateral (EXTERNAL_CAPITAL_REASONS) — subtracted from value
    // to leave pure realized PnL; the ledger's natural signs net deposits-in against withdrawals/tips-out.
    db.query<{ user_id: string; amt: string }>(
      `SELECT a.user_id, COALESCE(SUM(le.amount_uusdc), 0)::text AS amt
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE a.type = 'USER_COLLATERAL' AND le.reason = ANY($1::text[])
       GROUP BY a.user_id`,
      [EXTERNAL_CAPITAL_REASONS],
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
    // lifetime Gold earned from pack opens (PACK_OPEN_EARN minus refund reversals; spends excluded) — leaderboard flex metric
    db.query<{ user_id: string; gold: string }>(
      `SELECT user_id, COALESCE(SUM(delta) FILTER (WHERE reason IN ('PACK_OPEN_EARN', 'PACK_OPEN_EARN_REVERSAL')), 0)::text AS gold
       FROM gold_ledger GROUP BY user_id`,
    ),
  ]);

  const cash = new Map<string, bigint>(); // collateral + locked margin
  for (const r of balances.rows) cash.set(r.user_id, (cash.get(r.user_id) ?? 0n) + BigInt(r.amt));

  const netCapitalIn = new Map<string, bigint>(); // external collateral flows (signed); subtracted from value
  for (const r of netCapital.rows) netCapitalIn.set(r.user_id, BigInt(r.amt));

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

  const goldByUser = new Map<string, bigint>();
  for (const r of gold.rows) goldByUser.set(r.user_id, BigInt(r.gold));

  return users.rows
    .map((u) => {
      const c = (cash.get(u.id) ?? 0n) + (lpValue.get(u.id) ?? 0n); // total cash incl. LP position value
      const realized = c - (netCapitalIn.get(u.id) ?? 0n);
      return {
        userId: u.id,
        pubkey: u.solana_pubkey,
        realized,
        equity: c + (uPnl.get(u.id) ?? 0n),
        volume: vol.get(u.id) ?? 0n,
        goldEarned: goldByUser.get(u.id) ?? 0n,
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
    goldEarned: e.goldEarned.toString(),
  });

  const rows = ranked.slice(0, limit).map(toRow);
  let you: LeaderboardRow | null = null;
  if (opts.viewerUserId) {
    const idx = ranked.findIndex((e) => e.userId === opts.viewerUserId);
    if (idx >= 0) you = toRow(ranked[idx], idx);
  }
  return { rows, you, total: ranked.length };
}

// --- rank badges (F4) + standing/level for hover cards (F3) -----------------------------------------
const RANK_BADGE_CUTOFF = 100; // only the top 100 earn a rank badge
const RANK_CACHE_MS = 60_000; // the full scan is heavy and every chat client polls -> cache ~60s

// the full ranked field + a userId->index lookup, cached ~60s. Drives rankMap (top-100 badges) AND
// userStanding (any user's rank/level/figures for a hover card), so the heavy scan runs once per minute.
let snapCache: { at: number; ranked: RankedEntry[]; index: Map<string, number> } | null = null;

async function rankedSnapshot(db: Db): Promise<{ ranked: RankedEntry[]; index: Map<string, number> }> {
  if (snapCache && Date.now() - snapCache.at < RANK_CACHE_MS) return snapCache;
  const ranked = await computeRanked(db);
  const index = new Map<string, number>();
  ranked.forEach((e, i) => index.set(e.userId, i));
  snapCache = { at: Date.now(), ranked, index };
  return snapCache;
}

/** userId -> rank (1-based) for the top RANK_BADGE_CUTOFF traders. Users outside the top N are absent
 *  (no badge). A fresh object each call (derived from the cached snapshot). */
export async function rankMap(db: Db): Promise<{ ranks: Record<string, number>; total: number }> {
  const { ranked } = await rankedSnapshot(db);
  const ranks: Record<string, number> = {};
  for (let i = 0; i < Math.min(ranked.length, RANK_BADGE_CUTOFF); i++) ranks[ranked[i].userId] = i + 1;
  return { ranks, total: ranked.length };
}

/** Volume tier (L1..L6) from cumulative traded volume (micro-USDC): L1 <$1k, L2 $1k, L3 $10k, L4 $50k,
 *  L5 $250k, L6 $1M+. Pure. */
export function userLevel(volumeUusdc: bigint): number {
  const usd = volumeUusdc / 1_000_000n;
  if (usd >= 1_000_000n) return 6;
  if (usd >= 250_000n) return 5;
  if (usd >= 50_000n) return 4;
  if (usd >= 10_000n) return 3;
  if (usd >= 1_000n) return 2;
  return 1;
}

export interface UserStanding {
  rank: number | null; // 1-based leaderboard rank; null if the user has no standing
  total: number; // size of the ranked field
  level: number; // volume tier L1..L6
  volumeUusdc: string;
  pnlUusdc: string; // net realized PnL
}

/** A single user's leaderboard standing — rank, volume level, and figures — for the profile hover card. */
export async function userStanding(db: Db, userId: string): Promise<UserStanding> {
  const { ranked, index } = await rankedSnapshot(db);
  const idx = index.get(userId);
  const e = idx != null ? ranked[idx] : null;
  const volume = e?.volume ?? 0n;
  return {
    rank: idx != null ? idx + 1 : null,
    total: ranked.length,
    level: userLevel(volume),
    volumeUusdc: volume.toString(),
    pnlUusdc: (e?.realized ?? 0n).toString(),
  };
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
