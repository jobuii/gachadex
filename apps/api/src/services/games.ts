import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { usdc } from '../money.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, getBalance, postTxn } from './ledger.ts';
import { handleFor } from './handles.ts';
import { publish } from './bus.ts';
import { emitGameWinEvent } from './chat.ts';
import { packRipConfig, type PackBand } from './game-config.ts';
import { commitServerSeed, freshClientSeed, weightedPick, rollInt } from './game-fairness.ts';

/**
 * Games money-movement + provable-fairness orchestration (docs/games-spec.md). Mirrors drop.ts/tipDrop:
 * inside one db.tx, lock the user's collateral, debit the wager into GAME_POOL, run the provably-fair
 * reveal, award a card, and (on sell-back) pay USDC out of GAME_POOL at the live mark minus the buyback
 * spread. Every play balances the ledger (the reconciler catches money bugs).
 *
 * Prize-backend abstraction: v1 ships ONLY OracleSyntheticBackend (USDC at the oracle mark). A real
 * vaulted-card NFT (rare.win) is blocked — "Keep as NFT" is a stub. The mechanics are identical either
 * way; only the settlement backend swaps when that integration lands.
 */

const GAMES_OFF = () => new HttpError(403, 'games are not enabled', 'games_disabled');

interface SeedRow {
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  nonce: number;
}

/** Load (creating on first use) the caller's rotating fairness seed, locked for the play's nonce bump. */
async function ensureSeedForUpdate(q: Queryer, userId: string): Promise<SeedRow> {
  const sel = `SELECT server_seed, server_seed_hash, client_seed, nonce::int AS nonce FROM game_seeds WHERE user_id = $1 FOR UPDATE`;
  const r = await q.query<SeedRow>(sel, [userId]);
  if (r.rows[0]) return r.rows[0];
  const { serverSeed, serverSeedHash } = commitServerSeed();
  await q.query(
    `INSERT INTO game_seeds(user_id, server_seed, server_seed_hash, client_seed, nonce)
     VALUES($1, $2, $3, $4, 0) ON CONFLICT(user_id) DO NOTHING`,
    [userId, serverSeed, serverSeedHash, freshClientSeed()],
  );
  const r2 = await q.query<SeedRow>(sel, [userId]);
  return r2.rows[0];
}

