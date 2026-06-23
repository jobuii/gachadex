import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { usdc } from '../money.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, postTxn } from './ledger.ts';
import { handleFor } from './handles.ts';
import { publish } from './bus.ts';
import { emitGameWinEvent } from './chat.ts';
import { priceDuelConfig, type PriceDuelConfig } from './game-config.ts';

/**
 * Price Duel (docs/games-spec.md, game #5). A 1v1 PvP, skill-framed: both players ante and pick a featured
 * card; over a fixed window the card with the higher oracle %-move wins the POT (both antes minus a rake =
 * the house edge), a tie refunds both. Quick-match: a join either matches the one open duel (locking both
 * picks + starting the window) or opens a new one. Picks stay hidden from a would-be opponent until they
 * commit their own (the open duel only reveals the creator's card to the creator), so neither can copy.
 *
 * Settlement is time-based: settle-on-read (a participant polling an expired duel settles it inline) +
 * a lease-driven sweep worker (startDuelLoop in index.ts) so escrow always releases even if nobody returns.
 * Money: each ante moves USER_COLLATERAL → GAME_POOL at join; settle pays the winner pot−rake (rake stays
 * in the pool = house) or refunds both on a tie. No card prize; the rake IS the edge (no pool-dependence).
 * Flag-gated OFF by default. One open duel at a time (uq_open_round_per_game).
 */

const GAMES_OFF = () => new HttpError(403, 'games are not enabled', 'games_disabled');
function requireOn(): PriceDuelConfig {
  if (!config.gamesEnabled) throw GAMES_OFF();
  const cfg = priceDuelConfig();
  if (!cfg.enabled) throw GAMES_OFF();
  return cfg;
}

interface DuelCard { marketId: string; symbol: string; displayName: string; imageSmall: string | null }
interface DuelParams {
  anteUsd: number;
  windowHours: number;
  rakeBps: number;
  creatorUserId: string;
  creatorMarketId: string;
  creatorCard: DuelCard;
  opponentUserId?: string;
  opponentMarketId?: string;
  opponentCard?: DuelCard;
  startAt?: string;
  closeAt?: string;
  creatorStartE6?: string;
  opponentStartE6?: string;
  // settled:
  winner?: 'creator' | 'opponent' | 'tie';
  winnerUserId?: string | null;
  creatorCloseE6?: string;
  opponentCloseE6?: string;
}
interface DuelRow { id: string; status: string; params: DuelParams }
const DUEL_COLS = `id, status, params`;

export interface DuelView {
  duelId: string;
  status: string; // open | active | settled | cancelled
  anteUsd: number;
  windowHours: number;
  rakeBps: number;
  role: 'creator' | 'opponent' | null; // the viewer's side
  closeAt: string | null;
  yourCard: DuelCard | null;
  oppCard: DuelCard | null; // null while still hidden (open, viewer = creator)
  result?: { winner: 'creator' | 'opponent' | 'tie'; youWon: boolean; potE6: string; payoutE6: string };
}

/** Current mark of a market in micro-USD, or null if it has never priced. */
async function markE6(q: Queryer, marketId: string): Promise<bigint | null> {
  const r = await q.query<{ m: string }>(`SELECT mark_price_e6::text AS m FROM marks WHERE market_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`, [marketId]);
  return r.rows[0] ? BigInt(r.rows[0].m) : null;
}

/** A pickable card = a featured, active card market that currently has a mark (so the duel can settle). */
async function validPick(q: Queryer, marketId: string): Promise<DuelCard | null> {
  const r = await q.query<{ id: string; symbol: string; display_name: string; image_small: string | null; mark: string | null }>(
    `SELECT m.id, m.symbol, m.display_name, m.image_small,
            (SELECT mark_price_e6::text FROM marks WHERE market_id = m.id ORDER BY computed_at DESC, id DESC LIMIT 1) AS mark
       FROM markets m WHERE m.id = $1 AND m.featured AND m.kind = 'card' AND m.status = 'active'`,
    [marketId],
  );
  const x = r.rows[0];
  if (!x || x.mark == null) return null;
  return { marketId: x.id, symbol: x.symbol, displayName: x.display_name, imageSmall: x.image_small };
}

