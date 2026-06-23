import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { usdc } from '../money.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, getBalance, postTxn } from './ledger.ts';
import { handleFor } from './handles.ts';
import { publish } from './bus.ts';
import { emitGameWinEvent } from './chat.ts';
import { theBreakConfig, type TheBreakConfig } from './game-config.ts';
import { commitServerSeed, fairShuffle } from './game-fairness.ts';
import { featuredCards, bandEligibility, drawCardAt, type RevealFair } from './games.ts';

/**
 * The Break (docs/games-spec.md, game #4). A shared "case" = N spots and N oracle-priced cards drawn at
 * creation under a committed server seed (the cards are public; the secret is WHO gets WHICH). Players buy
 * spots (entry → GAME_POOL); when the case fills, a provably-fair Fisher-Yates shuffle assigns the cards to
 * the spots, the server seed is revealed, and each entrant wins their spot's card as a held prize (sold
 * back via the shared sellBackPrize at mark × (1 − spread), capped). The house edge is structural —
 * N × entry vs Σ(card values) × (1 − spread) — surfaced by breakEv.
 *
 * One open case at a time (uq_open_round_per_game); a join locks the case row FOR UPDATE so spots are
 * assigned without races, and the join that fills the last spot resolves the whole case in its own tx.
 * Provable fairness is per-round: serverSeed committed at creation, clientSeed = the round id (public),
 * nonce 0; card k drawn at cursors (2k, 2k+1); the shuffle at cursor base 2N. Flag-gated OFF by default.
 * Regulatory: HIGH — this is the format under active litigation; ship behind geofence/structuring.
 */

const GAMES_OFF = () => new HttpError(403, 'games are not enabled', 'games_disabled');
function requireOn(): TheBreakConfig {
  if (!config.gamesEnabled) throw GAMES_OFF();
  const cfg = theBreakConfig();
  if (!cfg.enabled) throw GAMES_OFF();
  return cfg;
}

interface BreakCard {
  marketId: string;
  symbol: string;
  displayName: string;
  imageSmall: string | null;
  valueE6: string; // oracle mark at case creation
  fair: RevealFair;
}
interface BreakParams {
  entryUsd: number;
  spots: number;
  filled: number;
  clientSeed: string; // public = the round id
  cards: BreakCard[];
  shuffle?: number[]; // set at resolution: spot k won cards[shuffle[k]]
  revealedServerSeed?: string;
}
interface RoundRow { id: string; status: string; server_seed: string; server_seed_hash: string; params: BreakParams }

const pubCard = (c: BreakCard) => ({ marketId: c.marketId, symbol: c.symbol, displayName: c.displayName, imageSmall: c.imageSmall, valueE6: c.valueE6 });

export interface BreakView {
  roundId: string;
  status: string; // open | settled | cancelled
  spots: number;
  filled: number;
  entryUsd: number;
  serverSeedHash: string;
  clientSeed: string;
  cards: ReturnType<typeof pubCard>[]; // the case's card list (public)
  yourSpots: { spotIndex: number; prizeId: string | null; card: ReturnType<typeof pubCard> | null }[];
  revealedServerSeed?: string;
  assignment?: { spotIndex: number; card: ReturnType<typeof pubCard> }[]; // settled: which card each spot won
}

interface YourPlay { spotIndex: number; prizeId?: string; card?: ReturnType<typeof pubCard> }

async function buildView(q: Queryer, round: RoundRow, userId: string): Promise<BreakView> {
  const p = round.params;
  const yours = await q.query<{ result: { spotIndex: number; prizeId?: string; card?: ReturnType<typeof pubCard> } }>(
    `SELECT result FROM game_plays WHERE round_id = $1 AND user_id = $2 ORDER BY (result->>'spotIndex')::int`,
    [round.id, userId],
  );
  const view: BreakView = {
    roundId: round.id,
    status: round.status,
    spots: p.spots,
    filled: p.filled,
    entryUsd: p.entryUsd,
    serverSeedHash: round.server_seed_hash,
    clientSeed: p.clientSeed,
    cards: p.cards.map(pubCard),
    yourSpots: yours.rows.map((r) => ({ spotIndex: r.result.spotIndex, prizeId: r.result.prizeId ?? null, card: r.result.card ?? null })),
  };
  if (round.status === 'settled' && p.shuffle) {
    view.revealedServerSeed = p.revealedServerSeed;
    view.assignment = p.shuffle.map((cardIdx, spotIndex) => ({ spotIndex, card: pubCard(p.cards[cardIdx]) }));
  }
  return view;
}

