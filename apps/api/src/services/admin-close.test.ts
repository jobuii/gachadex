import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { openPosition, getUserPositions } = await import('./engine.ts');
const { adminClosePosition, adminCloseUserPositions, adminCloseAllPositions, PLATFORM_ACTOR } = await import('./admin-close.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

await ingest(db, async () => fromPokemontcg([
  { id: 'ac-card', name: 'AC', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'ac-card')!;

async function newUserWithPosition(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, 10_000);
  await openPosition(db, id, { marketId: market.id, side: 'long', qtyE6: 1_000_000n, leverage: 2, idempotencyKey: randomUUID() });
  return id;
}

test('adminClosePosition closes one position and stamps it as a platform close', async () => {
  const u = await newUserWithPosition();
  const [pos] = await getUserPositions(db, u);
  await adminClosePosition(db, u, pos.id);

  assert.equal((await getUserPositions(db, u)).length, 0, 'position closed');
  const marker = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM orders WHERE user_id=$1 AND actor_pubkey=$2 AND kind='reduce_only'`,
    [u, PLATFORM_ACTOR],
  );
  assert.equal(marker.rows[0].n, '1', 'recorded as a platform (manual) close');
});

test('adminCloseUserPositions closes all of one customer; another customer is untouched', async () => {
  const a = await newUserWithPosition();
  // give A a second position on a different side via a separate market? keep it simple: one each
  const b = await newUserWithPosition();

  const r = await adminCloseUserPositions(db, a);
  assert.equal(r.closed, 1);
  assert.equal(r.failed, 0);
  assert.equal((await getUserPositions(db, a)).length, 0, 'A flat');
  assert.equal((await getUserPositions(db, b)).length, 1, 'B untouched');
});

test('adminCloseAllPositions is a platform-wide kill switch', async () => {
  // some users may carry positions from earlier tests' B; close everything
  const c = await newUserWithPosition();
  const d = await newUserWithPosition();

  const r = await adminCloseAllPositions(db);
  assert.ok(r.closed >= 2, 'closed at least C and D');
  const open = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM positions WHERE status='open'`);
  assert.equal(open.rows[0].n, '0', 'no open positions remain anywhere');
  assert.equal((await getUserPositions(db, c)).length, 0);
  assert.equal((await getUserPositions(db, d)).length, 0);
});
