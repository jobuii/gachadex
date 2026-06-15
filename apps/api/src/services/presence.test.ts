import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';

const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { closeDb } = await import('../db/client.ts');
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
const open = (ws: any) => new Promise<void>((res, rej) => {
  ws.addEventListener('open', () => res());
  ws.addEventListener('error', () => rej(new Error('ws connection error')));
});

test('presence count rises as sockets join (and the count broadcasts to chat subscribers)', async () => {
  const ws1 = new WS(`ws://127.0.0.1:${port}/ws`);
  const seen: number[] = [];
  ws1.addEventListener('message', (ev: { data: string }) => {
    const m = JSON.parse(ev.data);
    if (m.ch === 'chat' && m.type === 'presence') seen.push(m.data.online);
  });
  await open(ws1);
  ws1.send(JSON.stringify({ op: 'sub', channels: ['chat'] }));
  await sleep(300);
  assert.ok(seen.length > 0, 'a chat subscriber receives a presence count');
  assert.ok(seen.at(-1)! >= 1, 'at least itself is online');

  // a second socket joins -> ws1 should see the count rise (via the broadcast)
  const ws2 = new WS(`ws://127.0.0.1:${port}/ws`);
  await open(ws2);
  ws2.send(JSON.stringify({ op: 'sub', channels: ['chat'] }));
  await sleep(400);
  const peak = Math.max(...seen);
  assert.ok(peak >= 2, `count should reach >=2 when a second socket joins (saw ${seen.join(',')})`);

  // ws2 leaves -> the count falls back
  ws2.close();
  await sleep(400);
  assert.equal(seen.at(-1), peak - 1, `count should drop by one when a socket leaves (saw ${seen.join(',')})`);

  ws1.close();
});
