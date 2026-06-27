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
const { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn } = await import('./ledger.ts');
const { lpDeposit, getLpPosition } = await import('./lp.ts');
const { earnGold } = await import('./gold.ts');

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

test('listCustomers surfaces deposits, withdrawals, pending, funding paid, and unrealized P/L', async () => {
  const userId = await newUser('wallet-pk-3', 'deposit-addr-3', 3);
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 2_000_000n, leverage: 5, idempotencyKey: randomUUID() });

  // a credited $50 deposit, a confirmed $20 withdrawal, a $5 pending withdrawal
  await db.query(
    `INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, usdc_credited_e6, status)
     VALUES($1,$2,$3,'USDC',50000000,50000000,'credited')`,
    [randomUUID(), userId, 'sig-' + randomUUID()],
  );
  const wd = (amount: number, status: string) =>
    db.query(
      `INSERT INTO withdrawals(id, user_id, dest_address, amount_e6, status, idempotency_key)
       VALUES($1,$2,'dest',$3,$4,$5)`,
      [randomUUID(), userId, amount, status, randomUUID()],
    );
  await wd(20_000_000, 'confirmed');
  await wd(5_000_000, 'requested');

  // a $3 funding charge on their collateral (negative = they paid), posted as a balanced txn
  await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
    await postTxn(q, {
      reason: 'FUNDING', refType: 'position', refId: 'test-funding',
      entries: [{ accountId: coll, amount: -3_000_000n }, { accountId: lp, amount: 3_000_000n }],
    });
  });

  const { customers } = await listCustomers(db, { limit: 200, offset: 0, sort: 'joined' });
  const row = customers.find((c) => c.userId === userId)!;
  assert.equal(row.depositsE6, '50000000', '$50 credited deposit');
  assert.equal(row.withdrawalsE6, '20000000', '$20 confirmed withdrawal');
  assert.equal(row.pendingWithdrawalsE6, '5000000', '$5 pending withdrawal');
  assert.equal(row.fundingPaidE6, '3000000', '$3 funding paid (positive)');
  assert.equal(row.pnlE6, '0', 'no closes -> realized P/L is 0');
  assert.ok(typeof row.upnlE6 === 'string', 'unrealized P/L is reported for the open position');
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

test("listCustomers surfaces each customer's LP-pool stake (lpE6), matching the per-user valuation", async () => {
  const userId = await newUser('wallet-pk-lp', 'deposit-addr-lp', 7);
  await lpDeposit(db, userId, 300_000_000n); // move $300 of the $10k faucet into the LP pool
  const { customers } = await listCustomers(db, { limit: 200, offset: 0, sort: 'joined' });
  const row = customers.find((c) => c.userId === userId)!;
  const direct = await getLpPosition(db, userId);
  assert.equal(row.lpE6, direct.valueUusdc, 'lpE6 matches the canonical getLpPosition value');
  assert.ok(BigInt(row.lpE6) >= 300_000_000n, 'at least the $300 deposited');
  assert.equal(BigInt(row.freeE6), 10_000_000_000n - 300_000_000n, 'free collateral dropped by the LP deposit');
});

test('listCustomers surfaces NET Gold earned (PACK_OPEN_EARN minus reversals; spends excluded)', async () => {
  const userId = await newUser('wallet-pk-gold', 'deposit-addr-gold', 9);
  await earnGold(db, userId, 25_000n, 'PACK_OPEN_EARN');
  await earnGold(db, userId, 5_000n, 'PACK_OPEN_EARN');
  // a refunded open reverses its earn → REDUCES "earned"
  await db.query(`INSERT INTO gold_ledger(id, user_id, delta, reason) VALUES($1,$2,$3,'PACK_OPEN_EARN_REVERSAL')`, [randomUUID(), userId, '-5000']);
  // a pay-with-Gold spend (negative) must NOT reduce "earned"
  await db.query(`INSERT INTO gold_ledger(id, user_id, delta, reason) VALUES($1,$2,$3,'PACK_BUY_GOLD')`, [randomUUID(), userId, '-1000']);
  // a spend-refund is POSITIVE but is NOT an open-earn → must also be excluded (this is what the old delta>0 filter got wrong)
  await db.query(`INSERT INTO gold_ledger(id, user_id, delta, reason) VALUES($1,$2,$3,'PACK_REFUND_GOLD')`, [randomUUID(), userId, '1000']);

  const { customers } = await listCustomers(db, { limit: 200, offset: 0, sort: 'joined' });
  const row = customers.find((c) => c.userId === userId)!;
  assert.equal(row.goldEarned, '25000', '30000 earned − 5000 reversal = 25000; the −1000 spend AND the +1000 spend-refund are both excluded');

  // a customer who never touched gacha shows 0, not null
  const noGold = customers.find((c) => c.pubkey === 'wallet-pk-1')!;
  assert.equal(noGold.goldEarned, '0', 'no gold ledger rows -> 0');
});
