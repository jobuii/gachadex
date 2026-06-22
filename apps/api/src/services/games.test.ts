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
const { openPack, sellBackPrize, seedGamePool, getFairness, rotateClientSeed } = await import('./games.ts');
const { setPackRipConfig } = await import('./game-config.ts');
const { roll, verify, sha256, commitServerSeed } = await import('./game-fairness.ts');

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
