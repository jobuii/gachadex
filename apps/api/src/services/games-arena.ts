import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { usdc } from '../money.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, postTxn } from './ledger.ts';
import { handleFor } from './handles.ts';
import { publish } from './bus.ts';
import { emitGameWinEvent } from './chat.ts';
import { commitServerSeed, fairShuffle } from './game-fairness.ts';
import { draftArenaConfig, type DraftArenaConfig } from './game-config.ts';

/**
 * Draft Arena (docs/games-spec.md, game #7). A PvP snake draft: players join a lobby, pay an entry, and
 * submit a ranked wishlist over a shared, EXCLUSIVE pool of the top featured cards. On fill the seats are
 * fair-shuffled from a committed server seed and a snake auto-draft assigns each player, in turn, their
 * best still-available wishlist card (or the best remaining card if their list runs dry) — a card taken by
 * one is gone for everyone. The rosters then battle on the SUM of their cards' oracle %-moves over a window;
 * top score takes the pot minus a rake (ties split). An unfilled lobby refunds after lobbyTimeoutHours.
 *
 * Reuses The Break's committed-seed + fairShuffle (provably-fair seating) and Card Fantasy's %-move battle
 * scoring + timed settlement (settle-on-read + the lease-guarded sweep worker). One open lobby at a time
 * (uq_open_round_per_game); one seat per user (uq_arena_one_entry). Flag-gated OFF by default.
 */

const GAMES_OFF = () => new HttpError(403, 'games are not enabled', 'games_disabled');
function requireOn(): DraftArenaConfig {
  if (!config.gamesEnabled) throw GAMES_OFF();
  const cfg = draftArenaConfig();
  if (!cfg.enabled) throw GAMES_OFF();
  return cfg;
}

interface PoolCard { marketId: string; symbol: string; displayName: string; imageSmall: string | null; valueE6: string }
interface ArenaParams {
  entryUsd: number;
  spots: number;
  rosterSize: number;
  rakeBps: number;
  windowHours: number;
  lobbyTimeoutHours: number;
  clientSeed: string;
  pool: PoolCard[];
  filled: number;
  lobbyDeadline: string;
  // after fill:
  seats?: string[]; // draft order: seats[i] = userId picking at seat i
  closeAt?: string;
  // settled:
  winnerUserIds?: string[];
  revealedServerSeed?: string;
}
interface EntryResult { wishlist: string[]; seat?: number; roster?: PoolCard[]; scoreBps?: string; prizeE6?: string }
interface RoundRow { id: string; status: string; server_seed: string; server_seed_hash: string; params: ArenaParams }
const ROUND_COLS = `id, status, server_seed, server_seed_hash, params`;

/** Snake seat to pick at `pickIndex`: rounds alternate direction (0..n-1, then n-1..0, …). */
function snakeSeat(pickIndex: number, spots: number): number {
  const round = Math.floor(pickIndex / spots);
  const pos = pickIndex % spots;
  return round % 2 === 0 ? pos : spots - 1 - pos;
}

/** Run the snake auto-draft: each seat, in snake order, takes its best still-available wishlist card. */
function runDraft(seats: string[], wishByUser: Map<string, string[]>, pool: PoolCard[], rosterSize: number): Map<string, PoolCard[]> {
  const byId = new Map(pool.map((c) => [c.marketId, c]));
  const byValue = [...pool].sort((a, b) => (BigInt(b.valueE6) > BigInt(a.valueE6) ? 1 : -1)); // fallback order
  const drafted = new Set<string>();
  const rosters = new Map<string, PoolCard[]>(seats.map((u) => [u, []]));
  for (let pick = 0; pick < seats.length * rosterSize; pick++) {
    const uid = seats[snakeSeat(pick, seats.length)];
    const wish = wishByUser.get(uid) ?? [];
    let mid = wish.find((m) => !drafted.has(m) && byId.has(m));
    if (!mid) mid = byValue.find((c) => !drafted.has(c.marketId))!.marketId;
    drafted.add(mid);
    rosters.get(uid)!.push(byId.get(mid)!);
  }
  return rosters;
}

