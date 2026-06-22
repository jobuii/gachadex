import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// In-memory PGlite + the master games gate ON. Must be set before importing config/client.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.GAMES_ENABLED = 'true';

const { getDb } = await import('../db/client.ts');
const { migrate } = await import('../db/migrate.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');
const { openPack, sellBackPrize, seedGamePool, getFairness, rotateClientSeed, packRipEv } = await import('./games.ts');
const { setPackRipConfig } = await import('./game-config.ts');
const { roll, verify, sha256, commitServerSeed, weightedPick, rollInt } = await import('./game-fairness.ts');

const db = await getDb();
await migrate();

// One tier ($25) with a single wide band so the reveal is deterministic over the seeded pool.
const SPREAD_BPS = 1200;
await setPackRipConfig(db, {
  enabled: true,
  buybackSpreadBps: SPREAD_BPS,
  maxPrizeUsd: 5000,
  bigWinUsd: 1_000_000, // high enough that the test never trips the chat broadcast path
  tiers: [{ price: 25, bands: [{ minUsd: 0, maxUsd: 1000, weight: 1 }] }],
});

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

await featuredCard('CARD-A', 10);
await featuredCard('CARD-B', 50);
await featuredCard('CARD-C', 400);
await seedGamePool(db, 50_000);

test('opening a pack debits the wager, awards a card, and keeps the ledger balanced', async () => {
  const user = await newUser();
  const r = await openPack(db, user, { tier: 25, idempotencyKey: randomUUID() });
  assert.equal(r.duplicate, false);
  assert.ok(r.card.prizeId && r.card.marketId);
  assert.equal(r.balanceE6, (usdc(10_000) - usdc(25)).toString(), 'pack price debited from collateral');
  const bal = await getUserBalances(db, user);
  assert.equal(bal.availableUusdc, usdc(10_000) - usdc(25));
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after a rip');
});

test('a replayed idempotency key returns the original reveal and does not charge twice', async () => {
  const user = await newUser();
  const key = randomUUID();
  const first = await openPack(db, user, { tier: 25, idempotencyKey: key });
  const replay = await openPack(db, user, { tier: 25, idempotencyKey: key });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.card.prizeId, first.card.prizeId, 'same prize on replay');
  assert.equal(replay.balanceE6, first.balanceE6, 'no second debit');
  const bal = await getUserBalances(db, user);
  assert.equal(bal.availableUusdc, usdc(10_000) - usdc(25), 'charged exactly once');
});

test('selling a prize back pays mark·(1 − spread), caps at maxPrize, and balances', async () => {
  const user = await newUser();
  const r = await openPack(db, user, { tier: 25, idempotencyKey: randomUUID() });
  const mark = BigInt(r.card.valueE6);
  const expected = (mark * BigInt(10_000 - SPREAD_BPS)) / 10_000n;
  const sell = await sellBackPrize(db, user, r.card.prizeId);
  assert.equal(sell.payoutE6, expected.toString(), 'buyback haircut applied');
  assert.equal(sell.balanceE6, (usdc(10_000) - usdc(25) + expected).toString());
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after a sell-back');
  await assert.rejects(sellBackPrize(db, user, r.card.prizeId), /already settled/, 'a prize cannot be sold twice');
});

test('roll() is deterministic and verify() checks the commitment', () => {
  const a = roll('seed-abc', 'client-1', 7, 0);
  const b = roll('seed-abc', 'client-1', 7, 0);
  assert.equal(a, b, 'same inputs => same float');
  assert.ok(a >= 0 && a < 1);
  assert.notEqual(roll('seed-abc', 'client-1', 7, 0), roll('seed-abc', 'client-1', 7, 1), 'cursor changes the draw');
  const { serverSeed, serverSeedHash } = commitServerSeed();
  assert.ok(verify(serverSeed, serverSeedHash), 'a true seed verifies against its commit');
  assert.ok(!verify(serverSeed, sha256('tampered')), 'a wrong commit is rejected');
});

test('rotating the client seed reveals the prior server seed and commits a new one', async () => {
  const user = await newUser();
  const before = await getFairness(db, user);
  const rot = await rotateClientSeed(db, user, 'my-lucky-seed');
  assert.ok(verify(rot.revealedServerSeed, before.serverSeedHash), 'the revealed seed matches the old commitment');
  assert.equal(rot.clientSeed, 'my-lucky-seed');
  assert.equal(rot.nonce, 0, 'nonce resets on rotation');
  assert.notEqual(rot.serverSeedHash, before.serverSeedHash, 'a fresh server seed is committed');
});

