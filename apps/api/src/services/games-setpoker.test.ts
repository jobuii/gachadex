import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.GAMES_ENABLED = 'true';

const { getDb } = await import('../db/client.ts');
const { migrate } = await import('../db/migrate.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');
const { dealHand, swapCard, settleHand, getOpenHand, setPokerEv } = await import('./games-setpoker.ts');
const { sellBackPrize, rotateClientSeed } = await import('./games.ts');
const { setSetPokerConfig, setPackRipConfig } = await import('./game-config.ts');
const { weightedPick, rollInt, verify } = await import('./game-fairness.ts');

const db = await getDb();
await migrate();

const ANTE = 25;
const SWAP_FEE = 5;
const SPREAD_BPS = 1200;
await setSetPokerConfig(db, {
  enabled: true, anteUsd: ANTE, swapFeeUsd: SWAP_FEE, maxSwaps: 3,
  buybackSpreadBps: SPREAD_BPS, maxPrizeUsd: 5000, bigWinUsd: 1_000_000,
  bands: [{ minUsd: 0, maxUsd: 1000, weight: 1 }],
});
// Give Pack Rip a DIFFERENT spread so the win test proves a Set Poker prize sells at SET POKER's terms.
await setPackRipConfig(db, { buybackSpreadBps: 3000 });

async function newUser(faucetUsd = 10_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, faucetUsd);
  return id;
}
async function featuredCard(symbol: string, markUsd: number): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO markets(id, kind, game, symbol, display_name, status, tradeable, featured) VALUES($1,'card','pokemon',$2,$3,'active',true,true)`,
    [id, symbol, symbol],
  );
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1,$2,$2)`, [id, usdc(markUsd).toString()]);
  return id;
}

const CARD_HI = await featuredCard('CARD-HI', 100);
const CARD_LO = await featuredCard('CARD-LO', 10);
await featuredCard('CARD-MID', 30);
const { seedGamePool } = await import('./games.ts');
await seedGamePool(db, 50_000);

// Insert an open hand directly so a deterministic win/loss can be settled (deal is symmetric/random).
async function craftOpenHand(userId: string, player: [string, number][], house: [string, number][]): Promise<void> {
  const card = (mid: string, v: number) => ({ marketId: mid, symbol: 'X', displayName: 'X', imageSmall: null, valueE6: usdc(v).toString(), fair: { drawIndex: 0, bandWeights: [1], bandIndex: 0, candidateCount: 1, cardIndex: 0 } });
  const p = player.map(([m, v]) => card(m, v));
  const h = house.map(([m, v]) => card(m, v));
  const hand = {
    status: 'open', anteUsd: ANTE, swapFeeUsd: SWAP_FEE, maxSwaps: 3, player: p, house: h,
    playerTotalE6: p.reduce((a, c) => a + BigInt(c.valueE6), 0n).toString(),
    houseTotalE6: h.reduce((a, c) => a + BigInt(c.valueE6), 0n).toString(),
    swaps: 0, drawCount: 10,
  };
  await db.query(
    `INSERT INTO game_plays(id, game_type, user_id, idempotency_key, wager_uusdc, result, server_seed_hash, client_seed, nonce)
     VALUES($1,'set-poker',$2,$3,$4,$5,'hash','cs',0)`,
    [randomUUID(), userId, randomUUID(), usdc(ANTE).toString(), JSON.stringify(hand)],
  );
}

test('dealing charges the ante, deals five-vs-five, and keeps the ledger balanced', async () => {
  const user = await newUser();
  const h = await dealHand(db, user, randomUUID());
  assert.equal(h.status, 'open');
  assert.equal(h.player.length, 5);
  assert.equal(h.house.length, 5);
  assert.equal(h.balanceE6, (usdc(10_000) - usdc(ANTE)).toString(), 'ante debited');
  assert.equal((await getUserBalances(db, user)).availableUusdc, usdc(10_000) - usdc(ANTE));
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after a deal');
});

test('a replayed deal key returns the same hand without charging twice', async () => {
  const user = await newUser();
  const key = randomUUID();
  const first = await dealHand(db, user, key);
  const replay = await dealHand(db, user, key);
  assert.equal(replay.playId, first.playId, 'same hand on replay');
  assert.equal((await getUserBalances(db, user)).availableUusdc, usdc(10_000) - usdc(ANTE), 'charged exactly one ante');
});

test('only one hand may be open at a time', async () => {
  const user = await newUser();
  await dealHand(db, user, randomUUID());
  await assert.rejects(dealHand(db, user, randomUUID()), /open hand/, 'a second deal is refused while a hand is open');
});

test('swapping charges the fee, increments the swap count, and enforces maxSwaps', async () => {
  const user = await newUser();
  await dealHand(db, user, randomUUID());
  let bal = usdc(10_000) - usdc(ANTE);
  for (let i = 1; i <= 3; i++) {
    const r = await swapCard(db, user, 0, randomUUID());
    bal -= usdc(SWAP_FEE);
    assert.equal(r.swaps, i, 'swap count increments');
    assert.equal(r.balanceE6, bal.toString(), 'swap fee debited');
  }
  await assert.rejects(swapCard(db, user, 0, randomUUID()), /no swaps left/, 'maxSwaps is enforced');
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after swaps');
});

test('a repeated swap idempotency key does not charge twice', async () => {
  const user = await newUser();
  await dealHand(db, user, randomUUID());
  const key = randomUUID();
  const first = await swapCard(db, user, 1, key);
  const replay = await swapCard(db, user, 1, key);
  assert.equal(replay.swaps, first.swaps, 'same swap count');
  assert.equal(replay.balanceE6, first.balanceE6, 'no second swap fee');
});

