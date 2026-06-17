import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getJpyUsd, resetFxCache } = await import('./fx.ts');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => resetFxCache());

test('getJpyUsd returns rates.USD (USD per 1 JPY) and hits the Frankfurter latest endpoint', async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: any) => {
    calls.push(String(url));
    return json({ amount: 1, base: 'JPY', date: '2026-06-16', rates: { USD: 0.0067 } });
  }) as typeof fetch;
  const rate = await getJpyUsd({ fetchFn });
  assert.equal(rate, 0.0067);
  assert.match(calls[0], /\/v1\/latest\?base=JPY&symbols=USD$/);
});

test('getJpyUsd caches within the TTL and refetches once it expires', async () => {
  let n = 0;
  const fetchFn = (async () => json({ rates: { USD: 0.005 + 0.001 * ++n } })) as typeof fetch;
  let clock = 1_000_000;
  const now = () => clock;
  assert.equal(await getJpyUsd({ fetchFn, now }), 0.006); // first fetch (n=1)
  assert.equal(await getJpyUsd({ fetchFn, now }), 0.006); // cached — no second fetch
  clock += 13 * 60 * 60 * 1000; // advance past the 12h TTL
  assert.equal(await getJpyUsd({ fetchFn, now }), 0.007); // refetched (n=2)
});

test('getJpyUsd serves the last good rate when a refresh fails, and null when it never had one', async () => {
  // never had a rate + failure → null (caller halts the JPY card rather than mis-pricing)
  assert.equal(await getJpyUsd({ fetchFn: (async () => json({ error: 'down' }, 503)) as typeof fetch }), null);

  // prime a good rate, then a failing refresh past the TTL serves the stale-but-real rate
  let clock = 0;
  const now = () => clock;
  let ok = true;
  const fetchFn = (async () => (ok ? json({ rates: { USD: 0.0064 } }) : json({}, 500))) as typeof fetch;
  assert.equal(await getJpyUsd({ fetchFn, now }), 0.0064);
  ok = false;
  clock += 13 * 60 * 60 * 1000;
  assert.equal(await getJpyUsd({ fetchFn, now }), 0.0064, 'a stale real rate beats no rate');
});

test('getJpyUsd rejects a non-positive or malformed rate (returns null, not a bad number)', async () => {
  assert.equal(await getJpyUsd({ fetchFn: (async () => json({ rates: { USD: 0 } })) as typeof fetch }), null);
  resetFxCache();
  assert.equal(await getJpyUsd({ fetchFn: (async () => json({ rates: {} })) as typeof fetch }), null);
});
