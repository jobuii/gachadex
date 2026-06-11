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
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { lpDeposit } = await import('./lp.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');
const { reconcile } = await import('./reconcile.ts');

await initDb();
const db = await getDb();
await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(fund: number): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, fund);
  return id;
}

// Deep LP so skew premium stays small and trades don't self-liquidate.
const lpUser = await newUser(900_000);
await lpDeposit(db, lpUser, 900_000_000_000n);

test('concurrent opens/closes serialize correctly and the ledger stays balanced', async () => {
  const traders = await Promise.all(Array.from({ length: 8 }, () => newUser(10_000)));

  // fire 8 opens at once (4 long, 4 short) on the same market
  await Promise.all(
    traders.map((u, i) =>
      openPosition(db, u, {
        marketId: market.id,
        side: i % 2 === 0 ? 'long' : 'short',
        qtyE6: 2_000_000n,
        leverage: 5,
        idempotencyKey: randomUUID(),
      }),
    ),
  );

  const openCounts = await Promise.all(traders.map((u) => getUserPositions(db, u).then((p) => p.length)));
  assert.deepEqual(openCounts, Array(8).fill(1), 'each trader has exactly one open position');

  let report = await reconcile(db);
  assert.equal(report.ok, true, 'balanced after concurrent opens: ' + JSON.stringify(report));

  // fire 8 closes at once
  await Promise.all(
    traders.map(async (u) => {
      const [p] = await getUserPositions(db, u);
      if (p) await closePosition(db, u, { positionId: p.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
    }),
  );

  const remaining = (await Promise.all(traders.map((u) => getUserPositions(db, u)))).flat();
  assert.equal(remaining.length, 0, 'all positions closed');

  report = await reconcile(db);
  assert.equal(report.ok, true, 'balanced after concurrent closes: ' + JSON.stringify(report));
});

test('duplicate idempotency keys never double-execute under contention', async () => {
  const u = await newUser(10_000);
  const key = randomUUID();
  // fire the same order 4 times concurrently
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      openPosition(db, u, { marketId: market.id, side: 'long', qtyE6: 2_000_000n, leverage: 5, idempotencyKey: key }),
    ),
  );
  assert.ok(results.some((r) => r.status === 'fulfilled'), 'at least one succeeded');
  const positions = await getUserPositions(db, u);
  assert.equal(positions.length, 1, 'exactly one position despite duplicate keys');
  assert.equal(positions[0].qtyE6, (2_000_000n).toString(), 'opened exactly once');

  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report));
});

after(async () => {
  await closeDb();
});