export interface FairnessState {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

/** The provably-fair panel state: the active commitment hash, client seed, and next nonce. */
export async function getFairness(db: Db, userId: string): Promise<FairnessState> {
  const s = await db.tx((q) => ensureSeedForUpdate(q, userId));
  return { serverSeedHash: s.server_seed_hash, clientSeed: s.client_seed, nonce: s.nonce };
}

/**
 * Rotate the client seed: REVEAL the current server seed (so the player can verify every prior play),
 * commit a fresh one, reset the nonce. Returns the revealed seed + its commitment + the new commitment.
 */
export async function rotateClientSeed(
  db: Db,
  userId: string,
  clientSeed: string,
): Promise<{ revealedServerSeed: string; revealedServerSeedHash: string; serverSeedHash: string; clientSeed: string; nonce: number }> {
  const seed = clientSeed.trim();
  if (seed.length < 1 || seed.length > 64 || !/^[\x20-\x7E]+$/.test(seed)) {
    throw new HttpError(400, 'client seed must be 1–64 printable ASCII characters');
  }
  return db.tx(async (q) => {
    const prev = await ensureSeedForUpdate(q, userId);
    const next = commitServerSeed();
    await q.query(
      `UPDATE game_seeds SET server_seed = $2, server_seed_hash = $3, client_seed = $4, nonce = 0, rotated_at = now() WHERE user_id = $1`,
      [userId, next.serverSeed, next.serverSeedHash, seed],
    );
    return {
      revealedServerSeed: prev.server_seed,
      revealedServerSeedHash: prev.server_seed_hash,
      serverSeedHash: next.serverSeedHash,
      clientSeed: seed,
      nonce: 0,
    };
  });
}

interface CardRow {
  id: string;
  symbol: string;
  displayName: string;
  imageSmall: string | null;
  markE6: bigint;
}

/** Featured, oracle-priced card markets (with their latest mark) — the prize pool Pack Rip draws from. */
async function featuredCards(q: Queryer): Promise<CardRow[]> {
  const r = await q.query<{ id: string; symbol: string; display_name: string; image_small: string | null; mark_e6: string }>(
    `SELECT m.id, m.symbol, m.display_name, m.image_small, lm.mark_e6
       FROM markets m
       JOIN (SELECT DISTINCT ON (market_id) market_id, mark_price_e6::text AS mark_e6
               FROM marks ORDER BY market_id, computed_at DESC, id DESC) lm ON lm.market_id = m.id
      WHERE m.featured AND m.kind = 'card' AND m.status = 'active'`,
  );
  return r.rows.map((x) => ({ id: x.id, symbol: x.symbol, displayName: x.display_name, imageSmall: x.image_small, markE6: BigInt(x.mark_e6) }));
}

export interface PrizeCard {
  prizeId: string;
  marketId: string;
  symbol: string;
  displayName: string;
  imageSmall: string | null;
  valueE6: string; // oracle mark at win
}
export interface PackRipResult {
  duplicate: boolean;
  playId: string;
  tier: number;
  bandIndex: number;
  card: PrizeCard;
  balanceE6: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

/** Pick the revealed card: a weighted band (cursor 0), then a card within it (cursor 1). Empty band ->
 *  any featured card, so a play never fails for lack of a card in some range. */
function revealCard(
  seed: SeedRow,
  bands: PackBand[],
  pool: CardRow[],
): { card: CardRow; bandIndex: number } {
  const bandIndex = weightedPick(seed.server_seed, seed.client_seed, seed.nonce, 0, bands.map((b) => b.weight));
  const band = bands[bandIndex];
  const lo = usdc(band.minUsd);
  const hi = usdc(band.maxUsd);
  const eligible = pool.filter((c) => c.markE6 >= lo && c.markE6 <= hi);
  const from = eligible.length > 0 ? eligible : pool;
  const card = from[rollInt(seed.server_seed, seed.client_seed, seed.nonce, 1, from.length)];
  return { card, bandIndex };
}

/**
 * Open a pack: idempotently anchor the play, debit the tier price into GAME_POOL, run the provably-fair
 * reveal, and record the won card (held). Broadcasts the rip to the live feed (+ a chat BIG WIN on a big
 * pull) after commit. A replayed idempotency key returns the original reveal without charging again.
 */
export async function openPack(
  db: Db,
  userId: string,
  opts: { tier: number; idempotencyKey: string },
): Promise<PackRipResult> {
  if (!config.gamesEnabled) throw GAMES_OFF();
  const cfg = packRipConfig();
  if (!cfg.enabled) throw GAMES_OFF();
  const tier = cfg.tiers.find((t) => t.price === opts.tier);
  if (!tier) throw new HttpError(400, 'unknown pack tier');
  const price = usdc(tier.price);

  const out = await db.tx(async (q): Promise<PackRipResult> => {
    const playId = randomUUID();
    const ins = await q.query<{ id: string }>(
      `INSERT INTO game_plays(id, game_type, user_id, idempotency_key, wager_uusdc)
       VALUES($1, 'pack-rip', $2, $3, $4)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [playId, userId, opts.idempotencyKey, price.toString()],
    );
    if (!ins.rows[0]) {
      // Replay: a duplicate request returns the original reveal (no second charge).
      const ex = await q.query<{ result: unknown; server_seed_hash: string; client_seed: string; nonce: number }>(
        `SELECT result, server_seed_hash, client_seed, nonce::int AS nonce FROM game_plays WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, opts.idempotencyKey],
      );
      const row = ex.rows[0];
      const res = (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as { tier: number; bandIndex: number; card: PrizeCard };
      const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      return {
        duplicate: true,
        playId: '',
        tier: res.tier,
        bandIndex: res.bandIndex,
        card: res.card,
        balanceE6: (await getBalance(q, coll)).toString(),
        serverSeedHash: row.server_seed_hash,
        clientSeed: row.client_seed,
        nonce: row.nonce,
      };
    }

    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const lock = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
    const available = lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n;
    if (available < price) throw new HttpError(400, 'insufficient balance', 'insufficient_balance');

    const pool = await featuredCards(q);
    if (pool.length === 0) throw new HttpError(503, 'no cards available to rip yet');

    const poolAcct = await getOrCreateSystemAccount(q, 'GAME_POOL');
    const txnId = await postTxn(q, {
      reason: 'GAME_WAGER',
      refType: 'game_play',
      refId: playId,
      entries: [
        { accountId: coll, amount: -price },
        { accountId: poolAcct, amount: price },
      ],
    });

    const seed = await ensureSeedForUpdate(q, userId);
    await q.query(`UPDATE game_seeds SET nonce = nonce + 1 WHERE user_id = $1`, [userId]);

    const { card, bandIndex } = revealCard(seed, tier.bands, pool);
    const prizeId = randomUUID();
    await q.query(
      `INSERT INTO game_prizes(id, play_id, user_id, market_id, value_e6) VALUES($1, $2, $3, $4, $5)`,
      [prizeId, playId, userId, card.id, card.markE6.toString()],
    );

    const prizeCard: PrizeCard = {
      prizeId,
      marketId: card.id,
      symbol: card.symbol,
      displayName: card.displayName,
      imageSmall: card.imageSmall,
      valueE6: card.markE6.toString(),
    };
    await q.query(
      `UPDATE game_plays SET result = $1, server_seed_hash = $2, client_seed = $3, nonce = $4, txn_id = $5 WHERE id = $6`,
      [JSON.stringify({ tier: tier.price, bandIndex, card: prizeCard }), seed.server_seed_hash, seed.client_seed, seed.nonce, txnId, playId],
    );

    return {
      duplicate: false,
      playId,
      tier: tier.price,
      bandIndex,
      card: prizeCard,
      balanceE6: (available - price).toString(),
      serverSeedHash: seed.server_seed_hash,
      clientSeed: seed.client_seed,
      nonce: seed.nonce,
    };
  });