function buildView(duel: DuelRow, userId: string): DuelView {
  const p = duel.params;
  const role: DuelView['role'] = p.creatorUserId === userId ? 'creator' : p.opponentUserId === userId ? 'opponent' : null;
  // A participant sees the other pick once matched (active/settled). A NON-participant only sees picks
  // after the duel has SETTLED — never during the live window (anti-copy + no mid-duel manipulation signal).
  const revealOpp = role ? duel.status !== 'open' : duel.status === 'settled';
  const yourCard = role === 'creator' ? p.creatorCard : role === 'opponent' ? (p.opponentCard ?? null) : null;
  const oppCard = role === 'creator' ? (revealOpp ? p.opponentCard ?? null : null)
    : role === 'opponent' ? p.creatorCard
    : revealOpp ? p.creatorCard : null;
  const view: DuelView = {
    duelId: duel.id,
    status: duel.status,
    anteUsd: p.anteUsd,
    windowHours: p.windowHours,
    rakeBps: p.rakeBps,
    role,
    closeAt: p.closeAt ?? null,
    yourCard,
    oppCard,
  };
  if (duel.status === 'settled' && p.winner) {
    const pot = usdc(p.anteUsd) * 2n;
    const payout = p.winner === 'tie' ? usdc(p.anteUsd) : (pot - (pot * BigInt(p.rakeBps)) / 10_000n);
    view.result = { winner: p.winner, youWon: !!role && p.winnerUserId === userId, potE6: pot.toString(), payoutE6: payout.toString() };
  }
  return view;
}

/** Move an ante from the player's collateral into GAME_POOL (the duel escrow). */
async function chargeAnte(q: Queryer, userId: string, ante: bigint, refId: string): Promise<void> {
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  const lock = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
  if ((lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n) < ante) throw new HttpError(400, 'insufficient balance', 'insufficient_balance');
  const pool = await getOrCreateSystemAccount(q, 'GAME_POOL');
  await postTxn(q, { reason: 'GAME_WAGER', refType: 'price_duel', refId, entries: [{ accountId: coll, amount: -ante }, { accountId: pool, amount: ante }] });
}

/** Pay USDC out of GAME_POOL to a user (winner payout / tie refund), collateral-then-pool lock order. */
async function payFromPool(q: Queryer, userId: string, amount: bigint, reason: string, refId: string): Promise<void> {
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  await q.query(`SELECT 1 FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
  const pool = await getOrCreateSystemAccount(q, 'GAME_POOL');
  const pl = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [pool]);
  if ((pl.rows[0] ? BigInt(pl.rows[0].amount_uusdc) : 0n) < amount) throw new HttpError(503, 'GAME_POOL has insufficient funds — top it up');
  await postTxn(q, { reason, refType: 'price_duel', refId, entries: [{ accountId: coll, amount }, { accountId: pool, amount: -amount }] });
}

/** Quick-match: ante + pick a card. Joins the open duel (locking both picks, starting the window) or opens one. */
export async function joinOrCreateDuel(db: Db, userId: string, marketId: string, idempotencyKey: string): Promise<DuelView> {
  const cfg = requireOn();

  const roundId = await db.tx(async (q): Promise<string> => {
    const pick = await validPick(q, marketId);
    if (!pick) throw new HttpError(400, 'pick a live featured card to duel with');

    const r = await q.query<DuelRow>(`SELECT ${DUEL_COLS} FROM game_rounds WHERE game_type = 'price-duel' AND status = 'open' ORDER BY started_at LIMIT 1 FOR UPDATE`, []);
    const open = r.rows[0] ?? null;
    // The viewer already has the open (unmatched) duel waiting — return it without a second entry.
    if (open && open.params.creatorUserId === userId) return open.id;

    // Anchor the entry idempotently BEFORE creating a duel (so a replay can't spawn an orphan open duel).
    const playId = randomUUID();
    const ante = usdc(open ? open.params.anteUsd : cfg.anteUsd);
    const ins = await q.query<{ id: string }>(
      `INSERT INTO game_plays(id, game_type, round_id, user_id, idempotency_key, wager_uusdc, result)
       VALUES($1, 'price-duel', $2, $3, $4, $5, $6) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [playId, open?.id ?? null, userId, idempotencyKey, ante.toString(), JSON.stringify({ marketId, role: open ? 'opponent' : 'creator' })],
    );
    if (!ins.rows[0]) {
      // Replay: filter by game_type (the (user, key) index is shared) so a cross-game key collision returns
      // a clean 409 instead of a foreign round_id that would dereference to null below.
      const ex = await q.query<{ round_id: string }>(`SELECT round_id FROM game_plays WHERE user_id = $1 AND idempotency_key = $2 AND game_type = 'price-duel'`, [userId, idempotencyKey]);
      if (!ex.rows[0]) throw new HttpError(409, 'that idempotency key was already used');
      return ex.rows[0].round_id;
    }

    if (open) {
      // Join as the opponent: lock both picks, snapshot both start marks NOW, start the window.
      await chargeAnte(q, userId, ante, playId);
      const cStart = await markE6(q, open.params.creatorMarketId);
      const oStart = await markE6(q, marketId);
      if (!cStart || !oStart) throw new HttpError(503, 'no live price for a picked card — try again');
      const now = Date.now();
      const p: DuelParams = {
        ...open.params,
        opponentUserId: userId, opponentMarketId: marketId, opponentCard: pick,
        creatorStartE6: cStart.toString(), opponentStartE6: oStart.toString(),
        startAt: new Date(now).toISOString(), closeAt: new Date(now + open.params.windowHours * 3_600_000).toISOString(),
      };
      await q.query(`UPDATE game_rounds SET status = 'active', params = $2, pot_uusdc = $3 WHERE id = $1`, [open.id, JSON.stringify(p), (ante * 2n).toString()]);
      return open.id;
    }

    // Open a new duel (this player is the creator) — the start marks are snapshotted only when matched.
    await chargeAnte(q, userId, ante, playId);
    const id = randomUUID();
    const p: DuelParams = { anteUsd: cfg.anteUsd, windowHours: cfg.windowHours, rakeBps: cfg.rakeBps, creatorUserId: userId, creatorMarketId: marketId, creatorCard: pick };
    await q.query(`INSERT INTO game_rounds(id, game_type, status, params) VALUES($1, 'price-duel', 'open', $2)`, [id, JSON.stringify(p)]);
    await q.query(`UPDATE game_plays SET round_id = $1 WHERE id = $2`, [id, playId]);
    return id;
  });

  await settleIfDue(db, roundId).catch(() => {});
  const v = await getDuel(db, userId, roundId);
  return v!;
}