/** Draw a fresh case (N cards from the bands) under a committed seed and insert it OPEN; returns it locked. */
async function createCase(q: Queryer, cfg: TheBreakConfig): Promise<RoundRow> {
  const pool = await featuredCards(q);
  if (pool.length === 0) throw new HttpError(503, 'no cards available to break yet');
  const { serverSeed, serverSeedHash } = commitServerSeed();
  const roundId = randomUUID();
  const clientSeed = roundId;
  const seed = { server_seed: serverSeed, client_seed: clientSeed, nonce: 0 };
  const cards: BreakCard[] = [];
  for (let k = 0; k < cfg.spots; k++) {
    const { card, fair } = drawCardAt(seed, cfg.bands, pool, 2 * k, 2 * k + 1);
    cards.push({ marketId: card.id, symbol: card.symbol, displayName: card.displayName, imageSmall: card.imageSmall, valueE6: card.markE6.toString(), fair });
  }
  const params: BreakParams = { entryUsd: cfg.entryUsd, spots: cfg.spots, filled: 0, clientSeed, cards };
  await q.query(
    `INSERT INTO game_rounds(id, game_type, status, server_seed, server_seed_hash, params) VALUES($1, 'the-break', 'open', $2, $3, $4)`,
    [roundId, serverSeed, serverSeedHash, JSON.stringify(params)],
  );
  const r = await q.query<RoundRow>(`SELECT id, status, server_seed, server_seed_hash, params FROM game_rounds WHERE id = $1 FOR UPDATE`, [roundId]);
  return r.rows[0];
}