/** Sum of the roster's per-card %-moves, in bps, from each card's draft-snapshot value to the close marks. */
function scoreRoster(roster: PoolCard[], close: Map<string, bigint>): bigint {
  let s = 0n;
  for (const c of roster) {
    const start = BigInt(c.valueE6);
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

/** Snapshot the shared draft pool = the top `poolSize` featured cards by current mark. */
async function snapshotPool(q: Queryer, poolSize: number): Promise<PoolCard[]> {
  const r = await q.query<{ id: string; symbol: string; display_name: string; image_small: string | null; mark: string }>(
    `SELECT s.id, s.symbol, s.display_name, s.image_small, s.mark::text AS mark FROM (
       SELECT m.id, m.symbol, m.display_name, m.image_small,
              (SELECT mark_price_e6 FROM marks WHERE market_id = m.id ORDER BY computed_at DESC, id DESC LIMIT 1) AS mark
         FROM markets m WHERE m.featured AND m.kind = 'card' AND m.status = 'active'
     ) s WHERE s.mark IS NOT NULL ORDER BY s.mark DESC LIMIT $1`,
    [poolSize],
  );
  return r.rows.map((x) => ({ marketId: x.id, symbol: x.symbol, displayName: x.display_name, imageSmall: x.image_small, valueE6: x.mark }));
}

/** Move USDC out of GAME_POOL to a user (prize / refund), collateral-then-pool lock order + solvency check. */
async function payFromPool(q: Queryer, userId: string, amount: bigint, reason: string, refId: string): Promise<void> {
  if (amount <= 0n) return;
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  await q.query(`SELECT 1 FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
  const pool = await getOrCreateSystemAccount(q, 'GAME_POOL');
  const pl = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [pool]);
  if ((pl.rows[0] ? BigInt(pl.rows[0].amount_uusdc) : 0n) < amount) throw new HttpError(503, 'GAME_POOL has insufficient funds — top it up');
  await postTxn(q, { reason, refType: 'draft_arena', refId, entries: [{ accountId: coll, amount }, { accountId: pool, amount: -amount }] });
}

export interface ArenaView {
  roundId: string;
  status: string; // open | battle | settled | cancelled
  entryUsd: number;
  spots: number;
  rosterSize: number;
  rakeBps: number;
  windowHours: number;
  filled: number;
  closeAt: string | null;
  pool: PoolCard[];
  prizePoolE6: string;
  yourEntry: { wishlist: string[]; seat: number | null; roster: (PoolCard & { currentE6: string; moveBps: number })[]; scoreBps: string | null; prizeE6: string | null } | null;
  standings: { handle: string; seat: number | null; scoreBps: string; isYou: boolean }[];
  fairness: { serverSeedHash: string; clientSeed: string; serverSeed: string | null };
}

async function buildView(q: Queryer, round: RoundRow, userId: string): Promise<ArenaView> {
  const p = round.params;
  const settled = round.status === 'settled';
  const entries = await q.query<{ id: string; user_id: string; result: EntryResult }>(`SELECT id, user_id, result FROM game_plays WHERE round_id = $1`, [round.id]);
  const drafted = round.status === 'battle' || settled;
  const cardIds = drafted ? [...new Set(entries.rows.flatMap((e) => e.result.roster?.map((c) => c.marketId) ?? []))] : [];
  const marks = settled ? new Map<string, bigint>() : await marksNow(q, cardIds);
  const score = (e: { result: EntryResult }) => (settled && e.result.scoreBps != null ? BigInt(e.result.scoreBps) : scoreRoster(e.result.roster ?? [], marks));

  const pool = usdc(p.entryUsd) * BigInt(entries.rows.length);
  const handleRows = await q.query<{ id: string; dn: string | null; pk: string }>(`SELECT id, display_name AS dn, solana_pubkey AS pk FROM users WHERE id = ANY($1)`, [entries.rows.map((e) => e.user_id)]);
  const handles = new Map(handleRows.rows.map((u) => [u.id, handleFor(u.dn, u.pk)]));

  const board = entries.rows
    .map((e) => ({ userId: e.user_id, seat: e.result.seat ?? null, score: drafted ? score(e) : 0n }))
    .sort((a, b) => (b.score > a.score ? 1 : b.score < a.score ? -1 : (a.seat ?? 0) - (b.seat ?? 0)));

  const mine = entries.rows.find((e) => e.user_id === userId) ?? null;
  return {
    roundId: round.id,
    status: round.status,
    entryUsd: p.entryUsd,
    spots: p.spots,
    rosterSize: p.rosterSize,
    rakeBps: p.rakeBps,
    windowHours: p.windowHours,
    filled: p.filled,
    closeAt: p.closeAt ?? null,
    pool: p.pool,
    prizePoolE6: (pool - (pool * BigInt(p.rakeBps)) / 10_000n).toString(),
    yourEntry: mine
      ? {
          wishlist: mine.result.wishlist,
          seat: mine.result.seat ?? null,
          roster: (mine.result.roster ?? []).map((c) => {
            const cur = (settled ? null : marks.get(c.marketId)) ?? BigInt(c.valueE6);
            const start = BigInt(c.valueE6);
            return { ...c, currentE6: cur.toString(), moveBps: start > 0n ? Number(((cur - start) * 10_000n) / start) : 0 };
          }),
          scoreBps: drafted ? score(mine).toString() : null,
          prizeE6: settled ? mine.result.prizeE6 ?? '0' : null,
        }
      : null,
    standings: board.map((b) => ({ handle: handles.get(b.userId) ?? 'someone', seat: b.seat, scoreBps: b.score.toString(), isYou: b.userId === userId })),
    fairness: { serverSeedHash: round.server_seed_hash, clientSeed: p.clientSeed, serverSeed: p.revealedServerSeed ?? null },
  };
}

/** Open a fresh lobby: commit a server seed, snapshot the draft pool, set the fill timeout. */
async function createLobby(q: Queryer, cfg: DraftArenaConfig): Promise<RoundRow> {
  const pool = await snapshotPool(q, cfg.poolSize);
  if (pool.length < cfg.spots * cfg.rosterSize) throw new HttpError(503, 'not enough priced featured cards to fill a draft right now');
  const id = randomUUID();
  const { serverSeed, serverSeedHash } = commitServerSeed();
  const params: ArenaParams = {
    entryUsd: cfg.entryUsd, spots: cfg.spots, rosterSize: cfg.rosterSize, rakeBps: cfg.rakeBps,
    windowHours: cfg.windowHours, lobbyTimeoutHours: cfg.lobbyTimeoutHours, clientSeed: id, pool, filled: 0,
    lobbyDeadline: new Date(Date.now() + cfg.lobbyTimeoutHours * 3_600_000).toISOString(),
  };
  await q.query(`INSERT INTO game_rounds(id, game_type, status, server_seed, server_seed_hash, params) VALUES($1, 'draft-arena', 'open', $2, $3, $4)`, [id, serverSeed, serverSeedHash, JSON.stringify(params)]);
  const r = await q.query<RoundRow>(`SELECT ${ROUND_COLS} FROM game_rounds WHERE id = $1 FOR UPDATE`, [id]);
  return r.rows[0];
}

/** Join the open lobby with a ranked wishlist; on fill, fair-shuffle seats and run the snake draft. */
export async function joinArena(db: Db, userId: string, wishlist: string[], idempotencyKey: string): Promise<ArenaView> {
  const cfg = requireOn();
  if (new Set(wishlist).size !== wishlist.length) throw new HttpError(400, 'your wishlist cards must be distinct');

  const roundId = await db.tx(async (q): Promise<string> => {
    // Idempotency replay BEFORE creating a lobby — a retry returns the existing entry, not a 409.
    const prior = await q.query<{ round_id: string }>(`SELECT round_id FROM game_plays WHERE user_id = $1 AND idempotency_key = $2 AND game_type = 'draft-arena'`, [userId, idempotencyKey]);
    if (prior.rows[0]) return prior.rows[0].round_id;

    const r = await q.query<RoundRow>(`SELECT ${ROUND_COLS} FROM game_rounds WHERE game_type = 'draft-arena' AND status = 'open' ORDER BY started_at DESC LIMIT 1 FOR UPDATE`, []);
    const round = r.rows[0] ?? (await createLobby(q, cfg));
    const p = round.params;
    if (wishlist.length < p.rosterSize) throw new HttpError(400, `your wishlist needs at least ${p.rosterSize} cards`);

    // One seat per user per lobby (also backstopped by uq_arena_one_entry).
    const dup = await q.query(`SELECT 1 FROM game_plays WHERE round_id = $1 AND user_id = $2`, [round.id, userId]);
    if (dup.rows[0]) throw new HttpError(409, 'you have already joined this lobby');

    const poolIds = new Set(p.pool.map((c) => c.marketId));
    for (const m of wishlist) if (!poolIds.has(m)) throw new HttpError(400, 'every wishlist pick must be in the draft pool');

    const playId = randomUUID();
    const entry = usdc(p.entryUsd);
    const ins = await q.query<{ id: string }>(
      `INSERT INTO game_plays(id, game_type, round_id, user_id, idempotency_key, wager_uusdc, result)
       VALUES($1, 'draft-arena', $2, $3, $4, $5, $6) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [playId, round.id, userId, idempotencyKey, entry.toString(), JSON.stringify({ wishlist } satisfies EntryResult)],
    );
    if (!ins.rows[0]) {
      const ex = await q.query<{ round_id: string }>(`SELECT round_id FROM game_plays WHERE user_id = $1 AND idempotency_key = $2 AND game_type = 'draft-arena'`, [userId, idempotencyKey]);
      if (!ex.rows[0]) throw new HttpError(409, 'that idempotency key was already used');
      return ex.rows[0].round_id;
    }

    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const lock = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
    if ((lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n) < entry) throw new HttpError(400, 'insufficient balance', 'insufficient_balance');
    const poolAcct = await getOrCreateSystemAccount(q, 'GAME_POOL');
    await postTxn(q, { reason: 'GAME_WAGER', refType: 'draft_arena', refId: playId, entries: [{ accountId: coll, amount: -entry }, { accountId: poolAcct, amount: entry }] });

    const filled = p.filled + 1;
    if (filled < p.spots) {
      await q.query(`UPDATE game_rounds SET params = $2 WHERE id = $1`, [round.id, JSON.stringify({ ...p, filled })]);
      return round.id;
    }

    // Lobby full → fair-shuffle the seats and run the snake auto-draft, then open the battle window.
    const joiners = await q.query<{ id: string; user_id: string; result: EntryResult }>(`SELECT id, user_id, result FROM game_plays WHERE round_id = $1 ORDER BY id`, [round.id]);
    const order = fairShuffle(round.server_seed, p.clientSeed, 0, joiners.rows.length, 0);
    const seats = order.map((i) => joiners.rows[i].user_id);
    const wishByUser = new Map(joiners.rows.map((j) => [j.user_id, j.result.wishlist]));
    const rosters = runDraft(seats, wishByUser, p.pool, p.rosterSize);
    for (const j of joiners.rows) {
      await q.query(`UPDATE game_plays SET result = $1 WHERE id = $2`, [JSON.stringify({ ...j.result, seat: seats.indexOf(j.user_id), roster: rosters.get(j.user_id) }), j.id]);
    }
    await q.query(`UPDATE game_rounds SET status = 'battle', params = $2 WHERE id = $1`, [round.id, JSON.stringify({ ...p, filled, seats, closeAt: new Date(Date.now() + p.windowHours * 3_600_000).toISOString() })]);
    return round.id;
  });

  const v = await getArena(db, userId, roundId);
  return v!;
}

