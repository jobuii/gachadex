import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { config } = await import('../../config.ts');
const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { getLimits, loadLimits, setLimits, limitsView, validateLimit } = await import('./limits.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('defaults: getLimits matches config before any override', () => {
  const l = getLimits();
  assert.equal(l.hotWalletMaxUsd, config.hotWalletMaxUsd);
  assert.equal(l.hotWalletFloorPct, config.hotWalletFloorPct);
  assert.equal(l.minWithdrawalUsd, config.minWithdrawalUsd);
  assert.equal(l.swapSlippageBps, config.swapSlippageBps);
});

test('setLimits persists overrides; getLimits + a fresh load reflect them; unset keys keep defaults', async () => {
  await setLimits(db, { hotWalletMaxUsd: 50_000, swapSlippageBps: 50 });
  const l = getLimits();
  assert.equal(l.hotWalletMaxUsd, 50_000);
  assert.equal(l.swapSlippageBps, 50);
  assert.equal(l.minWithdrawalUsd, config.minWithdrawalUsd); // untouched -> still the default
  const reloaded = await loadLimits(db); // re-read from the DB (mimics the periodic refresh)
  assert.equal(reloaded.hotWalletMaxUsd, 50_000);
  assert.equal(reloaded.swapSlippageBps, 50);
});

test('limitsView exposes both the current values and the config defaults', () => {
  const v = limitsView();
  assert.equal(v.current.hotWalletMaxUsd, 50_000);
  assert.equal(v.defaults.hotWalletMaxUsd, config.hotWalletMaxUsd);
});

test('validation rejects bad values', async () => {
  assert.throws(() => validateLimit('hotWalletMaxUsd', -1), /non-negative/);
  assert.throws(() => validateLimit('hotWalletMaxUsd', 'abc'), /non-negative/);
  assert.throws(() => validateLimit('hotWalletMaxUsd', 2_000_000_000), /implausibly large/);
  assert.throws(() => validateLimit('swapSlippageBps', 1001), /0-1000/);
  assert.throws(() => validateLimit('swapSlippageBps', 12.5), /0-1000/);
  assert.throws(() => validateLimit('hotWalletFloorPct', 101), /0-100/);
  assert.throws(() => validateLimit('hotWalletFloorPct', 12.5), /0-100/);
  await assert.rejects(() => setLimits(db, {}), /no custody limits/);
  await assert.rejects(() => setLimits(db, { hotWalletMaxUsd: -5 }), /non-negative/);
});

test('a garbage stored value falls back to the default on load (no poisoned limit)', async () => {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('custody_limit:minDepositUsd', 'NaN')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  const l = await loadLimits(db);
  assert.equal(l.minDepositUsd, config.minDepositUsd); // default, not NaN
});