/** Settle a matched duel whose window has closed: higher %-move wins pot−rake (tie refunds both). */
async function settleDuel(q: Queryer, duel: DuelRow): Promise<{ winner: 'creator' | 'opponent' | 'tie'; winnerUserId: string | null; marketId: string; payoutE6: bigint } | null> {
  const p = duel.params;
  const cStart = BigInt(p.creatorStartE6!);
  const oStart = BigInt(p.opponentStartE6!);
  const cClose = (await markE6(q, p.creatorMarketId)) ?? cStart; // no fresh print → 0% move
  const oClose = (await markE6(q, p.opponentMarketId!)) ?? oStart;
  // Compare %-moves without floats: creator wins iff cClose/cStart > oClose/oStart ⇔ cClose·oStart > oClose·cStart.
  const lhs = cClose * oStart;
  const rhs = oClose * cStart;
  const winner: 'creator' | 'opponent' | 'tie' = lhs > rhs ? 'creator' : lhs < rhs ? 'opponent' : 'tie';

  const ante = usdc(p.anteUsd);
  let winnerUserId: string | null = null;
  let payout = 0n;
  let marketId = p.creatorMarketId;
  if (winner === 'tie') {
    // Refund both in a deterministic user order so two duels settling at once can't deadlock on the locks.
    for (const uid of [p.creatorUserId, p.opponentUserId!].sort()) await payFromPool(q, uid, ante, 'GAME_DUEL_REFUND', duel.id);
  } else {
    winnerUserId = winner === 'creator' ? p.creatorUserId : p.opponentUserId!;
    marketId = winner === 'creator' ? p.creatorMarketId : p.opponentMarketId!;
    const pot = ante * 2n;
    payout = pot - (pot * BigInt(p.rakeBps)) / 10_000n;
    await payFromPool(q, winnerUserId, payout, 'GAME_DUEL_WIN', duel.id);
  }
  const np: DuelParams = { ...p, winner, winnerUserId, creatorCloseE6: cClose.toString(), opponentCloseE6: oClose.toString() };
  await q.query(`UPDATE game_rounds SET status = 'settled', resolved_at = now(), prize_uusdc = $2, params = $3 WHERE id = $1`, [duel.id, payout.toString(), JSON.stringify(np)]);
  return { winner, winnerUserId, marketId, payoutE6: payout };
}

/** Settle the duel if it is active and its window has closed (locks it; no-op otherwise). Best-effort broadcast. */
async function settleIfDue(db: Db, duelId: string): Promise<void> {
  const out = await db.tx(async (q) => {
    const r = await q.query<DuelRow & { due: boolean }>(`SELECT ${DUEL_COLS}, (status = 'active' AND (params->>'closeAt')::timestamptz <= now()) AS due FROM game_rounds WHERE id = $1 FOR UPDATE`, [duelId]);
    if (!r.rows[0] || !r.rows[0].due) return null;
    return settleDuel(q, r.rows[0]);
  });
  if (out && out.winnerUserId) await broadcastDuel(db, out).catch(() => {});
}

