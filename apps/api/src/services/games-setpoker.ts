import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { usdc } from '../money.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, getBalance, postTxn } from './ledger.ts';
import { assertSpendableExcludingBonus } from './bonus.ts';
import { handleFor } from './handles.ts';
import { publish } from './bus.ts';
import { emitGameWinEvent } from './chat.ts';
import { setPokerConfig } from './game-config.ts';
import {
  featuredCards,
  bandEligibility,
  drawCardAt,
  consumeSeed,
  type CardRow,
  type FairSeed,
  type RevealFair,
} from './games.ts';

/**
 * Set Poker (docs/games-spec.md, game #2). Pay an ante to be dealt five cards against a face-up five-card
 * house hand; pay per swap to redraw cards; then SETTLE — the SUM of your five cards' live oracle value
 * must STRICTLY beat the house's (ties go to the house) to win. On a win you claim your single highest
 * card as a held prize, sellable for USDC via the shared sell-back (games.ts) at mark·(1 − spread).
 *
 * Money: the ante and each swap fee move USER_COLLATERAL → GAME_POOL at the time they're paid; settle
 * moves no money (the prize is a held game_prizes row, paid out only when sold back). Every leg balances
 * the ledger (the reconciler verifies). One hand at a time per user; the whole hand draws against a single
 * (server seed, client seed, nonce) captured at deal — seed rotation is blocked while a hand is open
 * (games.ts) — with one cursor pair per draw (deal draws 0..9, swaps 10, 11, …), so it's reproducible.
 */

const GAMES_OFF = () => new HttpError(403, 'games are not enabled', 'games_disabled');
const requireOn = (): ReturnType<typeof setPokerConfig> => {
  if (!config.gamesEnabled) throw GAMES_OFF();
  const cfg = setPokerConfig();
  if (!cfg.enabled) throw GAMES_OFF();
  return cfg;
};

interface SPCard {
  marketId: string;
  symbol: string;
  displayName: string;
  imageSmall: string | null;
  valueE6: string; // oracle mark snapshot at the moment it was drawn
  fair: RevealFair & { drawIndex: number };
}
interface SPHand {
  status: 'open' | 'settled';
  anteUsd: number;
  swapFeeUsd: number;
  maxSwaps: number;
  player: SPCard[];
  house: SPCard[];
  playerTotalE6: string;
  houseTotalE6: string;
  swaps: number;
  drawCount: number; // total cards drawn so far (10 at deal, +1 per swap) → the next cursor pair
  swapKeys?: string[]; // every applied swap's idempotency key (so any swap retry is idempotent, not just the last)
  won?: boolean;
  prizeId?: string;
}

const toCard = (c: CardRow, fair: RevealFair, drawIndex: number): SPCard => ({
  marketId: c.id,
  symbol: c.symbol,
  displayName: c.displayName,
  imageSmall: c.imageSmall,
  valueE6: c.markE6.toString(),
  fair: { ...fair, drawIndex },
});
const sumE6 = (cards: SPCard[]): bigint => cards.reduce((a, c) => a + BigInt(c.valueE6), 0n);
const pub = (cards: SPCard[]) => cards.map((c) => ({ marketId: c.marketId, symbol: c.symbol, displayName: c.displayName, imageSmall: c.imageSmall, valueE6: c.valueE6 }));

export interface SetPokerView {
  playId: string;
  status: 'open' | 'settled';
  anteUsd: number;
  swapFeeUsd: number;
  maxSwaps: number;
  swaps: number;
  player: { marketId: string; symbol: string; displayName: string; imageSmall: string | null; valueE6: string }[];
  house: { marketId: string; symbol: string; displayName: string; imageSmall: string | null; valueE6: string }[];
  playerTotalE6: string;
  houseTotalE6: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  balanceE6: string;
  won?: boolean;
  prize?: { prizeId: string; marketId: string; symbol: string; displayName: string; imageSmall: string | null; valueE6: string };
}