test('retrying any earlier swap key is idempotent — not only the most recent', async () => {
  const user = await newUser();
  await dealHand(db, user, randomUUID());
  const keyA = randomUUID();
  const keyB = randomUUID();
  await swapCard(db, user, 0, keyA);
  const b = await swapCard(db, user, 1, keyB);
  const retryA = await swapCard(db, user, 0, keyA); // a delayed retry of the FIRST swap, after a later one
  assert.equal(retryA.swaps, b.swaps, 'the earlier swap is not re-applied');
  assert.equal(retryA.balanceE6, b.balanceE6, 'no second fee charged for the earlier swap');
});

test('settle targets a specific hand by playId for an idempotent retry', async () => {
  const user = await newUser();
  const h1 = await dealHand(db, user, randomUUID());
  const s1 = await settleHand(db, user, h1.playId);
  assert.equal(s1.playId, h1.playId);
  const h2 = await dealHand(db, user, randomUUID());
  await settleHand(db, user, h2.playId);
  const retry1 = await settleHand(db, user, h1.playId);
  assert.equal(retry1.playId, h1.playId, 'the specific hand is returned, not merely the latest settled');
});

test('settling is idempotent and keeps the ledger balanced', async () => {
  const user = await newUser();
  await dealHand(db, user, randomUUID());
  const s1 = await settleHand(db, user);
  assert.equal(s1.status, 'settled');
  const s2 = await settleHand(db, user);
  assert.equal(s2.playId, s1.playId, 'a settled hand returns the same outcome');
  assert.equal(s2.won, s1.won);
  assert.equal(await getOpenHand(db, user), null, 'no open hand remains');
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after settle');
});

test('a winning hand (player sum > house) awards the highest card, sellable for USDC', async () => {
  const user = await newUser();
  await craftOpenHand(user, [[CARD_HI, 100], [CARD_HI, 100], [CARD_HI, 100], [CARD_HI, 100], [CARD_HI, 100]], [[CARD_LO, 10], [CARD_LO, 10], [CARD_LO, 10], [CARD_LO, 10], [CARD_LO, 10]]);
  const s = await settleHand(db, user);
  assert.equal(s.won, true, 'player total $500 beats house $50');
  assert.equal(s.prize?.marketId, CARD_HI, 'the highest card is the prize');
  const before = (await getUserBalances(db, user)).availableUusdc;
  const sell = await sellBackPrize(db, user, s.prize.prizeId);
  const expected = (usdc(100) * BigInt(10_000 - SPREAD_BPS)) / 10_000n; // Set Poker's 12%, NOT Pack Rip's 30%
  assert.equal(sell.payoutE6, expected.toString(), 'sell-back uses the prize’s snapshotted Set Poker spread');
  assert.equal((await getUserBalances(db, user)).availableUusdc, before + expected);
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after the prize sell-back');
});

test('a losing hand (ties go to the house) awards no prize', async () => {
  const user = await newUser();
  await craftOpenHand(user, [[CARD_LO, 10], [CARD_LO, 10], [CARD_LO, 10], [CARD_LO, 10], [CARD_LO, 10]], [[CARD_HI, 100], [CARD_HI, 100], [CARD_HI, 100], [CARD_HI, 100], [CARD_HI, 100]]);
  const s = await settleHand(db, user);
  assert.equal(s.won, false);
  assert.equal(s.prize, undefined, 'no prize on a loss');
});

test('rotating the client seed is blocked while a Set Poker hand is open', async () => {
  const user = await newUser();
  await dealHand(db, user, randomUUID());
  await assert.rejects(rotateClientSeed(db, user, 'mid-hand-seed'), /open Set Poker hand/);
  await settleHand(db, user);
  const rot = await rotateClientSeed(db, user, 'after-settle'); // allowed once settled
  assert.equal(rot.clientSeed, 'after-settle');
});

test('each dealt card is independently verifiable from the recorded fair trail', async () => {
  const user = await newUser();
  await dealHand(db, user, randomUUID());
  // Settle so we can rotate + reveal the server seed the deal used.
  await settleHand(db, user);
  const row = await db.query(`SELECT result, server_seed_hash, client_seed, nonce::int AS nonce FROM game_plays WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [user]);
  const hand = row.rows[0].result;
  const clientSeed = row.rows[0].client_seed;
  const nonce = row.rows[0].nonce;
  const rot = await rotateClientSeed(db, user, 'reveal-seed');
  assert.ok(verify(rot.revealedServerSeed, row.rows[0].server_seed_hash), 'revealed seed matches the deal commitment');
  for (const c of [...hand.player, ...hand.house]) {
    const f = c.fair;
    const band = weightedPick(rot.revealedServerSeed, clientSeed, nonce, 2 * f.drawIndex, f.bandWeights);
    assert.equal(band, f.bandIndex, `band recomputes for draw ${f.drawIndex}`);
    const idx = rollInt(rot.revealedServerSeed, clientSeed, nonce, 2 * f.drawIndex + 1, f.candidateCount);
    assert.equal(idx, f.cardIndex, `card recomputes for draw ${f.drawIndex}`);
  }
});

test('setPokerEv returns a sane Monte-Carlo estimate against the live pool', async () => {
  const ev = await setPokerEv(db);
  assert.ok(ev.eligibleBands >= 1 && ev.poolSize >= 3);
  assert.equal(ev.samples, 4000);
  assert.ok(ev.winRatePct >= 0 && ev.winRatePct <= 100);
  assert.equal(typeof ev.houseEdgeBps, 'number');
});
