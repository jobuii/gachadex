import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Force tips CLOSED (the prod-safe default). Set explicitly so dotenv (which loads the dev .env where
// DROP_TIPS_ENABLED may be on) can't override it — dotenv never overwrites an already-set process.env var.
process.env.DROP_TIPS_ENABLED = 'false';
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { tipDrop } = await import('./drop.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('tips are rejected when DROP_TIPS_ENABLED is off (the default)', async () => {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await assert.rejects(tipDrop(db, id, 1_000_000n), /not open/);
});