  if (!out.duplicate) {
    // A chat failure can never roll back a play (drop.ts discipline): broadcast best-effort.
    await broadcastRip(db, userId, out, cfg.bigWinUsd).catch(() => {});
  }
  return out;
}

/** Live-feed broadcast for a rip; a pull worth >= bigWinUsd also fires a chat BIG WIN. */
async function broadcastRip(db: Db, userId: string, res: PackRipResult, bigWinUsd: number): Promise<void> {
  const u = await db.query<{ dn: string | null; pk: string }>(`SELECT display_name AS dn, solana_pubkey AS pk FROM users WHERE id = $1`, [userId]);
  const handle = u.rows[0] ? handleFor(u.rows[0].dn, u.rows[0].pk) : 'someone';
  publish('games', 'play', {
    id: res.playId,
    game: 'pack-rip',
    handle,
    tier: res.tier,
    marketId: res.card.marketId,
    symbol: res.card.symbol,
    displayName: res.card.displayName,
    imageSmall: res.card.imageSmall,
    valueE6: res.card.valueE6,
    at: new Date().toISOString(),
  });
  if (BigInt(res.card.valueE6) >= usdc(bigWinUsd)) {
    await emitGameWinEvent(db, { userId, marketId: res.card.marketId, payoutE6: BigInt(res.card.valueE6), game: 'Pack Rip' });
  }
}

export interface HeldPrize {
  prizeId: string;
  marketId: string;
  symbol: string;
  displayName: string;
  imageSmall: string | null;
  valueE6: string; // CURRENT live mark
  wonValueE6: string; // mark at win
}

/** The caller's still-held (unsold, unkept) prizes, valued at the live mark — the "your pulls" list. */
export async function listHeldPrizes(db: Db, userId: string): Promise<HeldPrize[]> {
  const r = await db.query<{ id: string; market_id: string; symbol: string; display_name: string; image_small: string | null; won: string; mark: string | null }>(
    `SELECT p.id, p.market_id, m.symbol, m.display_name, m.image_small, p.value_e6::text AS won,
            (SELECT mark_price_e6::text FROM marks WHERE market_id = p.market_id ORDER BY computed_at DESC, id DESC LIMIT 1) AS mark
       FROM game_prizes p JOIN markets m ON m.id = p.market_id
      WHERE p.user_id = $1 AND p.status = 'held' ORDER BY p.created_at DESC`,
    [userId],
  );
  return r.rows.map((x) => ({
    prizeId: x.id,
    marketId: x.market_id,
    symbol: x.symbol,
    displayName: x.display_name,
    imageSmall: x.image_small,
    valueE6: x.mark ?? x.won,
    wonValueE6: x.won,
  }));
}

export interface SellBackResult {
  prizeId: string;
  payoutE6: string;
  balanceE6: string;
}

/**
 * Sell a held prize back for USDC at the live mark minus the buyback spread, capped at maxPrize. Pays
 * out of GAME_POOL (must hold the float). Idempotent on the prize's status (a re-sell is rejected).
 */
export async function sellBackPrize(db: Db, userId: string, prizeId: string): Promise<SellBackResult> {
  if (!config.gamesEnabled) throw GAMES_OFF();
  const cfg = packRipConfig();

  const out = await db.tx(async (q) => {
    const pr = await q.query<{ id: string; market_id: string; status: string }>(
      `SELECT id, market_id, status FROM game_prizes WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [prizeId, userId],
    );
    if (!pr.rows[0]) throw new HttpError(404, 'prize not found');
    if (pr.rows[0].status !== 'held') throw new HttpError(409, 'prize already settled');

    const mk = await q.query<{ mark: string }>(
      `SELECT mark_price_e6::text AS mark FROM marks WHERE market_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`,
      [pr.rows[0].market_id],
    );
    if (!mk.rows[0]) throw new HttpError(503, 'no live price for this card');
    const mark = BigInt(mk.rows[0].mark);
    const cap = usdc(cfg.maxPrizeUsd);
    let payout = (mark * BigInt(10_000 - cfg.buybackSpreadBps)) / 10_000n;
    if (payout > cap) payout = cap;

    const poolAcct = await getOrCreateSystemAccount(q, 'GAME_POOL');
    const poolBal = await getBalance(q, poolAcct);
    if (poolBal < payout) throw new HttpError(503, 'prize pool is being topped up — try again shortly');

    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const txnId = await postTxn(q, {
      reason: 'GAME_PRIZE',
      refType: 'game_prize',
      refId: prizeId,
      entries: [
        { accountId: poolAcct, amount: -payout },
        { accountId: coll, amount: payout },
      ],
    });
    await q.query(`UPDATE game_prizes SET status = 'sold', sell_value_e6 = $2, txn_id = $3, settled_at = now() WHERE id = $1`, [prizeId, payout.toString(), txnId]);
    return { payout, balanceE6: (await getBalance(q, coll)).toString() };
  });

  publish('games', 'settle', { prizeId, payoutE6: out.payout.toString() });
  return { prizeId, payoutE6: out.payout.toString(), balanceE6: out.balanceE6 };
}

export interface GamesView {
  enabled: boolean; // master GAMES_ENABLED gate
  games: { id: string; name: string; type: string; enabled: boolean; tiers?: number[]; buybackSpreadBps?: number }[];
}

/**
 * Seed the GAME_POOL bankroll so prizes can be paid out. Play-money only: it credits GAME_POOL from
 * FAUCET_SOURCE (the same fountain the faucet uses). Real funds seed the pool from treasury/fees through
 * the custody admin surface instead, so this is blocked when REAL_FUNDS is on.
 */
export async function seedGamePool(db: Db, amountUsd: number): Promise<{ poolE6: string }> {
  if (config.realFunds) throw new HttpError(403, 'seed the GAME_POOL from treasury/fees when REAL_FUNDS is on');
  const amount = usdc(amountUsd);
  if (amount <= 0n) throw new HttpError(400, 'amount must be positive');
  const poolE6 = await db.tx(async (q) => {
    const faucet = await getOrCreateSystemAccount(q, 'FAUCET_SOURCE');
    const pool = await getOrCreateSystemAccount(q, 'GAME_POOL');
    await postTxn(q, {
      reason: 'GAME_POOL_SEED',
      entries: [
        { accountId: faucet, amount: -amount },
        { accountId: pool, amount },
      ],
    });
    return getBalance(q, pool);
  });
  return { poolE6: poolE6.toString() };
}

/** Public games list + per-game config (drives the lobby). */
export function gamesView(): GamesView {
  const pr = packRipConfig();
  return {
    enabled: config.gamesEnabled,
    games: [
      {
        id: 'pack-rip',
        name: 'Pack Rip',
        type: 'casino',
        enabled: config.gamesEnabled && pr.enabled,
        tiers: pr.tiers.map((t) => t.price),
        buybackSpreadBps: pr.buybackSpreadBps,
      },
    ],
  };
}
