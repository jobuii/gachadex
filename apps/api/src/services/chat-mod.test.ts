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
const { setMod, deleteMessage, muteUser, unmuteUser, setBanned, listModState } = await import('./chat-mod.ts');

await initDb();
const db = await getDb();

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}
async function newMod(): Promise<string> {
  const id = await newUser();
  await setMod(db, id, true);
  return id;
}

test('a mod soft-deletes a message: it leaves chat, is audited, and cannot be re-deleted', async () => {
  const mod = await newMod();
  const user = await newUser();
  const msg = await postChat(db, user, 'hello world');
  assert.ok((await listChat(db)).some((m) => m.id === msg.id), 'present before delete');

  await deleteMessage(db, mod, msg.id);
  assert.ok(!(await listChat(db)).some((m) => m.id === msg.id), 'gone after delete');

  const st = await listModState(db);
  assert.ok(st.recentActions.some((a) => a.action === 'delete'), 'delete audited');
  await assert.rejects(deleteMessage(db, mod, msg.id), /not found or already deleted/);
});

test('a muted user cannot post until unmuted', async () => {
  const mod = await newMod();
  const user = await newUser();
  await muteUser(db, mod, user, 60);
  await assert.rejects(postChat(db, user, 'spam'), /muted/);
  await unmuteUser(db, mod, user);
  assert.equal((await postChat(db, user, 'i am back')).body, 'i am back');
});

test('a banned user cannot post until unbanned', async () => {
  const mod = await newMod();
  const user = await newUser();
  await setBanned(db, mod, user, true);
  await assert.rejects(postChat(db, user, 'hi'), /banned/);
  await setBanned(db, mod, user, false);
  assert.equal((await postChat(db, user, 'unbanned now')).body, 'unbanned now');
});

test('a mod cannot mute or ban another mod', async () => {
  const mod1 = await newMod();
  const mod2 = await newMod();
  await assert.rejects(muteUser(db, mod1, mod2, 60), /another moderator/);
  await assert.rejects(setBanned(db, mod1, mod2, true), /another moderator/);
});

test('messages carry the author mod flag (drives the MOD chip)', async () => {
  const mod = await newMod();
  const m = await postChat(db, mod, 'mod here');
  assert.equal(m.isMod, true);
  assert.equal((await listChat(db)).find((x) => x.id === m.id)?.isMod, true);
});

test('requireMod 403s a non-mod (and stops) but lets a mod through', async () => {
  const { requireMod } = await import('../plugins/auth.ts');
  const mockReply = () => {
    const calls: { code: number | null; sent: boolean } = { code: null, sent: false };
    const reply = { code(c: number) { calls.code = c; return reply; }, async send() { calls.sent = true; } };
    return { reply, calls };
  };
  const user = await newUser();
  const mod = await newMod();

  const denied = mockReply();
  await requireMod({ userId: user } as never, denied.reply as never);
  assert.equal(denied.calls.code, 403, 'non-mod denied');
  assert.equal(denied.calls.sent, true);

  const allowed = mockReply();
  await requireMod({ userId: mod } as never, allowed.reply as never);
  assert.equal(allowed.calls.sent, false, 'mod not denied (handler may proceed)');
});

test('replies to a deleted message do not leak its content', async () => {
  const mod = await newMod();
  const author = await newUser();
  const replier = await newUser();
  const parent = await postChat(db, author, 'secret content here');
  const reply = await postChat(db, replier, 'quoting you', parent.id);

  // before delete the quote is visible
  assert.equal((await listChat(db)).find((m) => m.id === reply.id)?.replyTo?.body, 'secret content here');

  await deleteMessage(db, mod, parent.id);

  // the reply survives, but its quote of the now-deleted parent is gone (no leak)
  const listed = (await listChat(db)).find((m) => m.id === reply.id);
  assert.ok(listed, 'reply still present');
  assert.equal(listed?.replyTo, null, 'deleted parent quote removed');

  // and you cannot create a NEW reply pointing at a deleted message
  await assert.rejects(postChat(db, replier, 'late reply', parent.id), /no longer exists/);
});

after(async () => {
  await closeDb();
});
