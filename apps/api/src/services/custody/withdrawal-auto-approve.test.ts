import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { willAutoApprove } = await import('./withdrawals.ts');
const { setWithdrawalAutoProcess } = await import('../withdrawal-config.ts');
const { usdc } = await import('../../money.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('willAutoApprove: only when the toggle is ON and the amount is within the auto-approve cap', async () => {
  // toggle OFF -> never auto, even a tiny amount
  await setWithdrawalAutoProcess(db, false);
  assert.equal(await willAutoApprove(db, usdc(100)), false);

  // toggle ON, under the $1,000 default cap, not frozen -> auto-approves
  await setWithdrawalAutoProcess(db, true);
  assert.equal(await willAutoApprove(db, usdc(100)), true);

  // toggle ON but over the cap -> still manual
  assert.equal(await willAutoApprove(db, usdc(5000)), false);
});
