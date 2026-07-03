import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { usdc } from '../money.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, postTxn } from './ledger.ts';
import { handleFor } from './handles.ts';
import { assertSpendableExcludingBonus } from './bonus.ts';
import { publish } from './bus.ts';
import { emitGameWinEvent } from './chat.ts';
import { cardFantasyConfig, type CardFantasyConfig } from './game-config.ts';

/**
 * Card Fantasy (docs/games-spec.md, game #6). A recurring DFS-style league: pay an entry, draft a roster of
 * `rosterSize` DISTINCT featured cards whose combined value is under the salary `capUsd`, and over a window
 * each roster scores the SUM of its cards' oracle %-moves. Top score takes the prize pool (entries minus a
 * rake = the edge); below `minEntries` the league refunds. Skill-predominant — the oracle is the scoreboard,
 * no house RNG. One open league at a time (uq_open_round_per_game); each card's start is snapshotted at
 * entry (so the roster is scored from when it was drafted to the league close). Entries escrow into
 * GAME_POOL; settle pays winners or refunds, with the rake retained. Settle-on-read + a lease-guarded sweep
 * worker (startFantasyLoop). Flag-gated OFF by default.
 */

const GAMES_OFF = () => new HttpError(403, 'games are not enabled', 'games_disabled');
function requireOn(): CardFantasyConfig {
  if (!config.gamesEnabled) throw GAMES_OFF();
  const cfg = cardFantasyConfig();
  if (!cfg.enabled) throw GAMES_OFF();
  return cfg;
}

interface FantasyCard { marketId: string; symbol: string; displayName: string; imageSmall: string | null; entryE6: string }
interface LeagueParams {
  entryUsd: number;
  capUsd: number;
  rosterSize: number;
  rakeBps: number;
  minEntries: number;
  windowHours: number;
  closeAt: string;
  refunded?: boolean;
  winnerUserIds?: string[];
}
interface EntryResult { roster: FantasyCard[]; scoreBps?: string; prizeE6?: string }
interface LeagueRow { id: string; status: string; params: LeagueParams }
const LEAGUE_COLS = `id, status, params`;

/** Sum of the roster's per-card %-moves, in bps, from each card's entry snapshot to the given close marks. */
function scoreRoster(roster: FantasyCard[], close: Map<string, bigint>): bigint {
  let s = 0n;
  for (const c of roster) {
    const start = BigInt(c.entryE6);
    if (start <= 0n) continue;
    const closeE6 = close.get(c.marketId) ?? start;
    s += ((closeE6 - start) * 10_000n) / start;
  }
  return s;
}

async function marksNow(q: Queryer, ids: string[]): Promise<Map<string, bigint>> {
  if (ids.length === 0) return new Map();
  const r = await q.query<{ market_id: string; m: string }>(
    `SELECT DISTINCT ON (market_id) market_id, mark_price_e6::text AS m FROM marks WHERE market_id = ANY($1) ORDER BY market_id, computed_at DESC, id DESC`,
    [ids],
  );
  return new Map(r.rows.map((x) => [x.market_id, BigInt(x.m)]));
}
async function marksAt(q: Queryer, ids: string[], ts: string): Promise<Map<string, bigint>> {
  if (ids.length === 0) return new Map();
  const r = await q.query<{ market_id: string; m: string }>(
    `SELECT DISTINCT ON (market_id) market_id, mark_price_e6::text AS m FROM marks WHERE market_id = ANY($1) AND computed_at <= $2 ORDER BY market_id, computed_at DESC, id DESC`,
    [ids, ts],
  );
  return new Map(r.rows.map((x) => [x.market_id, BigInt(x.m)]));
}

