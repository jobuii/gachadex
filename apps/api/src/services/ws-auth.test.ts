import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.ACCESS_TTL_SEC = '2'; // short-lived tokens so the WS auth-expiry drop is observable (wide margins below keep it non-flaky under parallel load)

const { Keypair } = await import('@solana/web3.js');
const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { closeDb } = await import('../db/client.ts');
const { publish } = await import('./bus.ts');
const { login: loginAs } = await import('../test-helpers.ts');
// Node's built-in (global) WebSocket client — no extra dependency. Browser-style event API.
const WS: any = (globalThis as { WebSocket?: unknown }).WebSocket;

await initDb();
const app = await buildServer();
await app.listen({ port: 0, host: '127.0.0.1' });
const port = (app.server.address() as { port: number }).port;

after(async () => {
  await app.close();
  await closeDb();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a WS socket stops receiving private events once its access token expires', async () => {
  const { accessToken, user } = await loginAs(app, Keypair.generate());
  const chan = `positions:${user.id}`;

  const ws = new WS(`ws://127.0.0.1:${port}/ws`);
  const got: string[] = [];
  let authed = false;
  ws.addEventListener('message', (ev: { data: string }) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'authed') authed = true;
    if (m.ch === chan) got.push(m.type);
  });
  await new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('ws connection error')));
  });

  ws.send(JSON.stringify({ op: 'auth', token: accessToken }));
  for (let i = 0; i < 50 && !authed; i++) await sleep(20);
  assert.ok(authed, 'socket should authenticate');
  ws.send(JSON.stringify({ op: 'sub', channels: [chan] }));
  await sleep(50);

  // token still valid: a private event is delivered
  publish(chan, 'update', { marketId: 'm1' });
  await sleep(200);
  assert.equal(got.length, 1, 'a fresh authed socket should receive its private event');

  // token expired: the same channel stops delivering (no holding-the-socket-open bypass)
  await sleep(2600);
  publish(chan, 'update', { marketId: 'm1' });
  await sleep(250);
  assert.equal(got.length, 1, 'an expired socket must not receive new private events');

  ws.close();
});
