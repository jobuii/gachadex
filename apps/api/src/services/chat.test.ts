import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { postChat, listChat, getProfile, setUsername, listChatUsers } = await import('./chat.ts');
const { onMessage } = await import('./bus.ts');

await initDb();
const db = await getDb();

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}

test('chat: posts persist, list is oldest-first with a handle, and each post broadcasts', async () => {
  const u = await newUser();
  const events: unknown[] = [];
  const off = onMessage((m) => { if (m.channel === 'chat') events.push(m); });

  await postChat(db, u, '  hello world  '); // trimmed
  await postChat(db, u, 'second message');
  off();

  const msgs = await listChat(db, { limit: 50 });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].body, 'hello world'); // oldest first, trimmed
  assert.equal(msgs[1].body, 'second message');
  assert.ok(msgs[0].handle.includes('…'), 'handle is a truncated pubkey');
  assert.equal(events.length, 2, 'each post broadcast on the chat channel');
});

test('chat: empty and over-length messages are rejected', async () => {
  const u = await newUser();
  await assert.rejects(postChat(db, u, '    '), /empty/);
  await assert.rejects(postChat(db, u, 'x'.repeat(281)), /too long/);
});

test('chat: a user can set a unique username; the handle uses it; dupes/bad formats rejected', async () => {
  const a = await newUser();
  const b = await newUser();

  const r = await setUsername(db, a, 'Ash_Ketchum');
  assert.equal(r.username, 'Ash_Ketchum');
  const prof = await getProfile(db, a);
  assert.equal(prof.username, 'Ash_Ketchum');
  assert.equal(prof.handle, 'Ash_Ketchum');

  const posted = await postChat(db, a, 'gotta catch em all');
  assert.equal(posted.handle, 'Ash_Ketchum'); // posts now carry the username

  await assert.rejects(setUsername(db, b, 'Ash_Ketchum'), /already taken/);
  await assert.rejects(setUsername(db, b, 'ASH_KETCHUM'), /already taken/); // case-insensitive (no impersonation)
  await assert.rejects(setUsername(db, b, 'ab'), /3-20/);
  await assert.rejects(setUsername(db, b, 'bad name!'), /letters/);
});

test('chat: a renamed-away username is reserved and cannot be hijacked; owner can reclaim it', async () => {
  const a = await newUser();
  const b = await newUser();

  await setUsername(db, a, 'Misty');
  await setUsername(db, a, 'MistyW'); // 'Misty' is now freed but reserved to `a`

  // nobody else can claim a's current OR freed handle (case-insensitively) and impersonate them
  await assert.rejects(setUsername(db, b, 'MistyW'), /already taken/); // current
  await assert.rejects(setUsername(db, b, 'Misty'), /already taken/); // reserved alias
  await assert.rejects(setUsername(db, b, 'misty'), /already taken/); // ci alias

  // a can rename back to a handle they previously held (their own reserved alias)
  assert.equal((await setUsername(db, a, 'misty')).username, 'misty');
  assert.equal((await getProfile(db, a)).handle, 'misty');

  // and now 'MistyW' is freed+reserved to a, still not claimable by b
  await assert.rejects(setUsername(db, b, 'MistyW'), /already taken/);
});

test('chat: replying carries the parent context and survives a reload; bad parent rejected', async () => {
  const u = await newUser();
  const parent = await postChat(db, u, 'parent message');
  const reply = await postChat(db, u, 'a reply', parent.id);
  assert.ok(reply.replyTo);
  assert.equal(reply.replyTo.id, parent.id);
  assert.equal(reply.replyTo.body, 'parent message');
  assert.ok(reply.replyTo.handle.length > 0);

  await assert.rejects(postChat(db, u, 'oops', 'does-not-exist'), /no longer exists/);

  const stored = (await listChat(db, { limit: 200 })).find((m) => m.id === reply.id);
  assert.equal(stored!.replyTo!.id, parent.id);
});

test('listChatUsers lists posters with wallet + message count, most-active first, and skips non-posters', async () => {
  const a = await newUser();
  const b = await newUser();
  const c = await newUser(); // posts nothing
  await postChat(db, a, 'a1');
  await postChat(db, a, 'a2');
  await postChat(db, a, 'a3');
  await postChat(db, b, 'b1');

  const users = await listChatUsers(db);
  const ra = users.find((u) => u.userId === a);
  const rb = users.find((u) => u.userId === b);
  assert.ok(ra && rb, 'both posters are listed');
  assert.equal(ra!.messages, 3);
  assert.equal(rb!.messages, 1);
  assert.equal(ra!.pubkey, 'pk-' + a.slice(0, 8)); // connected wallet surfaced
  assert.ok(ra!.lastAt, 'last-active timestamp present');
  assert.ok(!users.some((u) => u.userId === c), 'a user who never posted is not listed');
  assert.ok(users.findIndex((u) => u.userId === a) < users.findIndex((u) => u.userId === b), 'most-active first');
});

after(async () => {
  await closeDb();
});
