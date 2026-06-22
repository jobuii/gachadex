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
const { gradeOpen, gradeGambleEv } = await import('./games-grade.ts');
const { sellBackPrize, seedGamePool, rotateClientSeed } = await import('./games.ts');
const { setGradeGambleConfig } = await import('./game-config.ts');
const { weightedPick, verify } = await import('./game-fairness.ts');

const db = await getDb();
await migrate();

const SPREAD_BPS = 1200;
const GRADES = [
  { label: 'Raw', multBps: 10_000, weight: 1 },
  { label: 'PSA 10', multBps: 50_000, weight: 1 },
];
await setGradeGambleConfig(db, {
  enabled: true, buybackSpreadBps: SPREAD_BPS, maxPrizeUsd: 5_000_000, bigWinUsd: 1_000_000,
  tiers: [{ price: 25, bands: [{ minUsd: 0, maxUsd: 1000, weight: 1 }] }],
  grades: GRADES,
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
await seedGamePool(db, 5_000_000);

test('grading debits the ante, awards a graded card, and keeps the ledger balanced', async () => {
  const user = await newUser();
  const r = await gradeOpen(db, user, 25, randomUUID());
  assert.equal(r.duplicate, false);
  assert.ok(r.prizeId && r.card.marketId);
  assert.ok(GRADES.some((g) => g.multBps === r.grade.multBps), 'a configured grade was rolled');
  assert.equal(BigInt(r.card.gradedValueE6), (BigInt(r.card.baseValueE6) * BigInt(r.grade.multBps)) / 10_000n, 'graded value = base × grade');
  assert.equal(r.balanceE6, (usdc(10_000) - usdc(25)).toString(), 'ante debited');
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after a grade');
});

test('selling a graded prize back applies the grade multiplier', async () => {
  const user = await newUser();
  const r = await gradeOpen(db, user, 25, randomUUID());
  const base = BigInt(r.card.baseValueE6);
  const expected = (((base * BigInt(r.grade.multBps)) / 10_000n) * BigInt(10_000 - SPREAD_BPS)) / 10_000n;
  const sell = await sellBackPrize(db, user, r.prizeId);
  assert.equal(sell.payoutE6, expected.toString(), 'sell-back = mark × grade × (1 − spread)');
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after the graded sell-back');
});

test('a replayed idempotency key returns the same grade and does not charge twice', async () => {
  const user = await newUser();
  const key = randomUUID();
  const first = await gradeOpen(db, user, 25, key);
  const replay = await gradeOpen(db, user, 25, key);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.prizeId, first.prizeId);
  assert.equal(replay.grade.multBps, first.grade.multBps);
  assert.equal((await getUserBalances(db, user)).availableUusdc, usdc(10_000) - usdc(25), 'charged once');
});

test('the grade roll + base card are independently verifiable from the recorded trail', async () => {
  const user = await newUser();
  const r = await gradeOpen(db, user, 25, randomUUID());
  const row = await db.query<{ result: { fair: { card: { bandWeights: number[]; bandIndex: number; candidateCount: number; cardIndex: number }; gradeWeights: number[]; gradeIndex: number } } }>(
    `SELECT result FROM game_plays WHERE id = $1`, [r.playId],
  );
  const fair = row.rows[0].result.fair;
  const rot = await rotateClientSeed(db, user, 'grade-verify');
  assert.ok(verify(rot.revealedServerSeed, r.serverSeedHash), 'revealed seed matches the play commitment');
  const grade = weightedPick(rot.revealedServerSeed, r.clientSeed, r.nonce, 2, fair.gradeWeights);
  assert.equal(grade, fair.gradeIndex, 'grade index recomputes (cursor 2)');
  assert.equal(GRADES[grade].multBps, r.grade.multBps, 'the rolled grade matches the table');
});

test('reusing an idempotency key from a different game is rejected, not decoded as a grade', async () => {
  const user = await newUser();
  const key = randomUUID();
  await db.query(`INSERT INTO game_plays(id, game_type, user_id, idempotency_key, wager_uusdc) VALUES($1,'pack-rip',$2,$3,$4)`, [randomUUID(), user, key, usdc(25).toString()]);
  await assert.rejects(gradeOpen(db, user, 25, key), /different play/);
});

test('gradeGambleEv reports E[grade multiplier] and a per-tier house edge', async () => {
  const ev = await gradeGambleEv(db);
  assert.equal(ev.expGradeMultBps, 30_000, 'E[mult] = (10000 + 50000)/2 for the two equal-weight grades');
  assert.equal(ev.tiers.length, 1);
  assert.equal(typeof ev.tiers[0].houseEdgeBps, 'number');
  assert.ok(ev.tiers[0].eligibleBands >= 1 && ev.tiers[0].poolSize >= 3);
});