/** Score a finished battle: top roster %-move takes the pot minus rake (ties split). Reveals the seed. */
async function settleArena(q: Queryer, round: RoundRow): Promise<{ winnerUserIds: string[]; prizeEach: bigint; topMarketId: string | null } | null> {
  const p = round.params;
  const entries = await q.query<{ id: string; user_id: string; result: EntryResult }>(`SELECT id, user_id, result FROM game_plays WHERE round_id = $1 ORDER BY id`, [round.id]);
  const cardIds = [...new Set(entries.rows.flatMap((e) => e.result.roster?.map((c) => c.marketId) ?? []))];
  const close = await marksAt(q, cardIds, p.closeAt!);
  const scored = entries.rows.map((e) => ({ ...e, score: scoreRoster(e.result.roster ?? [], close) }));
  // Defensive: a battle round always has `spots` players, but never divide-by-zero / crash on an empty one.
  if (scored.length === 0) {
    await q.query(`UPDATE game_rounds SET status = 'settled', resolved_at = now(), params = $2 WHERE id = $1`, [round.id, JSON.stringify({ ...p, winnerUserIds: [], revealedServerSeed: round.server_seed })]);
    return null;
  }
  const maxScore = scored.reduce((m, e) => (e.score > m ? e.score : m), scored[0].score);
  const winners = scored.filter((e) => e.score === maxScore);
  const total = usdc(p.entryUsd) * BigInt(entries.rows.length);
  const payout = total - (total * BigInt(p.rakeBps)) / 10_000n;
  const prizeEach = payout / BigInt(winners.length);

  for (const e of scored) {
    const won = winners.some((w) => w.id === e.id);
    await q.query(`UPDATE game_plays SET result = $1 WHERE id = $2`, [JSON.stringify({ ...e.result, scoreBps: e.score.toString(), prizeE6: won ? prizeEach.toString() : '0' }), e.id]);
  }
  for (const w of [...winners].sort((a, b) => (a.user_id < b.user_id ? -1 : 1))) await payFromPool(q, w.user_id, prizeEach, 'GAME_ARENA_WIN', w.id);

  await q.query(`UPDATE game_rounds SET status = 'settled', resolved_at = now(), pot_uusdc = $2, prize_uusdc = $3, params = $4 WHERE id = $1`, [round.id, total.toString(), payout.toString(), JSON.stringify({ ...p, winnerUserIds: winners.map((w) => w.user_id), revealedServerSeed: round.server_seed })]);
  return { winnerUserIds: winners.map((w) => w.user_id), prizeEach, topMarketId: winners[0].result.roster?.[0]?.marketId ?? null };
}

