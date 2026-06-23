import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.FEE_BPS = '10'; // open/close commission, exercised by the fill test

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { openPosition, placeRestingOrder, cancelRestingOrder, getUserRestingOrders, checkRestingOrderTriggers, getUserPositions, closePosition } =
  await import('./engine.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();

// one card market priced at $1000/unit
await ingest(db, async () =>
  fromPokemontcg([{ id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } }]),
);
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, 10_000);
  return id;
}
const U = (n: number) => usdc(n).toString();
const E6 = (n: number) => BigInt(n) * 1_000_000n;
const LIMIT = { kind: 'limit' as const, reduceOnly: false };
async function closeAll(userId: string): Promise<void> {
  for (const p of await getUserPositions(db, userId)) {
    await closePosition(db, userId, { positionId: p.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  }
}

test('placing a limit reserves margin (equity stays whole); cancelling refunds it', async () => {
  const userId = await newUser();
  const { id } = await placeRestingOrder(db, userId, { ...LIMIT, marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, triggerPriceE6: E6(900), idempotencyKey: randomUUID() });

  // reserve at basis max(trigger 900, mark 1000) = 1000: $5000 notional / 10x = $500
  let b = await getUserBalances(db, userId);
  assert.equal(b.availableUusdc.toString(), U(9_500));
  assert.equal(b.reservedUusdc.toString(), U(500));
  assert.equal(b.equityUusdc.toString(), U(10_000)); // equity unchanged — collateral just moved into the reserve
  const open = await getUserRestingOrders(db, userId);
  assert.equal(open.length, 1);
  assert.equal(open[0].id, id);

  assert.equal((await cancelRestingOrder(db, userId, id)).cancelled, true);
  b = await getUserBalances(db, userId);
  assert.equal(b.availableUusdc.toString(), U(10_000));
  assert.equal(b.reservedUusdc.toString(), U(0));
  assert.equal((await getUserRestingOrders(db, userId)).length, 0);
});

test('a triggered limit fills at the mark; the reserve becomes the one position-margin charge', async () => {
  const userId = await newUser();
  // long limit at $1100 (>= the $1000 mark) -> immediately due
  await placeRestingOrder(db, userId, { ...LIMIT, marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, triggerPriceE6: E6(1100), idempotencyKey: randomUUID() });

  const filled = await checkRestingOrderTriggers(db, market.id);
  assert.equal(filled, 1);

  const [pos] = await getUserPositions(db, userId);
  assert.ok(pos, 'a position opened');
  assert.equal(pos.qtyE6, '5000000');
  assert.equal(pos.avgEntryE6, E6(1000).toString()); // filled at the $1000 mark, NOT the $1100 limit

  const b = await getUserBalances(db, userId);
  assert.equal(b.lockedMarginUusdc.toString(), U(500)); // $5000 / 10x
  assert.equal(b.reservedUusdc.toString(), U(0)); // reserve fully released
  assert.equal(b.availableUusdc.toString(), U(9_495)); // 10000 - 500 margin - $5 open fee  (one charge, not two)
  assert.equal((await getUserRestingOrders(db, userId)).length, 0);

  await closePosition(db, userId, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() }); // reset OI
});

test('a limit does not fire until the mark crosses it', async () => {
  const userId = await newUser();
  // long limit at $900 (< $1000 mark): fills only when mark <= 900, so not now
  await placeRestingOrder(db, userId, { ...LIMIT, marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, triggerPriceE6: E6(900), idempotencyKey: randomUUID() });
  assert.equal(await checkRestingOrderTriggers(db, market.id), 0);
  assert.equal((await getUserRestingOrders(db, userId)).length, 1); // still resting
  assert.equal((await getUserPositions(db, userId)).length, 0);
});

test('placement is idempotent on the key', async () => {
  const userId = await newUser();
  const key = randomUUID();
  const a = await placeRestingOrder(db, userId, { ...LIMIT, marketId: market.id, side: 'long', qtyE6: 1_000_000n, leverage: 5, triggerPriceE6: E6(900), idempotencyKey: key });
  const b = await placeRestingOrder(db, userId, { ...LIMIT, marketId: market.id, side: 'long', qtyE6: 1_000_000n, leverage: 5, triggerPriceE6: E6(900), idempotencyKey: key });
  assert.equal(a.id, b.id);
  assert.equal(b.duplicate, true);
  assert.equal((await getUserRestingOrders(db, userId)).length, 1);
});

test('rejects a reserve beyond the user balance', async () => {
  const userId = await newUser();
  await assert.rejects(
    placeRestingOrder(db, userId, { ...LIMIT, marketId: market.id, side: 'long', qtyE6: 5_000_000_000n, leverage: 1, triggerPriceE6: E6(900), idempotencyKey: randomUUID() }),
    /insufficient balance/,
  );
});

test('SL/TP / reduce-only are rejected in P1 (limit-open only)', async () => {
  const userId = await newUser();
  await assert.rejects(
    placeRestingOrder(db, userId, { marketId: market.id, kind: 'stop_loss', reduceOnly: true, positionId: 'x', triggerPriceE6: E6(900), idempotencyKey: randomUUID() }),
    /only limit/,
  );
});

test('a short limit fills at the mark (mark-or-better) when the index is at/above its price', async () => {
  const userId = await newUser();
  // short limit at $900 (<= the $1000 index): a short fires when index >= trigger -> immediately due
  await placeRestingOrder(db, userId, { ...LIMIT, marketId: market.id, side: 'short', qtyE6: 5_000_000n, leverage: 10, triggerPriceE6: E6(900), idempotencyKey: randomUUID() });
  assert.equal(await checkRestingOrderTriggers(db, market.id), 1);
  const [pos] = await getUserPositions(db, userId);
  assert.equal(pos.side, 'short');
  assert.equal(pos.qtyE6, '5000000');
  assert.equal(pos.avgEntryE6, E6(1000).toString()); // sold at the $1000 mark, better than the $900 limit
  assert.equal((await getUserRestingOrders(db, userId)).length, 0);
  await closeAll(userId);
});

test('a triggered limit that hits an opposing position is cancelled + refunded (terminal, not stuck)', async () => {
  const userId = await newUser();
  await openPosition(db, userId, { marketId: market.id, side: 'short', qtyE6: 1_000_000n, leverage: 5, idempotencyKey: randomUUID() });
  const before = await getUserBalances(db, userId); // after the short is open
  // a long limit that fires now (index 1000 <= trigger 1100) but hits the opposite-side guard at fill
  await placeRestingOrder(db, userId, { ...LIMIT, marketId: market.id, side: 'long', qtyE6: 1_000_000n, leverage: 5, triggerPriceE6: E6(1100), idempotencyKey: randomUUID() });
  assert.equal(await checkRestingOrderTriggers(db, market.id), 0); // not filled
  assert.equal((await getUserRestingOrders(db, userId)).length, 0); // cancelled (terminal), not left resting
  const after = await getUserBalances(db, userId);
  assert.equal(after.availableUusdc.toString(), before.availableUusdc.toString()); // reserve refunded in full
  assert.equal((await getUserPositions(db, userId)).filter((p) => p.side === 'long').length, 0); // no long opened
  await closeAll(userId);
});

test('the ledger reconciles after place / cancel / fill activity', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
