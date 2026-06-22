import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.SCRYDEX_WEBHOOK_SECRET = 'whsec_route_test_secret';

const { buildServer } = await import('../server.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
await initDb(); // create the schema so the fire-and-forget reprice finds the markets table (0 rows → no-op)
await getDb();
const app = await buildServer();
after(async () => {
  await app.close();
  await closeDb();
});

const SECRET = 'whsec_route_test_secret';
const signed = (body: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;
};
const post = (payload: string, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/webhooks/scrydex', headers: { 'content-type': 'application/json', ...headers }, payload });

test('POST /webhooks/scrydex acks a genuinely-signed raw_updated event with 200', async () => {
  // repriceExpansions short-circuits before any fetch — the §6a flag gate fires first (test env
  // ORACLE_PRIMARY=pokemontcg ≠ scrydex), and the expansion matches no market anyway → no live API call
  const body = JSON.stringify({ id: 'evt_1', name: 'pokemon.expansions.prices.raw_updated', data: { expansion_ids: ['no-such-expansion'] } });
  const res = await post(body, { 'x-scrydex-signature': signed(body) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test('POST /webhooks/scrydex also re-prices on a signed graded_updated event (acked 200)', async () => {
  // graded_updated now drives a reprice too (refreshes the Scrydex graded ladder); same short-circuit
  // as raw_updated in test env, so it acks 200 without a live fetch.
  const body = JSON.stringify({ id: 'evt_g', name: 'pokemon.expansions.prices.graded_updated', data: { expansion_ids: ['no-such-expansion'] } });
  const res = await post(body, { 'x-scrydex-signature': signed(body) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test('POST /webhooks/scrydex rejects a bad or missing signature with 401', async () => {
  const body = JSON.stringify({ id: 'evt_2', name: 'pokemon.expansions.prices.raw_updated', data: { expansion_ids: ['x'] } });
  assert.equal((await post(body, { 'x-scrydex-signature': 't=1,v1=deadbeef' })).statusCode, 401);
  assert.equal((await post(body, {})).statusCode, 401, 'no signature header → 401');
  // a valid signature over a DIFFERENT body must not validate this one
  const other = JSON.stringify({ id: 'evt_3', name: 'pokemon.expansions.prices.raw_updated', data: { expansion_ids: ['y'] } });
  assert.equal((await post(body, { 'x-scrydex-signature': signed(other) })).statusCode, 401);
});