/** Settle a battle whose window has closed (locks it; no-op otherwise). Best-effort broadcast. */
async function settleIfDue(db: Db, roundId: string): Promise<void> {
  const out = await db.tx(async (q) => {
    const r = await q.query<RoundRow & { due: boolean }>(`SELECT ${ROUND_COLS}, (status = 'battle' AND (params->>'closeAt')::timestamptz <= now()) AS due FROM game_rounds WHERE id = $1 FOR UPDATE`, [roundId]);
    if (!r.rows[0] || !r.rows[0].due) return null;
    return settleArena(q, r.rows[0]);
  });
  if (out && out.winnerUserIds.length) await broadcastArena(db, out).catch(() => {});
}

async function broadcastArena(db: Db, res: { winnerUserIds: string[]; prizeEach: bigint; topMarketId: string | null }): Promise<void> {
  const cfg = draftArenaConfig();
  for (const uid of res.winnerUserIds) {
    const u = await db.query<{ dn: string | null; pk: string }>(`SELECT display_name AS dn, solana_pubkey AS pk FROM users WHERE id = $1`, [uid]);
    const handle = u.rows[0] ? handleFor(u.rows[0].dn, u.rows[0].pk) : 'someone';
    publish('games', 'play', { id: randomUUID(), game: 'draft-arena', handle, marketId: res.topMarketId, displayName: 'Draft Arena', imageSmall: null, valueE6: res.prizeEach.toString(), at: new Date().toISOString() });
    if (res.topMarketId && res.prizeEach >= usdc(cfg.bigWinUsd)) await emitGameWinEvent(db, { userId: uid, marketId: res.topMarketId, payoutE6: res.prizeEach, game: 'Draft Arena' }).catch(() => {});
  }
}

