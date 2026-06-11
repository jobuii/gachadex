import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.FEE_BPS = '5'; // a non-zero default to prove getFeeBps starts from config
process.env.LIQ_FEE_BPS = '75'; // a distinct default to prove the liq knob is independent of the trading fee

const { config } = await import('../config.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { getFeeBps, loadFee, setFee, feeView, validateFeeBps, getLiqFeeBps, loadLiqFee, setLiqFee, liqFeeView } =
  await import('./fees.ts');

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

test('the liquidation penalty is an independent live knob: default from config, override persists', async () => {
  assert.equal(config.liqFeeBps, 75);
  assert.equal(getLiqFeeBps(), 75); // starts from config (LIQ_FEE_BPS), separate from the trading fee

  const tradingBefore = getFeeBps();
  await setLiqFee(db, 250);
  assert.equal(getLiqFeeBps(), 250); // synchronous read updated immediately
  assert.equal(await loadLiqFee(db), 250); // survives a DB re-read
  assert.equal(liqFeeView().bps, 250);
  assert.equal(liqFeeView().default, config.liqFeeBps);

  assert.equal(getFeeBps(), tradingBefore); // setting the liq knob does NOT move the trading fee
});
