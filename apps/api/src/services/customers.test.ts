import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.FEE_BPS = '100'; // 1% so an open trade produces a measurable fee

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { openPosition } = await import('./engine.ts');
const { listCustomers } = await import('./customers.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

await ingest(db, async () => fromPokemontcg([
  { id: 'card-c', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-c')!;

async function newUser(pubkey: string, depositAddr: string, index: number): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, pubkey]);
  await db.query(`INSERT INTO deposit_addresses(user_id, address, derivation_index) VALUES($1, $2, $3)`, [id, depositAddr, index]);
  await creditFaucet(db, id, 10_000);
  return id;
}

test('listCustomers joins wallet + deposit address + balances and aggregates volume/fees/open positions', async () => {
  const userId = await newUser('wallet-pk-1', 'deposit-addr-1', 1);
  // a 5-unit 10x long: locks $500 margin and pays a 1% open fee on the traded notional
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });

  const { customers, total } = await listCustomers(db, { limit: 50, offset: 0, sort: 'volume' });
  assert.ok(total >= 1);
  const row = customers.find((c) => c.userId === userId);
  assert.ok(row, 'the customer is listed');
  assert.equal(row!.pubkey, 'wallet-pk-1');
  assert.equal(row!.depositAddress, 'deposit-addr-1');
  assert.equal(row!.openPositions, 1);
  assert.equal(row!.lockedE6, (500_000_000n).toString()); // $500 margin locked in the open trade

  // volume = the open fill's notional (> 0); fees paid = 1% of that volume
  assert.ok(BigInt(row!.volumeE6) > 0n);
  assert.equal(BigInt(row!.feesE6), BigInt(row!.volumeE6) / 100n);

  // value is conserved: free + locked margin + fees paid == the $10,000 faucet
  assert.equal(BigInt(row!.freeE6) + BigInt(row!.lockedE6) + BigInt(row!.feesE6), 10_000_000_000n);
});

test('listCustomers paginates and sorts (by volume desc) across users', async () => {
  // a second user who trades MORE -> must sort above the first and split across pages of 1
  const big = await newUser('wallet-pk-2', 'deposit-addr-2', 2);
  await openPosition(db, big, { marketId: market.id, side: 'long', qtyE6: 9_000_000n, leverage: 5, idempotencyKey: randomUUID() });

  const page1 = await listCustomers(db, { limit: 1, offset: 0, sort: 'volume' });
  assert.equal(page1.customers.length, 1);
  assert.equal(page1.customers[0].pubkey, 'wallet-pk-2'); // highest volume first
  assert.ok(page1.total >= 2);

  const page2 = await listCustomers(db, { limit: 1, offset: 1, sort: 'volume' });
  assert.equal(page2.customers.length, 1);
  assert.notEqual(page2.customers[0].userId, page1.customers[0].userId); // a different user on page 2
});