/** The open (joinable) lobby + the caller's entry. With no lobby open, a PREVIEW (roundId '') carrying the
 *  current draft pool, so the client can build a wishlist — the first join then opens the real lobby. */
export async function currentArena(db: Db, userId: string): Promise<ArenaView | null> {
  const cfg = requireOn();
  const open = await db.query<{ id: string }>(`SELECT id FROM game_rounds WHERE game_type = 'draft-arena' AND status = 'open' ORDER BY started_at DESC LIMIT 1`, []);
  if (open.rows[0]) {
    const r = await db.query<RoundRow>(`SELECT ${ROUND_COLS} FROM game_rounds WHERE id = $1`, [open.rows[0].id]);
    return buildView(db, r.rows[0], userId);
  }
  const pool = await snapshotPool(db, cfg.poolSize);
  return {
    roundId: '', status: 'open', entryUsd: cfg.entryUsd, spots: cfg.spots, rosterSize: cfg.rosterSize,
    rakeBps: cfg.rakeBps, windowHours: cfg.windowHours, filled: 0, closeAt: null, pool,
    prizePoolE6: '0', yourEntry: null, standings: [],
    fairness: { serverSeedHash: '', clientSeed: '', serverSeed: null },
  };
}

/** A specific arena (lobby / battle / settled) for polling — settles it first if its battle has closed. */
export async function getArena(db: Db, userId: string, roundId: string): Promise<ArenaView | null> {
  await settleIfDue(db, roundId).catch(() => {});
  const r = await db.query<RoundRow>(`SELECT ${ROUND_COLS} FROM game_rounds WHERE id = $1 AND game_type = 'draft-arena'`, [roundId]);
  if (!r.rows[0]) return null;
  return buildView(db, r.rows[0], userId);
}

