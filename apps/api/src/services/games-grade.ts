import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { usdc } from '../money.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, getBalance, postTxn } from './ledger.ts';
import { handleFor } from './handles.ts';
import { publish } from './bus.ts';
import { emitGameWinEvent } from './chat.ts';
import { gradeGambleConfig } from './game-config.ts';
import { weightedPick } from './game-fairness.ts';
import { featuredCards, bandEligibility, drawCardAt, consumeSeed, type CardRow, type RevealFair, type TierEv } from './games.ts';

/**
 * Grade Gamble (docs/games-spec.md, game #3). Pay an ante to "submit a card for grading": draw a base card
 * provably-fairly from the tier's value bands (cursors 0/1), then roll a GRADE from a weighted table
 * (cursor 2) whose multiplier scales the card's value. You win the card "graded" as a held prize carrying
 * `multiplier_bps`, sold back later (shared sellBackPrize) at mark × grade × (1 − spread), capped.
 *
 * The house edge is structural: the grade table's E[multiplier] (house-set — the research found no
 * published real PSA distribution) times the base-card distribution times the spread. `gradeGambleEv`
 * reports the realised per-tier edge against the live pool. Ante moves USER_COLLATERAL → GAME_POOL; the
 * prize pays out of the pool only when sold. Flag-gated OFF by default. (Double-or-nothing regrades are a
 * deferred enhancement; v1 is a single graded reveal.)
 */

const GAMES_OFF = () => new HttpError(403, 'games are not enabled', 'games_disabled');