function view(playId: string, hand: SPHand, fairness: { serverSeedHash: string; clientSeed: string; nonce: number }, balanceE6: bigint): SetPokerView {
  const out: SetPokerView = {
    playId,
    status: hand.status,
    anteUsd: hand.anteUsd,
    swapFeeUsd: hand.swapFeeUsd,
    maxSwaps: hand.maxSwaps,
    swaps: hand.swaps,
    player: pub(hand.player),
    house: pub(hand.house),
    playerTotalE6: hand.playerTotalE6,
    houseTotalE6: hand.houseTotalE6,
    serverSeedHash: fairness.serverSeedHash,
    clientSeed: fairness.clientSeed,
    nonce: fairness.nonce,
    balanceE6: balanceE6.toString(),
  };
  if (hand.status === 'settled') {
    out.won = hand.won;
    if (hand.won && hand.prizeId) {
      const best = hand.player.reduce((m, c) => (BigInt(c.valueE6) > BigInt(m.valueE6) ? c : m), hand.player[0]);
      out.prize = { prizeId: hand.prizeId, marketId: best.marketId, symbol: best.symbol, displayName: best.displayName, imageSmall: best.imageSmall, valueE6: best.valueE6 };
    }
  }
  return out;
}

const parseHand = (raw: unknown): SPHand => (typeof raw === 'string' ? JSON.parse(raw) : raw) as SPHand;

interface PlayRow { id: string; result: unknown; server_seed_hash: string; client_seed: string; nonce: number }
const selectOpen = `SELECT id, result, server_seed_hash, client_seed, nonce::int AS nonce FROM game_plays
  WHERE user_id = $1 AND game_type = 'set-poker' AND result->>'status' = 'open'`;

async function userCollateral(q: Queryer, userId: string): Promise<{ id: string; balance: bigint }> {
  const id = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  const lock = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [id]);
  return { id, balance: lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n };
}

/** Move a wager (ante or swap fee) USER_COLLATERAL → GAME_POOL, returning the post-debit collateral. Bonus is
 *  perp-only: the guard (FOR UPDATE + floor) authorises the spend and subsumes the plain balance check — so a
 *  locked signup bonus can't be wagered on Set Poker (covers BOTH the ante and the swap-fee callers). */
async function chargeToPool(q: Queryer, userId: string, collId: string, amount: bigint, reason: string, refId: string): Promise<bigint> {
  const locked = await assertSpendableExcludingBonus(q, userId, amount);
  const pool = await getOrCreateSystemAccount(q, 'GAME_POOL');
  await postTxn(q, { reason, refType: 'set_poker', refId, entries: [{ accountId: collId, amount: -amount }, { accountId: pool, amount }] });
  return locked - amount;
}

