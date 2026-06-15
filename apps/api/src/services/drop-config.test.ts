import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
// Distinct from the code defaults so we prove the config env drives the knob defaults.
process.env.DROP_INTERVAL_MIN = '30';
process.env.DROP_HOUSE_FLOOR_USD = '300';
process.env.DROP_GDEX_MIN = '750000';

const { config } = await import('../config.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { dropConfigView, setDropConfig, loadDropConfig, getDropView, GDEX_MINT } = await import('./drop-config.ts');
const { getOrCreateSystemAccount, getBalance, postTxn } = await import('./ledger.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('defaults come from config / constants before any override', () => {
  assert.equal(config.dropIntervalMin, 30);
  const v = dropConfigView();
  assert.equal(v.intervalMin, 30);
  assert.equal(v.houseFloorUsd, 300);
  assert.equal(v.gdexMin, 750_000);
  assert.deepEqual(v.packTiers, [250, 500, 1000]); // code default
  assert.equal(v.gdexMint, GDEX_MINT);
  assert.equal(v.defaults.intervalMin, 30); // the panel still sees the env default
});

test('setDropConfig persists a partial update; untouched knobs are unchanged + survive a reload', async () => {
  const r = await setDropConfig(db, { houseFloorUsd: 1000 });
  assert.equal(r.houseFloorUsd, 1000);
  assert.equal(r.intervalMin, 30); // not in the patch -> unchanged
  await loadDropConfig(db); // a fresh DB read keeps the override
  assert.equal(dropConfigView().houseFloorUsd, 1000);
  assert.equal(dropConfigView().intervalMin, 30);
});

test('pack tiers normalize (sorted + deduped) on set and round-trip through the DB on load', async () => {
  await setDropConfig(db, { packTiers: [1000, 250, 500, 250] });
  assert.deepEqual(dropConfigView().packTiers, [250, 500, 1000]);
  await loadDropConfig(db); // reloads from the stored "250,500,1000" string -> re-parsed by the same validator
  assert.deepEqual(dropConfigView().packTiers, [250, 500, 1000]);
});

test('validation rejects bad knobs', async () => {
  await assert.rejects(setDropConfig(db, { intervalMin: 0 }), />= 1/);
  await assert.rejects(setDropConfig(db, { houseFloorUsd: -5 }), />= 0/);
  await assert.rejects(setDropConfig(db, { packTiers: [0] }), /positive/);
  await assert.rejects(setDropConfig(db, { packTiers: [] }), /list 1/);
});

test('getDropView reads the DROP_POOL bucket balance + returns empty rounds (Phase 1)', async () => {
  const empty = await getDropView(db);
  assert.equal(empty.bucketE6, '0'); // nothing funded yet
  assert.deepEqual(empty.recentRounds, []);

  // Fund the pot with a balanced ledger txn (treasury -> DROP_POOL) and confirm the view reflects it.
  const pool = await getOrCreateSystemAccount(db, 'DROP_POOL');
  const treasury = await getOrCreateSystemAccount(db, 'TREASURY_USDC');
  await db.tx(async (q) =>
    postTxn(q, {
      reason: 'test_drop_fund',
      entries: [
        { accountId: pool, amount: 5_000_000n },
        { accountId: treasury, amount: -5_000_000n },
      ],
    }),
  );
  assert.equal((await getDropView(db)).bucketE6, '5000000');
  assert.equal(await getBalance(db, pool), 5_000_000n);
});
