import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.FEE_BPS = '10'; // charge a commission so the Commission tx type is exercised (open + close)

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');
const { getOrderHistory, getTradeHistory, getTransactionHistory, getPositionHistory } = await import('./history.ts');

await initDb();
const db = await getDb();
await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, 10_000);
  return id;
}

test('history endpoints reflect a full open -> close lifecycle', async () => {
  const u = await newUser();
  await openPosition(db, u, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  const [pos] = await getUserPositions(db, u);
  await closePosition(db, u, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });

  const orders = await getOrderHistory(db, u);
  assert.equal(orders.length, 2, 'one open + one close order');
  assert.equal(orders.find((o) => !o.reduceOnly)!.side, 'Buy', 'opening a long is a Buy');
  assert.equal(orders.find((o) => o.reduceOnly)!.side, 'Sell', 'closing a long is a Sell');

  const trades = await getTradeHistory(db, u);
  assert.equal(trades.length, 2);
  assert.ok(trades.every((t) => t.role === 'Taker'));
  assert.ok(trades.some((t) => BigInt(t.feeUusdc) > 0n), 'a commission fee was recorded');

  const txns = await getTransactionHistory(db, u);
  const types = new Set(txns.map((t) => t.type));
  assert.ok(types.has('Transfer'), 'faucet shows as Transfer');
  assert.ok(types.has('Realized PNL'), 'close PnL shows as Realized PNL');
  assert.ok(types.has('Commission'), 'fees show as Commission');
  // internal collateral<->margin moves must NOT leak into the account ledger view
  assert.ok(txns.every((t) => ['Transfer', 'Realized PNL', 'Funding Fee', 'Commission'].includes(t.type)));

  const hist = await getPositionHistory(db, u);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].side, 'Long');
  assert.equal(hist[0].status, 'closed');
  assert.equal(hist[0].closedQtyE6, (5_000_000n).toString());
  assert.ok(hist[0].avgCloseE6 && BigInt(hist[0].avgCloseE6) > 0n, 'avg close price derived from reduce-only fills');
});

after(async () => {
  await closeDb();
});
