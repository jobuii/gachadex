import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.WITHDRAWAL_AUTO_PROCESS = 'false'; // boot default for the knob test

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { getCustomerHistory } = await import('./history.ts');
const { getWithdrawalAutoProcess, loadWithdrawalAutoProcess, setWithdrawalAutoProcess } = await import('./withdrawal-config.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('customer history merges deposits + withdrawals reverse-chronologically with signed amounts', async () => {
  const uid = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [uid, 'pk-' + uid.slice(0, 8)]);
  // a $500 credited deposit (older) and a $200 confirmed withdrawal (newer)
  await db.query(
    `INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, usdc_credited_e6, status, observed_at, credited_at)
     VALUES($1, $2, $3, 'USDC', $4, $4, 'credited', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
    [randomUUID(), uid, 'sig-' + randomUUID(), usdc(500).toString()],
  );
  await db.query(
    `INSERT INTO withdrawals(id, user_id, dest_address, amount_e6, status, idempotency_key, requested_at)
     VALUES($1, $2, 'destAddr', $3, 'confirmed', $4, '2026-06-10T00:00:00Z')`,
    [randomUUID(), uid, usdc(200).toString(), randomUUID()],
  );

  const entries = await getCustomerHistory(db, uid);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'Withdrawal'); // 06-10 is newer -> first
  assert.equal(entries[0].amountUusdc, `-${usdc(200).toString()}`); // money out -> negative
  assert.equal(entries[0].detail, 'destAddr');
  assert.equal(entries[1].kind, 'Deposit'); // 06-01
  assert.equal(entries[1].amountUusdc, usdc(500).toString()); // money in -> positive
});

test('withdrawal auto-approval knob persists and round-trips through settings', async () => {
  assert.equal(getWithdrawalAutoProcess(), false); // boot default (env false)
  await setWithdrawalAutoProcess(db, true);
  assert.equal(getWithdrawalAutoProcess(), true);
  assert.equal(await loadWithdrawalAutoProcess(db), true); // a fresh load reads the stored 'true'
  await setWithdrawalAutoProcess(db, false);
  assert.equal(getWithdrawalAutoProcess(), false);
});