/** Refund + cancel an unfilled lobby (admin, or the worker once it times out). */
export async function cancelArena(db: Db, roundId: string): Promise<{ roundId: string; refunded: number }> {
  return db.tx(async (q) => {
    const r = await q.query<RoundRow>(`SELECT ${ROUND_COLS} FROM game_rounds WHERE id = $1 AND game_type = 'draft-arena' FOR UPDATE`, [roundId]);
    if (!r.rows[0]) throw new HttpError(404, 'arena not found');
    if (r.rows[0].status !== 'open') throw new HttpError(409, 'only an unfilled lobby can be cancelled');
    const entry = usdc(r.rows[0].params.entryUsd);
    const players = await q.query<{ id: string; user_id: string }>(`SELECT id, user_id FROM game_plays WHERE round_id = $1 ORDER BY user_id`, [roundId]);
    for (const pl of players.rows) await payFromPool(q, pl.user_id, entry, 'GAME_ARENA_REFUND', pl.id);
    await q.query(`UPDATE game_rounds SET status = 'cancelled', resolved_at = now() WHERE id = $1`, [roundId]);
    return { roundId, refunded: players.rows.length };
  });
}

/** Worker pass: settle every battle whose window has closed, and refund every lobby past its fill timeout. */
export async function settleExpiredArenas(db: Db): Promise<number> {
  const due = await db.query<{ id: string }>(`SELECT id FROM game_rounds WHERE game_type = 'draft-arena' AND status = 'battle' AND (params->>'closeAt')::timestamptz <= now()`, []);
  for (const d of due.rows) await settleIfDue(db, d.id).catch(() => {});
  const stale = await db.query<{ id: string }>(`SELECT id FROM game_rounds WHERE game_type = 'draft-arena' AND status = 'open' AND (params->>'lobbyDeadline')::timestamptz <= now()`, []);
  for (const s of stale.rows) await cancelArena(db, s.id).catch(() => {});
  return due.rows.length + stale.rows.length;
}
