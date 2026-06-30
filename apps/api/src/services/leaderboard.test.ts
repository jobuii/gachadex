import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { getLeaderboard } = await import('./leaderboard.ts');
const { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn } = await import('./ledger.ts');
const { usdc } = await import('../money.ts');
type AccountType = Parameters<typeof getOrCreateSystemAccount>[1];

await initDb();
const db = await getDb();
after(() => closeDb());

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}

/** Post one balanced collateral movement for `userId` (a system account is the counterparty). A negative
 *  `amount` debits the user's collateral (e.g. a withdrawal or a tip). */
async function flow(userId: string, reason: string, counterparty: AccountType, amount: bigint): Promise<void> {
  await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const other = await getOrCreateSystemAccount(q, counterparty);
    await postTxn(q, { reason, entries: [{ accountId: coll, amount }, { accountId: other, amount: -amount }] });
  });
}

async function standingFor(userId: string): Promise<{ realized: string; equity: string }> {
  const { you } = await getLeaderboard(db, { viewerUserId: userId });
  assert.ok(you, 'user should appear on the leaderboard');
  return { realized: you.realizedPnlUusdc, equity: you.equityUusdc };
}

test('a real USDC deposit is NOT counted as realized PnL (the reported bug)', async () => {
  const u = await newUser();
  await flow(u, 'DEPOSIT', 'TREASURY_USDC', usdc(5000)); // deposits $5k, never trades
  const { realized, equity } = await standingFor(u);
  assert.equal(realized, '0'); // before the fix this was the full 5,000,000 (deposit shown as profit)
  assert.equal(equity, usdc(5000).toString()); // the deposit IS equity — it's just not PnL
});

test('leaderboard surfaces lifetime Gold earned (PACK_OPEN_EARN minus reversals; spends excluded)', async () => {
  const u = await newUser();
  const gl = (delta: string, reason: string) =>
    db.query(`INSERT INTO gold_ledger(id, user_id, delta, reason) VALUES($1,$2,$3,$4)`, [randomUUID(), u, delta, reason]);
  await gl('25000', 'PACK_OPEN_EARN');
  await gl('5000', 'PACK_OPEN_EARN');
  await gl('-5000', 'PACK_OPEN_EARN_REVERSAL'); // a refunded open claws its earn back → reduces "earned"
  await gl('-1000', 'PACK_BUY_GOLD'); // a pay-with-Gold spend must NOT reduce lifetime "earned"
  const { you } = await getLeaderboard(db, { viewerUserId: u });
  assert.ok(you);
  assert.equal(you.goldEarned, '25000', '30000 earned − 5000 reversal = 25000; the −1000 spend is excluded');

  // a user who never earned Gold shows 0, not null
  const u2 = await newUser();
  const { you: you2 } = await getLeaderboard(db, { viewerUserId: u2 });
  assert.equal(you2!.goldEarned, '0', 'no gold_ledger rows -> 0');
});

test('realized PnL nets deposits, withdrawals, and DROP tips — leaving only trading P/L', async () => {
  const u = await newUser();
  await flow(u, 'DEPOSIT', 'TREASURY_USDC', usdc(1000)); // +1000 external capital in
  await flow(u, 'REALIZED_PNL', 'LP_POOL', usdc(200)); //   +200 booked trading gain (a real PnL leg)
  await flow(u, 'WITHDRAWAL', 'TREASURY_USDC', usdc(-300)); // -300 capital out
  await flow(u, 'DROP_TIP', 'DROP_POOL', usdc(-50)); //      -50 tipped into the pot
  // cash = 1000+200-300-50 = 850 ; net capital in = 1000-300-50 = 650 ; realized = 850-650 = 200
  const { realized } = await standingFor(u);
  assert.equal(realized, usdc(200).toString());
});

test('faucet + referral credits still net out (play-money regression)', async () => {
  const u = await newUser();
  await flow(u, 'FAUCET', 'FAUCET_SOURCE', usdc(1000));
  await flow(u, 'REFERRAL_BONUS', 'FAUCET_SOURCE', usdc(500));
  const { realized } = await standingFor(u);
  assert.equal(realized, '0'); // play-money grants are not PnL, same as before
});