/** Deal a new hand: pay the ante, draw five player + five house cards provably-fairly (cursors 0..9). */
export async function dealHand(db: Db, userId: string, idempotencyKey: string): Promise<SetPokerView> {
  const cfg = requireOn();
  const ante = usdc(cfg.anteUsd);

  return db.tx(async (q) => {
    const playId = randomUUID();
    const ins = await q.query<{ id: string }>(
      `INSERT INTO game_plays(id, game_type, user_id, idempotency_key, wager_uusdc)
       VALUES($1, 'set-poker', $2, $3, $4) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [playId, userId, idempotencyKey, ante.toString()],
    );
    if (!ins.rows[0]) {
      // Replay: return the hand this key already created (no second ante).
      const ex = await q.query<PlayRow>(
        `SELECT id, result, server_seed_hash, client_seed, nonce::int AS nonce FROM game_plays WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      const row = ex.rows[0];
      const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      return view(row.id, parseHand(row.result), { serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: row.nonce }, await getBalance(q, coll));
    }

    // One hand at a time: refuse if another hand is still open (rolls back this insert).
    const other = await q.query(`${selectOpen} AND id <> $2 LIMIT 1`, [userId, playId]);
    if (other.rows[0]) throw new HttpError(409, 'finish your open hand before dealing a new one', 'hand_in_progress');

    const coll = await userCollateral(q, userId);
    const balanceAfter = await chargeToPool(q, userId, coll.id, ante, 'GAME_WAGER', playId);

    const pool = await featuredCards(q);
    if (pool.length === 0) throw new HttpError(503, 'no cards available to deal yet');
    const seed = await consumeSeed(q, userId);

    const draw = (d: number): SPCard => {
      const { card, fair } = drawCardAt(seed, cfg.bands, pool, 2 * d, 2 * d + 1);
      return toCard(card, fair, d);
    };
    const player = [0, 1, 2, 3, 4].map(draw);
    const house = [5, 6, 7, 8, 9].map(draw);
    const hand: SPHand = {
      status: 'open',
      anteUsd: cfg.anteUsd,
      swapFeeUsd: cfg.swapFeeUsd,
      maxSwaps: cfg.maxSwaps,
      player,
      house,
      playerTotalE6: sumE6(player).toString(),
      houseTotalE6: sumE6(house).toString(),
      swaps: 0,
      drawCount: 10,
    };
    await q.query(
      `UPDATE game_plays SET result = $1, server_seed_hash = $2, client_seed = $3, nonce = $4 WHERE id = $5`,
      [JSON.stringify(hand), seed.server_seed_hash, seed.client_seed, seed.nonce, playId],
    );
    return view(playId, hand, { serverSeedHash: seed.server_seed_hash, clientSeed: seed.client_seed, nonce: seed.nonce }, balanceAfter);
  });
}

/** Swap one of the player's five cards: pay the swap fee, redraw that slot at the next cursor pair. */
export async function swapCard(db: Db, userId: string, slot: number, idempotencyKey: string): Promise<SetPokerView> {
  const cfg = requireOn();
  if (!Number.isInteger(slot) || slot < 0 || slot > 4) throw new HttpError(400, 'slot must be 0..4');

  return db.tx(async (q) => {
    const r = await q.query<PlayRow>(`${selectOpen} FOR UPDATE`, [userId]);
    if (!r.rows[0]) throw new HttpError(404, 'no open hand — deal first');
    const row = r.rows[0];
    const hand = parseHand(row.result);
    const fairness = { serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: row.nonce };

    if (hand.swapKeys && hand.swapKeys.includes(idempotencyKey)) {
      // Idempotent retry of an already-applied swap (any of them, not only the last): no re-charge.
      const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      return view(row.id, hand, fairness, await getBalance(q, coll));
    }
    if (hand.swaps >= hand.maxSwaps) throw new HttpError(409, 'no swaps left this hand', 'no_swaps_left');

    const coll = await userCollateral(q, userId);
    // Charge the fee SNAPSHOTTED at deal time (what the player was shown), not the live knob — a mid-hand
    // admin change must not silently bill a different amount than the hand displays.
    const balanceAfter = await chargeToPool(q, userId, coll.id, usdc(hand.swapFeeUsd), 'GAME_SWAP', row.id);

    const pool = await featuredCards(q);
    if (pool.length === 0) throw new HttpError(503, 'no cards available right now');
    // Draw against the hand's captured seed (rotation is blocked while open, so game_seeds still holds it).
    const ss = await q.query<{ server_seed: string; server_seed_hash: string }>(`SELECT server_seed, server_seed_hash FROM game_seeds WHERE user_id = $1`, [userId]);
    if (!ss.rows[0] || ss.rows[0].server_seed_hash !== row.server_seed_hash) throw new HttpError(409, 'seed changed mid-hand — settle and re-deal');
    const seed: FairSeed = { server_seed: ss.rows[0].server_seed, client_seed: row.client_seed, nonce: row.nonce };

    const d = hand.drawCount;
    const { card, fair } = drawCardAt(seed, cfg.bands, pool, 2 * d, 2 * d + 1);
    hand.player[slot] = toCard(card, fair, d);
    hand.drawCount = d + 1;
    hand.swaps += 1;
    hand.swapKeys = [...(hand.swapKeys ?? []), idempotencyKey];
    hand.playerTotalE6 = sumE6(hand.player).toString();

    await q.query(`UPDATE game_plays SET result = $1 WHERE id = $2`, [JSON.stringify(hand), row.id]);
    return view(row.id, hand, fairness, balanceAfter);
  });
}

