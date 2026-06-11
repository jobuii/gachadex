import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.FEE_BPS = '5'; // a non-zero default to prove getFeeBps starts from config

const { config } = await import('../config.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { getFeeBps, loadFee, setFee, feeView, validateFeeBps } = await import('./fees.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('default fee comes from config (FEE_BPS) before any override', () => {
  assert.equal(config.feeBps, 5);
  assert.equal(getFeeBps(), 5);
});

test('setFee persists an override; getFeeBps + a fresh load reflect it', async () => {
  await setFee(db, 25);
  assert.equal(getFeeBps(), 25); // synchronous read updated immediately
  assert.equal(await loadFee(db), 25); // and it survives a re-read from the DB
  assert.equal(feeView().bps, 25);
  assert.equal(feeView().default, config.feeBps); // the panel still sees the config default
});

test('validation rejects negatives, non-integers, and > 1000 bps (10%)', () => {
  assert.throws(() => validateFeeBps(-1), /non-negative/);
  assert.throws(() => validateFeeBps(2.5), /integer/);
  assert.throws(() => validateFeeBps(1001), /1000/);
});

test('a garbage stored value falls back to the config default on load (no poisoned fee)', async () => {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('trading_fee_bps', 'NaN')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  assert.equal(await loadFee(db), config.feeBps);
});
