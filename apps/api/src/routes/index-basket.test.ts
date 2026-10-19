import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// R9 public index basket view + R11 hand removal routes (index rules v3).
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.ADMIN_API_KEY = 'test-admin-key-with-enough-entropy-123456';

const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { config } = await import('../config.ts');
const { ingest } = await import('../services/oracle.ts');

await initDb();
const db = await getDb();
const app = await buildServer();
after(async () => { await app.close(); await closeDb(); });
const KEY = { 'x-admin-key': process.env.ADMIN_API_KEY };
const oc = (id: string, usd: number) => ({
  game: 'pokemon', symbol: `pokemon:${id}`, cardId: id, displayName: `${id} #1`, variant: null, imageSmall: null,
  rawE6: BigInt(usd * 1e6), observedAt: new Date(), featured: true, productType: 'single' as const,
});

test('GET /markets/index-basket: members after launch; 400 on a bad symbol, 404 on an unknown index', async () => {
  const cfg = config as { indexRulesV3: boolean };
  await ingest(db, async () => [oc('a', 100), oc('b', 50)]);
  cfg.indexRulesV3 = true;
  try {
    await ingest(db, async () => [oc('a', 101), oc('b', 50)]);
  } finally {
    cfg.indexRulesV3 = false;
  }
  const r = await app.inject({ method: 'GET', url: '/markets/index-basket?symbol=INDEX:gp-top-100' });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(v.basket, 'pokemon:top-100', 'a G&P series shows its shared basket');
  assert.deepEqual(v.members.map((m: { name: string }) => m.name), ['a #1', 'b #1']);
  assert.equal(v.governed, true);
  assert.equal(v.upcoming, null);
  // weights from each series' snapshot (a $101, b $50): GJ price share, G&P equal, Pokedaq capped (2 names < 20 → equal)
  const weights = async (sym: string) =>
    (await app.inject({ method: 'GET', url: `/markets/index-basket?symbol=${sym}` })).json().members
      .map((m: { name: string; priceE6: string | null; weightBps: number | null }) => [m.name, m.priceE6, m.weightBps]);
  assert.deepEqual(await weights('INDEX:top-100'), [['a #1', '101000000', 6688], ['b #1', '50000000', 3311]]);
  assert.deepEqual(await weights('INDEX:gp-top-100'), [['a #1', '101000000', 5000], ['b #1', '50000000', 5000]]);
  assert.deepEqual(await weights('INDEX:pdq-top-100'), [['a #1', '101000000', 5000], ['b #1', '50000000', 5000]]);
  // two pending changes (an apply delayed past the next publish): upcoming = the earliest, the one applied next
  for (const d of ['2027-02-01', '2027-01-01']) {
    await db.query(
      `INSERT INTO index_changes(basket, change_date, reference_at, effective_at, adds, removes, reserves) VALUES('pokemon:top-100', $1, $1::date, $1::date + interval '3 days', '{}', '[]', '{}')`,
      [d],
    );
  }
  assert.equal((await app.inject({ method: 'GET', url: '/markets/index-basket?symbol=INDEX:top-100' })).json().upcoming.changeDate, '2027-01-01');
  assert.equal((await app.inject({ method: 'GET', url: '/markets/index-basket?symbol=nope' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/markets/index-basket?symbol=INDEX:missing' })).statusCode, 404);
});

test('D: the change log shows what the change itself did, and announced cards that did not join', async () => {
  const id = (sym: string) => db.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [sym]).then((r) => r.rows[0].id);
  await ingest(db, async () => [oc('c', 30), oc('d', 20), oc('e', 10)]);
  const [a, b, c, d, e] = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => id(`pokemon:${x}`)));
  const at = new Date('2027-03-04T06:00:00Z');
  await db.query(
    `INSERT INTO index_changes(basket, change_date, reference_at, published_at, effective_at, applied_at, adds, removes, reserves)
     VALUES('pokemon:top-100', '2027-03-01', '2027-03-01', '2027-03-01T06:00:00Z', $1, $1, $2, $3, '{}')`,
    [at, [c, d, e], JSON.stringify([{ marketId: b, reason: 'rank' }])],
  );
  // (the first test switched the rules off, closing every list — so the rows are written out here)
  const row = (m: string, joined: string | Date, reason: string, left: Date | null = null, why: string | null = null) =>
    db.query(`INSERT INTO index_members(basket, market_id, joined_at, left_at, join_reason, leave_reason) VALUES('pokemon:top-100', $1, $2, $3, $4, $5)`, [m, joined, left, reason, why]);
  await row(c, at, 'change'); // joined by the change
  await row(e, '2027-03-02T06:00:00Z', 'refill'); // an announced add already in (joined as a refill meanwhile)
  await row(b, '2027-02-04T06:00:00Z', 'change', at, 'rank'); // removed by the change
  await row(a, '2027-02-04T06:00:00Z', 'change', at, 'hand'); // removed for a cause in the same pass — not the change
  const v = (await app.inject({ method: 'GET', url: '/markets/index-basket?symbol=INDEX:top-100' })).json();
  const entry = v.log.find((l: { changeDate: string }) => l.changeDate === '2027-03-01');
  const ids = (xs: { marketId: string }[]) => xs.map((x) => x.marketId);
  assert.deepEqual(ids(entry.adds), [c], 'only the card the change added');
  assert.deepEqual(entry.removes.map((x: { marketId: string; reason: string }) => [x.marketId, x.reason]), [[b, 'rank']], 'not the same-pass hand removal');
  assert.deepEqual(ids(entry.notJoined), [d], 'd did not join; e was already in');
});

test('admin index exclusions: key required, reason required, add → list → clear', async () => {
  const mid = (await db.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = 'pokemon:a'`)).rows[0].id;
  assert.equal((await app.inject({ method: 'GET', url: '/admin/index-exclusions' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/index-exclusions', headers: KEY, payload: { marketId: mid } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/index-exclusions', headers: KEY, payload: { marketId: 'nope', reason: 'x' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/index-exclusions', headers: KEY, payload: { marketId: mid, reason: 'fake sale' } })).statusCode, 200);
  const list = (await app.inject({ method: 'GET', url: '/admin/index-exclusions', headers: KEY })).json();
  assert.deepEqual(list.exclusions.map((e: { reason: string }) => e.reason), ['fake sale']);
  const cleared = (await app.inject({ method: 'DELETE', url: `/admin/index-exclusions/${mid}`, headers: KEY })).json();
  assert.equal(cleared.cleared, true);
});
