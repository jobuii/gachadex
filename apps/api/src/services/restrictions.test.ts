import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { restrictionsReport } = await import('./restrictions.ts');
const { openPosition } = await import('./engine.ts');
const { creditFaucet } = await import('./faucet.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

// A provider-native OracleCard with an explicit confidence flag (what fromTplCard emits).
const card = (confident: boolean) => ({
  game: 'mtg',
  symbol: 'mtg:gate-x',
  cardId: 'gate-x',
  tcgplayerId: 999111,
  providerCardId: 'prov-gate-x',
  displayName: 'Gate Test #1',
  variant: 'Standard',
  imageSmall: 'img/x',
  rawE6: 1000n * 1_000_000n, // $1000
  confident,
  featured: false,
});

const marketId = async () => (await listMarketsWithData(db)).find((m) => m.symbol === 'mtg:gate-x')!.id;
const lowConf = async (id: string) =>
  (await db.query<{ low_confidence: boolean }>(`SELECT low_confidence FROM markets WHERE id=$1`, [id])).rows[0].low_confidence;
const eventCount = async (id: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM market_restriction_events WHERE market_id=$1`, [id])).rows[0].n);

test('the confidence gate flips low_confidence, logs only on transitions, and restricts/recovers the market', async () => {
  // first ingest: low confidence -> market restricted + one event
  await ingest(db, async () => [card(false)]);
  const id = await marketId();
  assert.equal(await lowConf(id), true, 'gated on low confidence');
  assert.equal(await eventCount(id), 1, 'one transition logged');

  // re-ingest at the SAME (low) confidence -> no new event (only flips are logged)
  await ingest(db, async () => [card(false)]);
  assert.equal(await eventCount(id), 1, 'no duplicate event when unchanged');

  // restrictionsReport surfaces it both as currently-restricted and as flipped-today
  const r1 = await restrictionsReport(db);
  assert.ok(r1.restricted.some((x) => x.marketId === id), 'listed as restricted now');
  assert.ok(r1.flippedToday.some((x) => x.marketId === id), 'listed as flipped to restricted today');

  // recovery: ingest at high confidence -> unrestricted + a second (recovery) event
  await ingest(db, async () => [card(true)]);
  assert.equal(await lowConf(id), false, 'recovered to tradeable');
  assert.equal(await eventCount(id), 2, 'the recovery transition is logged');
  const r2 = await restrictionsReport(db);
  assert.ok(!r2.restricted.some((x) => x.marketId === id), 'no longer restricted');
});

test('the engine blocks NEW positions on a restricted (low-confidence) market', async () => {
  await ingest(db, async () => [card(false)]); // gate it
  const id = await marketId();
  const userId = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [userId, 'pk-' + userId.slice(0, 8)]);
  await creditFaucet(db, userId, 10_000);

  await assert.rejects(
    openPosition(db, userId, { marketId: id, side: 'long', qtyE6: 1_000_000n, leverage: 2, idempotencyKey: randomUUID() }),
    /restricted|low price confidence/,
    'opening is rejected while restricted',
  );

  // lift the gate -> opening succeeds
  await ingest(db, async () => [card(true)]);
  const ok = await openPosition(db, userId, { marketId: id, side: 'long', qtyE6: 1_000_000n, leverage: 2, idempotencyKey: randomUUID() });
  assert.ok(ok.positionId, 'opens once confidence is restored');
});
