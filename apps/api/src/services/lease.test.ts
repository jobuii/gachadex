import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { tryAcquireLease, releaseLease } = await import('./lease.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('a free lease is acquired; a valid lease blocks other holders; the holder can renew', async () => {
  assert.equal(await tryAcquireLease(db, 'loop-a', 'instance-1', 60_000), true);
  assert.equal(await tryAcquireLease(db, 'loop-a', 'instance-2', 60_000), false); // held by 1
  assert.equal(await tryAcquireLease(db, 'loop-a', 'instance-1', 60_000), true); // renewal
});

test('an EXPIRED lease is taken over by the next instance', async () => {
  await tryAcquireLease(db, 'loop-b', 'instance-1', 60_000);
  await db.query(`UPDATE worker_leases SET expires_at = now() - interval '1 second' WHERE key = 'loop-b'`);
  assert.equal(await tryAcquireLease(db, 'loop-b', 'instance-2', 60_000), true); // takeover
  assert.equal(await tryAcquireLease(db, 'loop-b', 'instance-1', 60_000), false); // old holder lost it
});

test('release frees the lease immediately (no TTL wait); only the holder can release', async () => {
  await tryAcquireLease(db, 'loop-c', 'instance-1', 60_000);
  await releaseLease(db, 'loop-c', 'instance-2'); // not the holder — no-op
  assert.equal(await tryAcquireLease(db, 'loop-c', 'instance-2', 60_000), false);
  await releaseLease(db, 'loop-c', 'instance-1');
  assert.equal(await tryAcquireLease(db, 'loop-c', 'instance-2', 60_000), true);
});