test('a cheap tier never escalates above its richest band ceiling (empty bands are zeroed, not full-pool)', async () => {
  // The $0–5 band is empty vs the pool (cheapest card is $10) and carries 70% weight; the OLD code fell
  // back to the WHOLE pool there and could award the $400 card for a $5 pack. It must now never exceed $60.
  await setPackRipConfig(db, {
    enabled: true, buybackSpreadBps: SPREAD_BPS, maxPrizeUsd: 5000, bigWinUsd: 1_000_000,
    tiers: [{ price: 5, bands: [
      { minUsd: 0, maxUsd: 5, weight: 70 },
      { minUsd: 5, maxUsd: 60, weight: 30 },
    ] }],
  });
  const user = await newUser();
  for (let i = 0; i < 40; i++) {
    const r = await openPack(db, user, { tier: 5, idempotencyKey: randomUUID() });
    assert.ok(BigInt(r.card.valueE6) <= usdc(60), `awarded ${r.card.valueE6} exceeds the $60 ceiling`);
    assert.notEqual(r.card.symbol, 'CARD-C', 'the $400 card is out of range and never awarded');
  }
});

test('packRipEv reports per-tier house edge and flags an underpriced tier', async () => {
  // Pool cards in [0,60] are $10 + $50 → avg $30; with a 12% spread the expected payout is $26.40.
  await setPackRipConfig(db, {
    enabled: true, buybackSpreadBps: 1200, maxPrizeUsd: 5000, bigWinUsd: 1_000_000,
    tiers: [
      { price: 100, bands: [{ minUsd: 0, maxUsd: 60, weight: 1 }] }, // $100 in, ~$26.40 out → house-positive
      { price: 5, bands: [{ minUsd: 0, maxUsd: 60, weight: 1 }] },   // $5 in, ~$26.40 out → house-NEGATIVE
    ],
  });
  const ev = await packRipEv(db);
  const t100 = ev.find((e) => e.tier === 100)!;
  const t5 = ev.find((e) => e.tier === 5)!;
  assert.equal(t100.expectedPayoutE6, usdc(26.4).toString(), 'expected payout = avg·(1 − spread)');
  assert.ok(t100.houseEdgeBps > 0 && t100.eligibleBands === 1, 'a well-priced tier is house-positive');
  assert.ok(t5.houseEdgeBps < 0, 'an underpriced tier is flagged house-negative');
});

test('a rip is independently verifiable from the recorded fair trail', async () => {
  await setPackRipConfig(db, {
    enabled: true, buybackSpreadBps: SPREAD_BPS, maxPrizeUsd: 5000, bigWinUsd: 1_000_000,
    tiers: [{ price: 25, bands: [
      { minUsd: 0, maxUsd: 30, weight: 3 },
      { minUsd: 30, maxUsd: 1000, weight: 1 },
    ] }],
  });
  const user = await newUser();
  const r = await openPack(db, user, { tier: 25, idempotencyKey: randomUUID() });
  const rot = await rotateClientSeed(db, user, 'verify-seed'); // reveals the server seed the play used
  assert.ok(verify(rot.revealedServerSeed, r.serverSeedHash), 'revealed seed matches the play commitment');
  const band = weightedPick(rot.revealedServerSeed, r.clientSeed, r.nonce, 0, r.fair.bandWeights);
  assert.equal(band, r.fair.bandIndex, 'band index recomputes from the public trail');
  const cardIdx = rollInt(rot.revealedServerSeed, r.clientSeed, r.nonce, 1, r.fair.candidateCount);
  assert.equal(cardIdx, r.fair.cardIndex, 'card index recomputes from the public trail');
});

test('an all-empty tier falls back to the deterministic cheapest card with a self-consistent trail', async () => {
  // No featured card is <= $1, so every band is empty → the bounded cheapest-card fallback ($10 CARD-A).
  await setPackRipConfig(db, {
    enabled: true, buybackSpreadBps: SPREAD_BPS, maxPrizeUsd: 5000, bigWinUsd: 1_000_000,
    tiers: [{ price: 25, bands: [{ minUsd: 0, maxUsd: 1, weight: 1 }] }],
  });
  const user = await newUser();
  const r = await openPack(db, user, { tier: 25, idempotencyKey: randomUUID() });
  assert.equal(r.bandIndex, -1, 'fallback path taken');
  assert.equal(r.card.symbol, 'CARD-A', 'the cheapest card ($10) is awarded — never an expensive one');
  assert.equal(r.fair.candidateCount, 1);
  assert.equal(r.fair.cardIndex, 0);
  const rot = await rotateClientSeed(db, user, 'fallback-seed');
  assert.equal(rollInt(rot.revealedServerSeed, r.clientSeed, r.nonce, 1, r.fair.candidateCount), r.fair.cardIndex, 'fallback trail recomputes');
});
