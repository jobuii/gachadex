import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.ORACLE_PRIMARY = 'tcgpricelookup'; // the cutover flag, set BEFORE config loads

const { config } = await import('../../config.ts');
const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { ingest } = await import('../oracle.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('ORACLE_PRIMARY=tcgpricelookup routes ingest to the tracked-universe fetcher', async () => {
  assert.equal(config.oraclePrimary, 'tcgpricelookup');
  // No tracked markets exist -> the tcgpricelookup path returns [] WITHOUT any network call.
  // (The pokemontcg path would attempt a live HTTP fetch here and fail/hang — zero cards proves
  // the flag actually switched the default fetcher.)
  const r = await ingest(db);
  assert.equal(r.cards, 0);
});