/** Resolve a full case: reveal the seed, shuffle cards → spots, award each entrant their spot's card. */
async function resolveCase(q: Queryer, round: RoundRow, cfg: TheBreakConfig): Promise<{ marketId: string; valueE6: bigint; handleUserId: string } | null> {
  const p = round.params;
  const n = p.spots;
  const shuffle = fairShuffle(round.server_seed, p.clientSeed, 0, n, 2 * n); // spot k wins cards[shuffle[k]]
  const entrants = await q.query<{ id: string; user_id: string; result: { spotIndex: number } }>(
    `SELECT id, user_id, result FROM game_plays WHERE round_id = $1 ORDER BY id`, [round.id],
  );
  let prizeTotal = 0n;
  let top: { marketId: string; valueE6: bigint; handleUserId: string } | null = null;
  for (const e of entrants.rows) {
    const card = p.cards[shuffle[e.result.spotIndex]];
    const prizeId = randomUUID();
    await q.query(
      `INSERT INTO game_prizes(id, play_id, round_id, user_id, market_id, value_e6, spread_bps, max_prize_e6) VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
      [prizeId, e.id, round.id, e.user_id, card.marketId, card.valueE6, cfg.buybackSpreadBps, usdc(cfg.maxPrizeUsd).toString()],
    );
    await q.query(`UPDATE game_plays SET result = $1 WHERE id = $2`, [JSON.stringify({ spotIndex: e.result.spotIndex, prizeId, card: pubCard(card) }), e.id]);
    prizeTotal += BigInt(card.valueE6);
    if (!top || BigInt(card.valueE6) > top.valueE6) top = { marketId: card.marketId, valueE6: BigInt(card.valueE6), handleUserId: e.user_id };
  }
  p.shuffle = shuffle;
  p.revealedServerSeed = round.server_seed;
  await q.query(`UPDATE game_rounds SET status = 'settled', resolved_at = now(), prize_uusdc = $2, params = $3 WHERE id = $1`, [round.id, prizeTotal.toString(), JSON.stringify(p)]);
  return top;
}

/** The current open case (with the caller's spots), or null if none is open. */
export async function currentBreak(db: Db, userId: string): Promise<BreakView | null> {
  requireOn();
  const r = await db.query<RoundRow>(`SELECT id, status, server_seed, server_seed_hash, params FROM game_rounds WHERE game_type = 'the-break' AND status = 'open' ORDER BY started_at LIMIT 1`, []);
  if (!r.rows[0]) return null;
  return buildView(db, r.rows[0], userId);
}

/** A specific case (open / settled / cancelled) with the caller's spots + prizes — for polling a join. */
export async function getBreakRound(db: Db, userId: string, roundId: string): Promise<BreakView | null> {
  requireOn();
  const r = await db.query<RoundRow>(`SELECT id, status, server_seed, server_seed_hash, params FROM game_rounds WHERE id = $1 AND game_type = 'the-break'`, [roundId]);
  if (!r.rows[0]) return null;
  return buildView(db, r.rows[0], userId);
}

/** Buy a spot in the open case (creating one if none), then resolve the case if this fills it. */
export async function joinBreak(db: Db, userId: string, idempotencyKey: string): Promise<BreakView> {
  const cfg = requireOn();

  const out = await db.tx(async (q): Promise<{ roundId: string; resolved: boolean; top: Awaited<ReturnType<typeof resolveCase>> }> => {
    const r = await q.query<RoundRow>(`SELECT id, status, server_seed, server_seed_hash, params FROM game_rounds WHERE game_type = 'the-break' AND status = 'open' ORDER BY started_at LIMIT 1 FOR UPDATE`, []);
    const open = r.rows[0] ?? null;
    // Charge the CASE's price (the live knob only sets the price of a NEW case), so a mid-case knob change
    // can't make joiners pay a different amount than the case advertises or than a cancel refunds.
    const entry = usdc(open ? open.params.entryUsd : cfg.entryUsd);

    // Anchor the entry idempotently BEFORE creating any case, so a replayed key can never spawn an
    // orphaned no-wager case (which would freeze the surface behind uq_open_round_per_game).
    const playId = randomUUID();
    const ins = await q.query<{ id: string }>(
      `INSERT INTO game_plays(id, game_type, round_id, user_id, idempotency_key, wager_uusdc, result)
       VALUES($1, 'the-break', $2, $3, $4, $5, '{}') ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [playId, open?.id ?? null, userId, idempotencyKey, entry.toString()],
    );
    if (!ins.rows[0]) {
      // Replay: this key already bought a spot — return that spot's round (which may now be settled).
      const ex = await q.query<{ round_id: string }>(`SELECT round_id FROM game_plays WHERE user_id = $1 AND idempotency_key = $2`, [userId, idempotencyKey]);
      return { roundId: ex.rows[0].round_id, resolved: false, top: null };
    }
    // Genuinely new entry — open a fresh case now if none was open, and link this play to it.
    const round = open ?? (await createCase(q, cfg));
    if (!open) await q.query(`UPDATE game_plays SET round_id = $1 WHERE id = $2`, [round.id, playId]);

    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const lock = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
    const available = lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n;
    if (available < entry) throw new HttpError(400, 'insufficient balance', 'insufficient_balance');
    const pool = await getOrCreateSystemAccount(q, 'GAME_POOL');
    await postTxn(q, { reason: 'GAME_WAGER', refType: 'game_play', refId: playId, entries: [{ accountId: coll, amount: -entry }, { accountId: pool, amount: entry }] });

    const p = round.params;
    const spotIndex = p.filled;
    p.filled += 1;
    await q.query(`UPDATE game_plays SET result = $1 WHERE id = $2`, [JSON.stringify({ spotIndex }), playId]);
    await q.query(`UPDATE game_rounds SET params = $2, pot_uusdc = pot_uusdc + $3 WHERE id = $1`, [round.id, JSON.stringify(p), entry.toString()]);

    if (p.filled >= p.spots) {
      const fresh = await q.query<RoundRow>(`SELECT id, status, server_seed, server_seed_hash, params FROM game_rounds WHERE id = $1`, [round.id]);
      const top = await resolveCase(q, fresh.rows[0], cfg);
      return { roundId: round.id, resolved: true, top };
    }
    return { roundId: round.id, resolved: false, top: null };
  });

  if (out.resolved) await broadcastResolved(db, out.roundId, out.top, cfg).catch(() => {});
  const view = await getBreakRound(db, userId, out.roundId);
  return view!;
}

/** Broadcast a settled case to the live feed; the biggest card fires a chat BIG WIN. */
async function broadcastResolved(db: Db, roundId: string, top: Awaited<ReturnType<typeof resolveCase>>, cfg: TheBreakConfig): Promise<void> {
  publish('games', 'break', { roundId, status: 'settled', at: new Date().toISOString() });
  if (!top) return;
  const u = await db.query<{ dn: string | null; pk: string }>(`SELECT display_name AS dn, solana_pubkey AS pk FROM users WHERE id = $1`, [top.handleUserId]);
  const handle = u.rows[0] ? handleFor(u.rows[0].dn, u.rows[0].pk) : 'someone';
  const mk = await db.query<{ dn: string; img: string | null }>(`SELECT display_name AS dn, image_small AS img FROM markets WHERE id = $1`, [top.marketId]);
  publish('games', 'play', { id: roundId, game: 'the-break', handle, marketId: top.marketId, displayName: mk.rows[0]?.dn, imageSmall: mk.rows[0]?.img ?? null, valueE6: top.valueE6.toString(), at: new Date().toISOString() });
  if (top.valueE6 >= usdc(cfg.bigWinUsd)) await emitGameWinEvent(db, { userId: top.handleUserId, marketId: top.marketId, payoutE6: top.valueE6, game: 'The Break' });
}