/** A draftable card = featured, active card with a current mark; returns it + its mark (salary/start). */
async function validCard(q: Queryer, marketId: string): Promise<FantasyCard | null> {
  const r = await q.query<{ id: string; symbol: string; display_name: string; image_small: string | null; mark: string | null }>(
    `SELECT m.id, m.symbol, m.display_name, m.image_small,
            (SELECT mark_price_e6::text FROM marks WHERE market_id = m.id ORDER BY computed_at DESC, id DESC LIMIT 1) AS mark
       FROM markets m WHERE m.id = $1 AND m.featured AND m.kind = 'card' AND m.status = 'active'`,
    [marketId],
  );
  const x = r.rows[0];
  if (!x || x.mark == null) return null;
  return { marketId: x.id, symbol: x.symbol, displayName: x.display_name, imageSmall: x.image_small, entryE6: x.mark };
}

/** Pay USDC out of GAME_POOL to a user (prize / refund), collateral-then-pool lock order + solvency check. */
async function payFromPool(q: Queryer, userId: string, amount: bigint, reason: string, refId: string): Promise<void> {
  if (amount <= 0n) return;
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  await q.query(`SELECT 1 FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
  const pool = await getOrCreateSystemAccount(q, 'GAME_POOL');
  const pl = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [pool]);
  if ((pl.rows[0] ? BigInt(pl.rows[0].amount_uusdc) : 0n) < amount) throw new HttpError(503, 'GAME_POOL has insufficient funds — top it up');
  await postTxn(q, { reason, refType: 'card_fantasy', refId, entries: [{ accountId: coll, amount }, { accountId: pool, amount: -amount }] });
}

export interface LeagueView {
  leagueId: string;
  status: string; // open | settled
  closeAt: string;
  entryUsd: number;
  capUsd: number;
  rosterSize: number;
  rakeBps: number;
  minEntries: number;
  entrantCount: number;
  prizePoolE6: string; // entries minus rake (projected while open, final once settled)
  refunded: boolean;
  yourEntry: { roster: (FantasyCard & { currentE6: string; moveBps: number })[]; scoreBps: string; prizeE6: string | null } | null;
  leaderboard: { handle: string; scoreBps: string; isYou: boolean }[];
}

async function buildLeagueView(q: Queryer, league: LeagueRow, userId: string): Promise<LeagueView> {
  const p = league.params;
  const settled = league.status === 'settled';
  const entries = await q.query<{ id: string; user_id: string; result: EntryResult }>(`SELECT id, user_id, result FROM game_plays WHERE round_id = $1`, [league.id]);
  const cardIds = [...new Set(entries.rows.flatMap((e) => e.result.roster.map((c) => c.marketId)))];
  // Live scoring for the board uses current marks; a settled league uses each entry's frozen score.
  const marks = settled ? new Map<string, bigint>() : await marksNow(q, cardIds);
  const score = (e: { result: EntryResult }) => (settled && e.result.scoreBps != null ? BigInt(e.result.scoreBps) : scoreRoster(e.result.roster, marks));

  const pool = usdc(p.entryUsd) * BigInt(entries.rows.length);
  const board = entries.rows.map((e) => ({ id: e.id, userId: e.user_id, score: score(e) }))
    .sort((a, b) => (b.score > a.score ? 1 : b.score < a.score ? -1 : 0));
  const handleRows = await q.query<{ id: string; dn: string | null; pk: string }>(`SELECT id, display_name AS dn, solana_pubkey AS pk FROM users WHERE id = ANY($1)`, [board.map((b) => b.userId)]);
  const handles = new Map(handleRows.rows.map((u) => [u.id, handleFor(u.dn, u.pk)]));

  const mine = entries.rows.find((e) => e.user_id === userId) ?? null;
  return {
    leagueId: league.id,
    status: league.status,
    closeAt: p.closeAt,
    entryUsd: p.entryUsd,
    capUsd: p.capUsd,
    rosterSize: p.rosterSize,
    rakeBps: p.rakeBps,
    minEntries: p.minEntries,
    entrantCount: entries.rows.length,
    prizePoolE6: (p.refunded ? 0n : pool - (pool * BigInt(p.rakeBps)) / 10_000n).toString(),
    refunded: !!p.refunded,
    yourEntry: mine
      ? {
          roster: mine.result.roster.map((c) => {
            const cur = (settled ? null : marks.get(c.marketId)) ?? BigInt(c.entryE6);
            const start = BigInt(c.entryE6);
            return { ...c, currentE6: cur.toString(), moveBps: start > 0n ? Number(((cur - start) * 10_000n) / start) : 0 };
          }),
          scoreBps: score(mine).toString(),
          prizeE6: settled ? mine.result.prizeE6 ?? '0' : null,
        }
      : null,
    leaderboard: board.slice(0, 10).map((b) => ({ handle: handles.get(b.userId) ?? 'someone', scoreBps: b.score.toString(), isYou: b.userId === userId })),
  };
}

/** Open a fresh league (entry-open for windowHours) and return it locked. */
async function createLeague(q: Queryer, cfg: CardFantasyConfig): Promise<LeagueRow> {
  const id = randomUUID();
  const params: LeagueParams = {
    entryUsd: cfg.entryUsd, capUsd: cfg.capUsd, rosterSize: cfg.rosterSize, rakeBps: cfg.rakeBps,
    minEntries: cfg.minEntries, windowHours: cfg.windowHours,
    closeAt: new Date(Date.now() + cfg.windowHours * 3_600_000).toISOString(),
  };
  await q.query(`INSERT INTO game_rounds(id, game_type, status, params) VALUES($1, 'card-fantasy', 'open', $2)`, [id, JSON.stringify(params)]);
  const r = await q.query<LeagueRow>(`SELECT ${LEAGUE_COLS} FROM game_rounds WHERE id = $1 FOR UPDATE`, [id]);
  return r.rows[0];
}

/** Score + settle a closed league: top score wins the pool−rake (ties split); below minEntries, refund all. */
async function settleLeague(q: Queryer, league: LeagueRow): Promise<{ winnerUserIds: string[]; prizeEach: bigint; topMarketId: string | null } | null> {
  const p = league.params;
  const entries = await q.query<{ id: string; user_id: string; result: EntryResult }>(`SELECT id, user_id, result FROM game_plays WHERE round_id = $1 ORDER BY id`, [league.id]);
  const ante = usdc(p.entryUsd);

  if (entries.rows.length < p.minEntries) {
    for (const e of [...entries.rows].sort((a, b) => (a.user_id < b.user_id ? -1 : 1))) await payFromPool(q, e.user_id, ante, 'GAME_FANTASY_REFUND', e.id);
    await q.query(`UPDATE game_rounds SET status = 'settled', resolved_at = now(), params = $2 WHERE id = $1`, [league.id, JSON.stringify({ ...p, refunded: true })]);
    return null;
  }

  const cardIds = [...new Set(entries.rows.flatMap((e) => e.result.roster.map((c) => c.marketId)))];
  const close = await marksAt(q, cardIds, p.closeAt);
  const scored = entries.rows.map((e) => ({ ...e, score: scoreRoster(e.result.roster, close) }));
  const maxScore = scored.reduce((m, e) => (e.score > m ? e.score : m), scored[0].score);
  const winners = scored.filter((e) => e.score === maxScore);
  const pool = ante * BigInt(entries.rows.length);
  const payout = pool - (pool * BigInt(p.rakeBps)) / 10_000n;
  const prizeEach = payout / BigInt(winners.length);

  // Freeze every entry's score + prize for the standings; pay winners in user order (deadlock-safe).
  for (const e of scored) {
    const won = winners.some((w) => w.id === e.id);
    await q.query(`UPDATE game_plays SET result = $1 WHERE id = $2`, [JSON.stringify({ ...e.result, scoreBps: e.score.toString(), prizeE6: won ? prizeEach.toString() : '0' }), e.id]);
  }
  for (const w of [...winners].sort((a, b) => (a.user_id < b.user_id ? -1 : 1))) await payFromPool(q, w.user_id, prizeEach, 'GAME_FANTASY_WIN', w.id);

  await q.query(`UPDATE game_rounds SET status = 'settled', resolved_at = now(), prize_uusdc = $2, params = $3 WHERE id = $1`, [league.id, payout.toString(), JSON.stringify({ ...p, winnerUserIds: winners.map((w) => w.user_id) })]);
  return { winnerUserIds: winners.map((w) => w.user_id), prizeEach, topMarketId: winners[0].result.roster[0]?.marketId ?? null };
}

/** Settle a league if it is open and its window has closed (locks it; no-op otherwise). Best-effort broadcast. */
async function settleIfDue(db: Db, leagueId: string): Promise<void> {
  const out = await db.tx(async (q) => {
    const r = await q.query<LeagueRow & { due: boolean }>(`SELECT ${LEAGUE_COLS}, (status = 'open' AND (params->>'closeAt')::timestamptz <= now()) AS due FROM game_rounds WHERE id = $1 FOR UPDATE`, [leagueId]);
    if (!r.rows[0] || !r.rows[0].due) return null;
    return settleLeague(q, r.rows[0]);
  });
  if (out && out.winnerUserIds.length) await broadcastLeague(db, out).catch(() => {});
}

async function broadcastLeague(db: Db, res: { winnerUserIds: string[]; prizeEach: bigint; topMarketId: string | null }): Promise<void> {
  const cfg = cardFantasyConfig();
  for (const uid of res.winnerUserIds) {
    const u = await db.query<{ dn: string | null; pk: string }>(`SELECT display_name AS dn, solana_pubkey AS pk FROM users WHERE id = $1`, [uid]);
    const handle = u.rows[0] ? handleFor(u.rows[0].dn, u.rows[0].pk) : 'someone';
    publish('games', 'play', { id: randomUUID(), game: 'card-fantasy', handle, marketId: res.topMarketId, displayName: 'Card Fantasy', imageSmall: null, valueE6: res.prizeEach.toString(), at: new Date().toISOString() });
    if (res.topMarketId && res.prizeEach >= usdc(cfg.bigWinUsd)) await emitGameWinEvent(db, { userId: uid, marketId: res.topMarketId, payoutE6: res.prizeEach, game: 'Card Fantasy' }).catch(() => {});
  }
}

/** The open (joinable) league + the caller's entry + the live leaderboard, or null if none is open. */
export async function currentLeague(db: Db, userId: string): Promise<LeagueView | null> {
  requireOn();
  const open = await db.query<{ id: string }>(`SELECT id FROM game_rounds WHERE game_type = 'card-fantasy' AND status = 'open' ORDER BY started_at DESC LIMIT 1`, []);
  if (!open.rows[0]) return null;
  await settleIfDue(db, open.rows[0].id); // settle it if its window already closed (a new entry then opens the next)
  const r = await db.query<LeagueRow>(`SELECT ${LEAGUE_COLS} FROM game_rounds WHERE id = $1`, [open.rows[0].id]);
  if (!r.rows[0] || r.rows[0].status !== 'open') return null;
  return buildLeagueView(db, r.rows[0], userId);
}

/** A specific league (open or settled) + the caller's entry + standings — for polling a result. */
export async function getLeague(db: Db, userId: string, leagueId: string): Promise<LeagueView | null> {
  await settleIfDue(db, leagueId).catch(() => {});
  const r = await db.query<LeagueRow>(`SELECT ${LEAGUE_COLS} FROM game_rounds WHERE id = $1 AND game_type = 'card-fantasy'`, [leagueId]);
  if (!r.rows[0]) return null;
  return buildLeagueView(db, r.rows[0], userId);
}

/** Enter the open league with a roster (creating/rolling the league if needed), under the salary cap. */
export async function enterFantasy(db: Db, userId: string, marketIds: string[], idempotencyKey: string): Promise<LeagueView> {
  const cfg = requireOn();
  if (new Set(marketIds).size !== marketIds.length) throw new HttpError(400, 'your roster cards must be distinct');

  // Settle an already-closed open league in its OWN tx first (decoupled from this entry, so a failed entry
  // can never roll back a prior league's payouts), which lets a fresh league open inside the entry tx.
  const openRow = await db.query<{ id: string; params: LeagueParams }>(`SELECT id, params FROM game_rounds WHERE game_type = 'card-fantasy' AND status = 'open' ORDER BY started_at DESC LIMIT 1`, []);
  if (openRow.rows[0] && new Date(openRow.rows[0].params.closeAt).getTime() <= Date.now()) await settleIfDue(db, openRow.rows[0].id).catch(() => {});

  const leagueId = await db.tx(async (q): Promise<string> => {
    // Idempotency replay BEFORE locking/creating a league — a retry returns the existing entry, not a 409.
    const prior = await q.query<{ round_id: string }>(`SELECT round_id FROM game_plays WHERE user_id = $1 AND idempotency_key = $2 AND game_type = 'card-fantasy'`, [userId, idempotencyKey]);
    if (prior.rows[0]) return prior.rows[0].round_id;

    const r = await q.query<LeagueRow>(`SELECT ${LEAGUE_COLS} FROM game_rounds WHERE game_type = 'card-fantasy' AND status = 'open' ORDER BY started_at DESC LIMIT 1 FOR UPDATE`, []);
    let league: LeagueRow | null = r.rows[0] ?? null;
    // Raced the close (the pre-step above didn't catch it): bounce the retry, which settles + opens fresh.
    if (league && new Date(league.params.closeAt).getTime() <= Date.now()) throw new HttpError(409, 'this league just closed — try again');
    league = league ?? (await createLeague(q, cfg));
    // Validate the submission against the LEAGUE's snapshot (not the live knob, which an admin may have changed).
    if (marketIds.length !== league.params.rosterSize) throw new HttpError(400, `your roster must have exactly ${league.params.rosterSize} cards`);

    // One roster per user per league (also backstopped by uq_fantasy_one_entry).
    const dup = await q.query(`SELECT 1 FROM game_plays WHERE round_id = $1 AND user_id = $2`, [league.id, userId]);
    if (dup.rows[0]) throw new HttpError(409, 'you have already entered this league');

    const roster: FantasyCard[] = [];
    let total = 0n;
    for (const mid of marketIds) {
      const c = await validCard(q, mid);
      if (!c) throw new HttpError(400, 'every roster pick must be a live featured card');
      roster.push(c);
      total += BigInt(c.entryE6);
    }
    if (total > usdc(league.params.capUsd)) throw new HttpError(400, 'your roster is over the salary cap');

    const playId = randomUUID();
    const entry = usdc(league.params.entryUsd);
    const ins = await q.query<{ id: string }>(
      `INSERT INTO game_plays(id, game_type, round_id, user_id, idempotency_key, wager_uusdc, result)
       VALUES($1, 'card-fantasy', $2, $3, $4, $5, $6) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [playId, league.id, userId, idempotencyKey, entry.toString(), JSON.stringify({ roster })],
    );
    if (!ins.rows[0]) {
      const ex = await q.query<{ round_id: string }>(`SELECT round_id FROM game_plays WHERE user_id = $1 AND idempotency_key = $2`, [userId, idempotencyKey]);
      return ex.rows[0].round_id;
    }

    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    await assertSpendableExcludingBonus(q, userId, entry); // bonus is perp-only — can't be wagered in games
    const pool = await getOrCreateSystemAccount(q, 'GAME_POOL');
    await postTxn(q, { reason: 'GAME_WAGER', refType: 'card_fantasy', refId: playId, entries: [{ accountId: coll, amount: -entry }, { accountId: pool, amount: entry }] });
    return league.id;
  });

  const v = await getLeague(db, userId, leagueId);
  return v!;
}

/** Worker pass: settle every league whose window has closed (single-leader via lease in index.ts). */
export async function settleExpiredLeagues(db: Db): Promise<number> {
  const due = await db.query<{ id: string }>(`SELECT id FROM game_rounds WHERE game_type = 'card-fantasy' AND status = 'open' AND (params->>'closeAt')::timestamptz <= now()`, []);
  for (const d of due.rows) await settleIfDue(db, d.id).catch(() => {});
  return due.rows.length;
}
