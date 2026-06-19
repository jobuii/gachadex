import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { houseEconomics } = await import('./house-pnl.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const dep = (uid: string, usd: number, status: string) =>
  db.query(
    `INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, usdc_credited_e6, status, observed_at)
     VALUES($1, $2, $3, 'USDC', $4, $4, $5, now())`,
    [randomUUID(), uid, 'sig-' + randomUUID(), usdc(usd).toString(), status],
  );
const wd = (uid: string, usd: number, status: string) =>
  db.query(
    `INSERT INTO withdrawals(id, user_id, dest_address, amount_e6, status, idempotency_key, requested_at)
     VALUES($1, $2, 'dest', $3, $4, $5, now())`,
    [randomUUID(), uid, usdc(usd).toString(), status, randomUUID()],
  );

test('houseEconomics totals only credited deposits + confirmed withdrawals', async () => {
  const uid = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [uid, 'pk-' + uid.slice(0, 8)]);
  await dep(uid, 500, 'credited'); // counts
  await dep(uid, 999, 'detected'); // NOT yet credited — excluded
  await wd(uid, 200, 'confirmed'); // counts
  await wd(uid, 888, 'requested'); // pending — excluded from the lifetime total

  const e = await houseEconomics(db);
  assert.equal(e.totalDepositsE6, usdc(500).toString());
  assert.equal(e.totalWithdrawalsE6, usdc(200).toString());
});