export interface BreakEv {
  spots: number;
  entryUsd: number;
  eligibleBands: number;
  poolSize: number;
  expCardPayoutE6: string; // E[one card] x (1 - spread) — the expected sell-back of a spot's card
  houseEdgeBps: number; // (entry - expCardPayout) / entry; NEGATIVE = the house loses per spot
}

/** Expected per-spot payout + the house edge vs the live pool (each spot wins one band-drawn card). */
export async function breakEv(db: Db): Promise<BreakEv> {
  const cfg = theBreakConfig();
  const pool = await featuredCards(db);
  const { perBand, effWeights } = bandEligibility(cfg.bands, pool);
  const eligibleBands = effWeights.filter((w) => w > 0).length;
  const total = effWeights.reduce((a, w) => a + w, 0);
  let expCardE6 = 0n;
  if (total > 0) {
    cfg.bands.forEach((_b, i) => {
      if (effWeights[i] <= 0) return;
      const cards = perBand[i];
      const avg = cards.reduce((a, c) => a + c.markE6, 0n) / BigInt(cards.length);
      expCardE6 += (avg * BigInt(effWeights[i])) / BigInt(total);
    });
  } else if (pool.length > 0) {
    expCardE6 = pool.reduce((m, c) => (c.markE6 < m ? c.markE6 : m), pool[0].markE6);
  }
  const cap = usdc(cfg.maxPrizeUsd);
  let expPayout = (expCardE6 * BigInt(10_000 - cfg.buybackSpreadBps)) / 10_000n;
  if (expPayout > cap) expPayout = cap;
  const entry = usdc(cfg.entryUsd);
  const houseEdgeBps = entry > 0n ? Number(((entry - expPayout) * 10_000n) / entry) : 0;
  return { spots: cfg.spots, entryUsd: cfg.entryUsd, eligibleBands, poolSize: pool.length, expCardPayoutE6: expPayout.toString(), houseEdgeBps };
}

/** Admin safety valve: cancel an open case and refund every entrant's entry (GAME_POOL → collateral). */
export async function cancelBreak(db: Db, roundId: string): Promise<{ roundId: string; refunded: number }> {
  return db.tx(async (q) => {
    const r = await q.query<RoundRow>(`SELECT id, status, server_seed, server_seed_hash, params FROM game_rounds WHERE id = $1 AND game_type = 'the-break' FOR UPDATE`, [roundId]);
    if (!r.rows[0]) throw new HttpError(404, 'case not found');
    if (r.rows[0].status !== 'open') throw new HttpError(409, 'only an open case can be cancelled');
    const entrants = await q.query<{ id: string; user_id: string; wager: string }>(`SELECT id, user_id, wager_uusdc::text AS wager FROM game_plays WHERE round_id = $1`, [roundId]);
    const pool = await getOrCreateSystemAccount(q, 'GAME_POOL');
    for (const e of entrants.rows) {
      // Refund each entrant exactly what THEY paid (not a recomputed price), and lock collateral-then-pool
      // (the order sell-back/join use, so no deadlock) while checking the pool can cover this refund.
      const refund = BigInt(e.wager);
      const coll = await getOrCreateUserAccount(q, e.user_id, 'USER_COLLATERAL');
      await q.query(`SELECT 1 FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
      const pl = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [pool]);
      if ((pl.rows[0] ? BigInt(pl.rows[0].amount_uusdc) : 0n) < refund) throw new HttpError(503, 'GAME_POOL has insufficient funds to refund — top it up first');
      await postTxn(q, { reason: 'GAME_BREAK_REFUND', refType: 'game_play', refId: e.id, entries: [{ accountId: coll, amount: refund }, { accountId: pool, amount: -refund }] });
    }
    await q.query(`UPDATE game_rounds SET status = 'cancelled', resolved_at = now() WHERE id = $1`, [roundId]);
    return { roundId, refunded: entrants.rows.length };
  });
}
