import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { postChat, listChat } = await import('./chat.ts');
const { toggleReaction } = await import('./chat-reactions.ts');
const { setMod, deleteMessage } = await import('./chat-mod.ts');

await initDb();
const db = await getDb();

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}
const msgOf = async (list: Awaited<ReturnType<typeof listChat>>, id: string) => list.find((x) => x.id === id)!;

test('reacting toggles on/off, with counts + the viewer\'s own reactions reflected in listChat', async () => {
  const author = await newUser();
  const reactor = await newUser();
  const msg = await postChat(db, author, 'react to me');

  const r1 = await toggleReaction(db, reactor, msg.id, '🔥');
  assert.equal(r1.added, true);
  assert.equal(r1.count, 1);

  // signed-in viewer sees the count AND that it's theirs
  const mMine = await msgOf(await listChat(db, { viewerUserId: reactor }), msg.id);
  assert.equal(mMine.reactions?.['🔥'], 1);
  assert.deepEqual(mMine.myReactions, ['🔥']);

  // anonymous viewer sees the count but no "mine"
  const mAnon = await msgOf(await listChat(db), msg.id);
  assert.equal(mAnon.reactions?.['🔥'], 1);
  assert.deepEqual(mAnon.myReactions, []);

  // toggle off -> count 0, chip gone
  const r2 = await toggleReaction(db, reactor, msg.id, '🔥');
  assert.equal(r2.added, false);
  assert.equal(r2.count, 0);
  const mGone = await msgOf(await listChat(db), msg.id);
  assert.equal(mGone.reactions?.['🔥'], undefined);
});

test('reactions from multiple users accumulate', async () => {
  const author = await newUser();
  const u1 = await newUser();
  const u2 = await newUser();
  const msg = await postChat(db, author, 'popular');
  await toggleReaction(db, u1, msg.id, '👍');
  const r = await toggleReaction(db, u2, msg.id, '👍');
  assert.equal(r.count, 2);
});

test('an unsupported emoji is rejected', async () => {
  const u = await newUser();
  const msg = await postChat(db, u, 'x');
  await assert.rejects(toggleReaction(db, u, msg.id, '🦄'), /unsupported reaction/);
});

test('cannot react to a deleted message', async () => {
  const mod = await newUser(); await setMod(db, mod, true);
  const author = await newUser();
  const msg = await postChat(db, author, 'soon gone');
  await deleteMessage(db, mod, msg.id);
  await assert.rejects(toggleReaction(db, author, msg.id, '🔥'), /message not found/);
});

after(async () => {
  await closeDb();
});
