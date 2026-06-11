import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { TcgPriceLookupClient, TPL_BATCH_SIZE } = await import('./tcgpricelookup.ts');
const { ProviderLimiter } = await import('./limiter.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

// A no-wait limiter so client tests exercise HTTP behavior, not pacing (pacing has its own tests).
const instantLimiter = { acquire: async () => {} } as unknown as InstanceType<typeof ProviderLimiter>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function clientWith(responses: Response[], calls: string[] = []) {
  const fetchFn = (async (url: any) => {
    calls.push(String(url));
    const r = responses.shift();
    if (!r) throw new Error('test fetch exhausted');
    return r;
  }) as typeof fetch;
  return { client: new TcgPriceLookupClient(db, { fetchFn, limiter: instantLimiter, retryBaseMs: 1 }), calls };
}

test('searchCards builds the query and returns the envelope', async () => {
  const { client, calls } = clientWith([json({ data: [{ id: 'x', name: 'Pika' }], total: 1, limit: 20, offset: 0 })]);
  const page = await client.searchCards({ q: 'pikachu', game: 'pokemon', limit: 20 }, 'search');
  assert.equal(page.total, 1);
  assert.equal(page.data[0].name, 'Pika');
  assert.match(calls[0], /\/cards\/search\?q=pikachu&game=pokemon&limit=20$/);
});

test('getCardsByIds chunks at the provider batch max', async () => {
  const ids = Array.from({ length: TPL_BATCH_SIZE * 2 + 5 }, (_, i) => `id-${i}`);
  const { client, calls } = clientWith([
    json({ data: ids.slice(0, 20).map((id) => ({ id })), total: 20 }),
    json({ data: ids.slice(20, 40).map((id) => ({ id })), total: 20 }),
    json({ data: ids.slice(40).map((id) => ({ id })), total: 5 }),
  ]);
  const cards = await client.getCardsByIds(ids, 'refresh');
  assert.equal(cards.length, ids.length);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes(encodeURIComponent('id-0,')), 'first chunk in first call');
  assert.ok(calls[2].includes(encodeURIComponent('id-40')), 'tail chunk in last call');
});

test('429 is retried (honoring retry-after) and then succeeds', async () => {
  const { client, calls } = clientWith([
    json({ error: 'rate limited' }, 429, { 'retry-after': '0' }),
    json({ data: [], total: 0 }),
  ]);
  const page = await client.searchCards({ q: 'x' }, 'search');
  assert.equal(page.total, 0);
  assert.equal(calls.length, 2);
});

test('a Cloudflare challenge page (HTML 403) is treated as retryable', async () => {
  const challenge = new Response('<html>challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  const { client, calls } = clientWith([challenge, json({ data: [], total: 0 })]);
  await client.searchCards({ q: 'x' }, 'search');
  assert.equal(calls.length, 2);
});

test('a non-retryable status throws immediately (no blind retries)', async () => {
  const { client, calls } = clientWith([json({ error: 'unauthorized' }, 401)]);
  await assert.rejects(client.searchCards({ q: 'x' }, 'search'), /tcgpricelookup 401/);
  assert.equal(calls.length, 1);
});

test('attempts are bounded: persistent 5xx exhausts retries and throws', async () => {
  const { client, calls } = clientWith([json({}, 503), json({}, 503), json({}, 503), json({}, 503), json({}, 503)]);
  await assert.rejects(client.searchCards({ q: 'x' }, 'search'), /tcgpricelookup 503/);
  assert.equal(calls.length, 4); // maxAttempts default
});
