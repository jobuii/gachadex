import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';

const { buildServer } = await import('../server.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
await initDb();
await getDb();
const app = await buildServer();
after(async () => {
  await app.close();
  await closeDb();
});

const get = (url: string) => app.inject({ method: 'GET', url });

test('image-proxy validates the url before fetching (no open SSRF)', async () => {
  assert.equal((await get('/image-proxy')).statusCode, 400); // missing url
  assert.equal((await get('/image-proxy?url=not-a-url')).statusCode, 400); // unparseable
  // non-whitelisted host → 403 (never fetched)
  assert.equal((await get(`/image-proxy?url=${encodeURIComponent('https://evil.example.com/x.png')}`)).statusCode, 403);
  // whitelisted host but http (not https) → 403
  assert.equal((await get(`/image-proxy?url=${encodeURIComponent('http://cdn.tcgpricelookup.com/x.png')}`)).statusCode, 403);
});