/**
 * Settle a hand: strict player-total > house-total wins the highest player card as a held prize. Pass the
 * hand's `playId` to settle/replay a specific hand (so an idempotent retry returns THAT hand's outcome, not
 * merely the most recently settled one); omit it to settle whatever hand is open.
 */
export async function settleHand(db: Db, userId: string, playId?: string): Promise<SetPokerView> {
  const cfg = requireOn();

  const out = await db.tx(async (q) => {
    const openSql = playId ? `${selectOpen} AND id = $2 FOR UPDATE` : `${selectOpen} FOR UPDATE`;
    const r = await q.query<PlayRow>(openSql, playId ? [userId, playId] : [userId]);
    if (!r.rows[0]) {
      // Idempotent: an already-settled hand returns its outcome instead of erroring (the specific one if a
      // playId was given, else the most recent).
      const settledSql = `SELECT id, result, server_seed_hash, client_seed, nonce::int AS nonce FROM game_plays
         WHERE user_id = $1 AND game_type = 'set-poker' AND result->>'status' = 'settled'${playId ? ' AND id = $2' : ''} ORDER BY created_at DESC LIMIT 1`;
      const last = await q.query<PlayRow>(settledSql, playId ? [userId, playId] : [userId]);
      if (!last.rows[0]) throw new HttpError(404, 'no hand to settle');
      const row = last.rows[0];
      const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      return { v: view(row.id, parseHand(row.result), { serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: row.nonce }, await getBalance(q, coll)), broadcast: null as null | { marketId: string; valueE6: bigint } };
    }

    const row = r.rows[0];
    const hand = parseHand(row.result);
    const won = BigInt(hand.playerTotalE6) > BigInt(hand.houseTotalE6); // strict — ties go to the house

    let broadcast: { marketId: string; valueE6: bigint } | null = null;
    if (won) {
      const best = hand.player.reduce((m, c) => (BigInt(c.valueE6) > BigInt(m.valueE6) ? c : m), hand.player[0]);
      const prizeId = randomUUID();
      // Snapshot Set Poker's own buyback terms on the prize so its sell-back never uses another game's config.
      await q.query(
        `INSERT INTO game_prizes(id, play_id, user_id, market_id, value_e6, spread_bps, max_prize_e6) VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [prizeId, row.id, userId, best.marketId, best.valueE6, cfg.buybackSpreadBps, usdc(cfg.maxPrizeUsd).toString()],
      );
      hand.won = true;
      hand.prizeId = prizeId;
      broadcast = { marketId: best.marketId, valueE6: BigInt(best.valueE6) };
    } else {
      hand.won = false;
    }
    hand.status = 'settled';
    await q.query(`UPDATE game_plays SET result = $1 WHERE id = $2`, [JSON.stringify(hand), row.id]);

    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    return { v: view(row.id, hand, { serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: row.nonce }, await getBalance(q, coll)), broadcast };
  });

  if (out.broadcast) {
    const cfg = setPokerConfig();
    const b = out.broadcast;
    const u = await db.query<{ dn: string | null; pk: string }>(`SELECT display_name AS dn, solana_pubkey AS pk FROM users WHERE id = $1`, [userId]);
    const handle = u.rows[0] ? handleFor(u.rows[0].dn, u.rows[0].pk) : 'someone';
    publish('games', 'play', { id: out.v.prize?.prizeId, game: 'set-poker', handle, marketId: b.marketId, symbol: out.v.prize?.symbol, displayName: out.v.prize?.displayName, imageSmall: out.v.prize?.imageSmall, valueE6: b.valueE6.toString(), at: new Date().toISOString() });
    if (b.valueE6 >= usdc(cfg.bigWinUsd)) await emitGameWinEvent(db, { userId, marketId: b.marketId, payoutE6: b.valueE6, game: 'Set Poker' }).catch(() => {});
  }
  return out.v;
}

/** The caller's currently-open hand (to resume after a reload), or null. */
export async function getOpenHand(db: Db, userId: string): Promise<SetPokerView | null> {
  const r = await db.query<PlayRow>(`${selectOpen} ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  const coll = await getOrCreateUserAccount(db, userId, 'USER_COLLATERAL');
  return view(row.id, parseHand(row.result), { serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: row.nonce }, await getBalance(db, coll));
}

export interface SetPokerEv {
  eligibleBands: number;
  poolSize: number;
  samples: number;
  winRatePct: number; // stand-pat (no swaps) win rate
  avgPrizePaidE6: string; // expected prize paid per hand (0 on a loss), averaged over all hands
  houseEdgeBps: number; // (ante − avgPrizePaid) / ante, stand-pat; NEGATIVE = the house loses
}

/**
 * Monte-Carlo house-edge estimate for the admin Games view. Set Poker's edge can't be derived cleanly
 * (it turns on the hand-vs-hand distribution), so we simulate `samples` STAND-PAT hands (no swaps) against
 * the live pool: deal 5 player + 5 house from the bands, and on a strict player win pay the highest card
 * × (1 − spread), capped. Stand-pat is a baseline — real play adds swap-fee revenue AND lifts the win rate.
 */
export async function setPokerEv(db: Db): Promise<SetPokerEv> {
  const cfg = setPokerConfig();
  const pool = await featuredCards(db);
  const { perBand, effWeights } = bandEligibility(cfg.bands, pool);
  const eligibleBands = effWeights.filter((w) => w > 0).length;
  const total = effWeights.reduce((a, w) => a + w, 0);
  if (total <= 0 || pool.length === 0) {
    return { eligibleBands, poolSize: pool.length, samples: 0, winRatePct: 0, avgPrizePaidE6: '0', houseEdgeBps: 0 };
  }
  const drawVal = (): bigint => {
    let t = Math.random() * total;
    let bi = effWeights.findIndex((w) => w > 0);
    for (let i = 0; i < effWeights.length; i++) {
      t -= effWeights[i];
      if (t < 0) { bi = i; break; }
    }
    const cards = perBand[bi];
    return cards[Math.floor(Math.random() * cards.length)].markE6;
  };
  const samples = 4000;
  const spreadKeep = BigInt(10_000 - cfg.buybackSpreadBps);
  const cap = usdc(cfg.maxPrizeUsd);
  const ante = usdc(cfg.anteUsd);
  let wins = 0;
  let prizePaid = 0n;
  for (let s = 0; s < samples; s++) {
    let pSum = 0n, pMax = 0n, hSum = 0n;
    for (let i = 0; i < 5; i++) { const v = drawVal(); pSum += v; if (v > pMax) pMax = v; }
    for (let i = 0; i < 5; i++) hSum += drawVal();
    if (pSum > hSum) {
      wins++;
      let prize = (pMax * spreadKeep) / 10_000n;
      if (prize > cap) prize = cap;
      prizePaid += prize;
    }
  }
  const avgPrizePaid = prizePaid / BigInt(samples);
  const houseEdgeBps = ante > 0n ? Number(((ante - avgPrizePaid) * 10_000n) / ante) : 0;
  return { eligibleBands, poolSize: pool.length, samples, winRatePct: Math.round((wins / samples) * 1000) / 10, avgPrizePaidE6: avgPrizePaid.toString(), houseEdgeBps };
}
