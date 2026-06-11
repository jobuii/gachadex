import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Enable the MAX_PNL_FACTOR gate for THIS file only (each test file runs in its own process).
// cap = 1% of LP NAV — small enough that one 5-unit long's own-skew profit ($25) trips it.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.MAX_PNL_FACTOR_BPS = '100'; // 1%

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');
const { lpDeposit, getPool } = await import('./lp.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();

// one card market priced at $1000
await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(faucetUsd = 10_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, faucetUsd);
  return id;
}
const long5 = (userId: string) =>
  openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });

let winner = ''; // the trader holding the in-the-money position across tests

test('gate ON + uncapitalized pool: opens are paused until the LP pool is funded', async () => {
  assert.equal((await getPool(db)).navUusdc, '0');
  await assert.rejects(long5(await newUser()), /not capitalized/);
});

test('gate ON: an open under the PnL-factor cap is allowed once the pool is funded', async () => {
  // seed NAV = $1000 -> cap = 1% = $10
  const lp = await newUser(2_000);
  await lpDeposit(db, lp, usdc(1_000));
  assert.equal((await getPool(db)).navUusdc, usdc(1_000).toString());

  winner = await newUser();
  await long5(winner); // liability before this open is 0 (< $10 cap) -> allowed
  const [pos] = await getUserPositions(db, winner);
  assert.equal(pos.qtyE6, (5_000_000n).toString()); // the position opened
  assert.equal((await getPool(db)).navUusdc, usdc(1_000).toString()); // opening doesn't move NAV
});

test('gate ON: opens are paused once pending profit exceeds the cap', async () => {
  // `winner`'s position now owes the pool ~$25 > the $10 cap
  await assert.rejects(long5(await newUser()), /pool risk limit/);
});

test('gate clears after the winning position closes', async () => {
  const [pos] = await getUserPositions(db, winner);
  await closePosition(db, winner, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });

  const fresh = await newUser();
  await long5(fresh); // liability back to 0 -> allowed again
  assert.equal((await getUserPositions(db, fresh)).length, 1);
});

test('reconciler stays balanced after the gate exercises', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