export interface GradeResult {
  duplicate: boolean;
  playId: string;
  prizeId: string;
  tier: number;
  card: { marketId: string; symbol: string; displayName: string; imageSmall: string | null; baseValueE6: string; gradedValueE6: string };
  grade: { label: string; multBps: number; index: number };
  balanceE6: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

const gradedE6 = (baseE6: bigint, multBps: number): bigint => (baseE6 * BigInt(multBps)) / 10_000n;

function buildResult(playId: string, tier: number, card: CardRow, prizeId: string, grade: { label: string; multBps: number; index: number }, fairness: { serverSeedHash: string; clientSeed: string; nonce: number }, balanceE6: bigint, duplicate: boolean): GradeResult {
  return {
    duplicate,
    playId,
    prizeId,
    tier,
    card: { marketId: card.id, symbol: card.symbol, displayName: card.displayName, imageSmall: card.imageSmall, baseValueE6: card.markE6.toString(), gradedValueE6: gradedE6(card.markE6, grade.multBps).toString() },
    grade,
    balanceE6: balanceE6.toString(),
    ...fairness,
  };
}

/**
 * Open a grade gamble: idempotently anchor the play, debit the ante into GAME_POOL, draw a base card +
 * roll a grade provably-fairly, and record the won card with its grade multiplier (held). A replayed
 * idempotency key returns the original reveal without charging again.
 */
export async function gradeOpen(db: Db, userId: string, tierPrice: number, idempotencyKey: string): Promise<GradeResult> {
  if (!config.gamesEnabled) throw GAMES_OFF();
  const cfg = gradeGambleConfig();
  if (!cfg.enabled) throw GAMES_OFF();
  const tier = cfg.tiers.find((t) => t.price === tierPrice);
  if (!tier) throw new HttpError(400, 'unknown grade-gamble tier');
  const ante = usdc(tier.price);

  const out = await db.tx(async (q): Promise<GradeResult> => {
    const playId = randomUUID();
    const ins = await q.query<{ id: string }>(
      `INSERT INTO game_plays(id, game_type, user_id, idempotency_key, wager_uusdc)
       VALUES($1, 'grade-gamble', $2, $3, $4) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [playId, userId, idempotencyKey, ante.toString()],
    );
    if (!ins.rows[0]) {
      // Replay: filter by game_type too — the (user, key) index is shared across games, so a key reused
      // from a different game would otherwise decode the wrong result shape and 500.
      const ex = await q.query<{ id: string; result: unknown; server_seed_hash: string; client_seed: string; nonce: number }>(
        `SELECT id, result, server_seed_hash, client_seed, nonce::int AS nonce FROM game_plays WHERE user_id = $1 AND idempotency_key = $2 AND game_type = 'grade-gamble'`,
        [userId, idempotencyKey],
      );
      if (!ex.rows[0]) throw new HttpError(409, 'idempotency key already used for a different play');
      const row = ex.rows[0];
      const r = (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as { tier: number; prizeId: string; card: CardRow & { markE6: string }; grade: { label: string; multBps: number; index: number } };
      const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const card: CardRow = { id: r.card.id, symbol: r.card.symbol, displayName: r.card.displayName, imageSmall: r.card.imageSmall, markE6: BigInt(r.card.markE6) };
      return buildResult(row.id, r.tier, card, r.prizeId, r.grade, { serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: row.nonce }, await getBalance(q, coll), true);
    }

    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const lock = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
    const available = lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n;
    if (available < ante) throw new HttpError(400, 'insufficient balance', 'insufficient_balance');

    const pool = await featuredCards(q);
    if (pool.length === 0) throw new HttpError(503, 'no cards available to grade yet');

    const poolAcct = await getOrCreateSystemAccount(q, 'GAME_POOL');
    const txnId = await postTxn(q, {
      reason: 'GAME_WAGER', refType: 'game_play', refId: playId,
      entries: [{ accountId: coll, amount: -ante }, { accountId: poolAcct, amount: ante }],
    });

    const seed = await consumeSeed(q, userId);
    const { card, fair } = drawCardAt(seed, tier.bands, pool, 0, 1);
    const gradeIndex = weightedPick(seed.server_seed, seed.client_seed, seed.nonce, 2, cfg.grades.map((g) => g.weight));
    const grade = { label: cfg.grades[gradeIndex].label, multBps: cfg.grades[gradeIndex].multBps, index: gradeIndex };

    const prizeId = randomUUID();
    await q.query(
      `INSERT INTO game_prizes(id, play_id, user_id, market_id, value_e6, spread_bps, max_prize_e6, multiplier_bps) VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
      [prizeId, playId, userId, card.id, card.markE6.toString(), cfg.buybackSpreadBps, usdc(cfg.maxPrizeUsd).toString(), grade.multBps],
    );
    await q.query(
      `UPDATE game_plays SET result = $1, server_seed_hash = $2, client_seed = $3, nonce = $4, txn_id = $5 WHERE id = $6`,
      [JSON.stringify({ tier: tier.price, prizeId, card: { id: card.id, symbol: card.symbol, displayName: card.displayName, imageSmall: card.imageSmall, markE6: card.markE6.toString() }, grade, fair: { card: fair, gradeWeights: cfg.grades.map((g) => g.weight), gradeIndex } }), seed.server_seed_hash, seed.client_seed, seed.nonce, txnId, playId],
    );

    return buildResult(playId, tier.price, card, prizeId, grade, { serverSeedHash: seed.server_seed_hash, clientSeed: seed.client_seed, nonce: seed.nonce }, available - ante, false);
  });

  if (!out.duplicate) {
    const graded = BigInt(out.card.gradedValueE6);
    await broadcastGrade(db, userId, out, graded, cfg.bigWinUsd).catch(() => {});
  }
  return out;
}

/** Live-feed broadcast for a grade reveal; a graded card worth >= bigWinUsd also fires a chat BIG WIN. */
async function broadcastGrade(db: Db, userId: string, res: GradeResult, gradedValueE6: bigint, bigWinUsd: number): Promise<void> {
  const u = await db.query<{ dn: string | null; pk: string }>(`SELECT display_name AS dn, solana_pubkey AS pk FROM users WHERE id = $1`, [userId]);
  const handle = u.rows[0] ? handleFor(u.rows[0].dn, u.rows[0].pk) : 'someone';
  publish('games', 'play', {
    id: res.playId, game: 'grade-gamble', handle, tier: res.tier, marketId: res.card.marketId,
    symbol: res.card.symbol, displayName: `${res.card.displayName} · ${res.grade.label}`, imageSmall: res.card.imageSmall,
    valueE6: gradedValueE6.toString(), at: new Date().toISOString(),
  });
  if (gradedValueE6 >= usdc(bigWinUsd)) await emitGameWinEvent(db, { userId, marketId: res.card.marketId, payoutE6: gradedValueE6, game: 'Grade Gamble' });
}

export interface GradeGambleEv {
  expGradeMultBps: number; // E[grade multiplier] over the table (10000 = 1×)
  tiers: TierEv[];
}

/** Expected payout + house edge per tier vs the live pool: E[base card]·E[grade multiplier]·(1 − spread). */
export async function gradeGambleEv(db: Db): Promise<GradeGambleEv> {
  const cfg = gradeGambleConfig();
  const pool = await featuredCards(db);
  const gradeTotal = cfg.grades.reduce((a, g) => a + g.weight, 0);
  const expMultBps = gradeTotal > 0 ? Math.round(cfg.grades.reduce((a, g) => a + g.weight * g.multBps, 0) / gradeTotal) : 10_000;
  const spreadKeep = BigInt(10_000 - cfg.buybackSpreadBps);
  const cap = usdc(cfg.maxPrizeUsd);
  const tiers: TierEv[] = cfg.tiers.map((t) => {
    const { perBand, effWeights } = bandEligibility(t.bands, pool);
    const total = effWeights.reduce((a, w) => a + w, 0);
    let expBaseE6 = 0n;
    let eligibleBands = 0;
    if (total > 0) {
      t.bands.forEach((_b, i) => {
        if (effWeights[i] <= 0) return;
        eligibleBands++;
        const cards = perBand[i];
        const avg = cards.reduce((a, c) => a + c.markE6, 0n) / BigInt(cards.length);
        expBaseE6 += (avg * BigInt(effWeights[i])) / BigInt(total);
      });
    } else if (pool.length > 0) {
      expBaseE6 = pool.reduce((m, c) => (c.markE6 < m ? c.markE6 : m), pool[0].markE6);
    }
    let expPayout = (((expBaseE6 * BigInt(expMultBps)) / 10_000n) * spreadKeep) / 10_000n;
    if (expPayout > cap) expPayout = cap;
    const priceE6 = usdc(t.price);
    const houseEdgeBps = priceE6 > 0n ? Number(((priceE6 - expPayout) * 10_000n) / priceE6) : 0;
    return { tier: t.price, expectedPayoutE6: expPayout.toString(), houseEdgeBps, eligibleBands, poolSize: pool.length };
  });
  return { expGradeMultBps: expMultBps, tiers };
}
