import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { ProviderLimiter, ProviderBudgetError } = await import('./limiter.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('slots are globally paced: N acquires complete spaced by the min interval', async () => {
  const lim = new ProviderLimiter(db, 'pace-test', { minIntervalMs: 60, dailyCap: 1000 });
  const t0 = Date.now();
  const stamps: number[] = [];
  await Promise.all(
    [0, 1, 2].map(() => lim.acquire('refresh').then(() => stamps.push(Date.now() - t0))),
  );
  stamps.sort((a, b) => a - b);
  // 1st slot is immediate; each later slot is >= one interval after the previous (small timer slack)
  assert.ok(stamps[1] - stamps[0] >= 40, `2nd slot too early: ${stamps.join(',')}`);
  assert.ok(stamps[2] - stamps[1] >= 40, `3rd slot too early: ${stamps.join(',')}`);
});

test('priority: a queued user search jumps ahead of queued discovery work', async () => {
  const lim = new ProviderLimiter(db, 'prio-test', { minIntervalMs: 40, dailyCap: 1000 });
  const order: string[] = [];
  // enqueue synchronously: d1 starts the pump; d2 and search wait — search must win the next slot
  const all = Promise.all([
    lim.acquire('discovery').then(() => order.push('d1')),
    lim.acquire('discovery').then(() => order.push('d2')),
    lim.acquire('search').then(() => order.push('search')),
  ]);
  await all;
  assert.deepEqual(order, ['d1', 'search', 'd2']);
});

test('daily ceilings: discovery is refused at its share while search still passes', async () => {
  const lim = new ProviderLimiter(db, 'budget-test', { minIntervalMs: 1, dailyCap: 100 });
  await lim.acquire('search'); // creates the row
  await db.query(`UPDATE provider_rate SET used_today = 60 WHERE key = 'budget-test'`); // discovery ceiling = 60
  await assert.rejects(lim.acquire('discovery'), ProviderBudgetError);
  await lim.acquire('refresh'); // refresh ceiling 90 — still allowed
  await lim.acquire('search'); // search ceiling 100 — still allowed
});

test('the budget day rolls over: yesterday\'s spend does not count today', async () => {
  const lim = new ProviderLimiter(db, 'rollover-test', { minIntervalMs: 1, dailyCap: 100 });
  await lim.acquire('search');
  await db.query(
    `UPDATE provider_rate SET day = CURRENT_DATE - 1, used_today = 99999 WHERE key = 'rollover-test'`,
  );
  await lim.acquire('discovery'); // would be refused without the rollover reset
  const r = await db.query<{ used_today: number }>(
    `SELECT used_today FROM provider_rate WHERE key = 'rollover-test'`,
  );
  assert.equal(r.rows[0].used_today, 1); // reset, then this one claim
});