async function broadcastDuel(db: Db, res: { winner: string; winnerUserId: string | null; marketId: string; payoutE6: bigint }): Promise<void> {
  if (!res.winnerUserId) return;
  const cfg = priceDuelConfig();
  const u = await db.query<{ dn: string | null; pk: string }>(`SELECT display_name AS dn, solana_pubkey AS pk FROM users WHERE id = $1`, [res.winnerUserId]);
  const handle = u.rows[0] ? handleFor(u.rows[0].dn, u.rows[0].pk) : 'someone';
  const mk = await db.query<{ dn: string; img: string | null }>(`SELECT display_name AS dn, image_small AS img FROM markets WHERE id = $1`, [res.marketId]);
  publish('games', 'play', { id: randomUUID(), game: 'price-duel', handle, marketId: res.marketId, displayName: mk.rows[0]?.dn, imageSmall: mk.rows[0]?.img ?? null, valueE6: res.payoutE6.toString(), at: new Date().toISOString() });
  if (res.payoutE6 >= usdc(cfg.bigWinUsd)) await emitGameWinEvent(db, { userId: res.winnerUserId, marketId: res.marketId, payoutE6: res.payoutE6, game: 'Price Duel' });
}

/** A specific duel for a participant (settles it first if its window has closed). */
export async function getDuel(db: Db, userId: string, duelId: string): Promise<DuelView | null> {
  await settleIfDue(db, duelId).catch(() => {}); // best-effort: a transient settle error shouldn't 500 the read
  const r = await db.query<DuelRow>(`SELECT ${DUEL_COLS} FROM game_rounds WHERE id = $1 AND game_type = 'price-duel'`, [duelId]);
  if (!r.rows[0]) return null;
  return buildView(r.rows[0], userId);
}

/** The caller's current duel — the one they're waiting in or actively dueling (settles it if due), or null. */
export async function myDuel(db: Db, userId: string): Promise<DuelView | null> {
  // No enabled-gate: a player must always be able to see + settle a duel they're already in (and a
  // disabled game still settles in-flight escrow). Only NEW duels (joinOrCreateDuel) gate on enabled.
  const r = await db.query<{ round_id: string }>(
    `SELECT gp.round_id FROM game_plays gp JOIN game_rounds gr ON gr.id = gp.round_id
      WHERE gp.user_id = $1 AND gp.game_type = 'price-duel' AND gr.status IN ('open', 'active')
      ORDER BY gp.created_at DESC LIMIT 1`,
    [userId],
  );
  if (!r.rows[0]) return null;
  return getDuel(db, userId, r.rows[0].round_id);
}

/** The creator backs out of their still-unmatched duel: refund the ante, mark cancelled. */
export async function cancelDuel(db: Db, userId: string, duelId: string): Promise<{ duelId: string }> {
  // No enabled-gate: the creator can always reclaim their escrow from an unmatched duel.
  return db.tx(async (q) => {
    const r = await q.query<DuelRow>(`SELECT ${DUEL_COLS} FROM game_rounds WHERE id = $1 AND game_type = 'price-duel' FOR UPDATE`, [duelId]);
    if (!r.rows[0]) throw new HttpError(404, 'duel not found');
    if (r.rows[0].status !== 'open') throw new HttpError(409, 'only an unmatched duel can be cancelled');
    if (r.rows[0].params.creatorUserId !== userId) throw new HttpError(403, 'only the creator can cancel this duel');
    await payFromPool(q, userId, usdc(r.rows[0].params.anteUsd), 'GAME_DUEL_REFUND', duelId);
    await q.query(`UPDATE game_rounds SET status = 'cancelled', resolved_at = now() WHERE id = $1`, [duelId]);
    return { duelId };
  });
}

/** Worker pass: settle every matched duel whose window has closed (single-leader via lease in index.ts). */
export async function settleExpiredDuels(db: Db): Promise<number> {
  const due = await db.query<{ id: string }>(`SELECT id FROM game_rounds WHERE game_type = 'price-duel' AND status = 'active' AND (params->>'closeAt')::timestamptz <= now()`, []);
  for (const d of due.rows) await settleIfDue(db, d.id).catch(() => {});
  return due.rows.length;
}
