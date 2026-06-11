import { test } from 'node:test';
import assert from 'node:assert/strict';

// In-memory DB + plain logger before importing app modules (mirrors auth.test.ts).
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true'; // many logins/nonces in this file; the caps are exercised elsewhere
process.env.MAX_DELEGATED_KEYS = '4';

const { Keypair } = await import('@solana/web3.js');
const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { getDb } = await import('../db/client.ts');
const { sign, bearer, login: loginAs } = await import('../test-helpers.ts');
const { authenticate } = await import('../plugins/auth.ts');

await initDb();
const app = await buildServer();
const db = await getDb();

type Kp = InstanceType<typeof Keypair>;
const login = (kp: Kp) => loginAs(app, kp);
const b58 = (kp: Kp) => kp.publicKey.toBase58();

/** Raw login (no 200 assertion) — returns the /auth/verify reply so failures can be asserted. */
async function loginRaw(kp: Kp) {
  const pubkey = b58(kp);
  const { message } = (await app.inject({ method: 'POST', url: '/auth/nonce', payload: { pubkey } })).json();
  return app.inject({ method: 'POST', url: '/auth/verify', payload: { pubkey, message, signature: sign(message, kp) } });
}

/** Master (full-scope) authorizes `delegateKp` as a trade-only key. Returns the /auth/delegate reply. */
async function createDelegate(accessToken: string, masterKp: Kp, delegateKp: Kp, opts: Record<string, unknown> = {}) {
  const delegatePubkey = b58(delegateKp);
  const nres = await app.inject({ method: 'POST', url: '/auth/delegate/nonce', headers: bearer(accessToken), payload: { delegatePubkey, ...opts } });
  if (nres.statusCode !== 200) return nres;
  const { message } = nres.json();
  const signature = sign(message, masterKp); // the MASTER signs the delegation
  return app.inject({ method: 'POST', url: '/auth/delegate', headers: bearer(accessToken), payload: { delegatePubkey, ...opts, message, signature } });
}

test('a delegate trades on the master account at trade scope (act = delegate, pubkey = master)', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const delKp = Keypair.generate();

  const created = await createDelegate(master.accessToken, masterKp, delKp);
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().pubkey, b58(delKp));

  const del = await login(delKp);
  assert.equal(del.user.pubkey, b58(masterKp)); // logs in as the MASTER account, not a new one
  assert.equal(del.user.id, master.user.id);

  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(del.accessToken) });
  assert.equal(me.json().scope, 'trade');
  assert.equal(me.json().act, b58(delKp));
  assert.equal(me.json().pubkey, b58(masterKp));

  // a trade key can read balance (a trade route)...
  const bal = await app.inject({ method: 'GET', url: '/account/balance', headers: bearer(del.accessToken) });
  assert.equal(bal.statusCode, 200);
});

test('a delegated login creates NO users row for the delegate key', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const delKp = Keypair.generate();
  await createDelegate(master.accessToken, masterKp, delKp);
  await login(delKp);

  const r = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE solana_pubkey = $1`, [b58(delKp)]);
  assert.equal(r.rows[0].n, '0');
});

test('a trade key is rejected (403 scope_denied) on full-scope routes', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const delKp = Keypair.generate();
  await createDelegate(master.accessToken, masterKp, delKp);
  const del = await login(delKp);
  const h = bearer(del.accessToken);

  for (const [method, url, payload] of [
    ['POST', '/chat', { body: 'hi' }],
    ['POST', '/lp/deposit', { amountUsd: 10 }],
    ['GET', '/auth/delegates', undefined],
    ['POST', '/auth/delegate/nonce', { delegatePubkey: b58(Keypair.generate()) }],
  ] as const) {
    const res = await app.inject({ method, url, headers: h, payload });
    assert.equal(res.statusCode, 403, `${method} ${url} should be 403 for a trade key`);
    assert.equal(res.json().code, 'scope_denied');
  }
});

test('a trade key cannot log the master out everywhere; full scope can', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const delKp = Keypair.generate();
  await createDelegate(master.accessToken, masterKp, delKp);
  const del = await login(delKp);

  // delegate "log out everywhere" (no refreshToken body) must NOT kill the master's session
  await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(del.accessToken) });
  const masterStill = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(master.accessToken) });
  assert.equal(masterStill.statusCode, 200);
  const masterRefresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: master.refreshToken } });
  assert.equal(masterRefresh.statusCode, 200); // master session untouched

  // master "log out everywhere" DOES end the master session family
  const m2 = await login(masterKp);
  await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(m2.accessToken) });
  const after = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: m2.refreshToken } });
  assert.equal(after.statusCode, 401);
});

test('a trade key cannot revoke a master/sibling session by id, but can end its own', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const delKp = Keypair.generate();
  await createDelegate(master.accessToken, masterKp, delKp);
  const del = await login(delKp);

  // delegate submits the MASTER's refresh token (which carries the master's session id)
  await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(del.accessToken), payload: { refreshToken: master.refreshToken } });
  const masterRefresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: master.refreshToken } });
  assert.equal(masterRefresh.statusCode, 200, 'a trade key must not be able to revoke the master session');

  // but the delegate CAN end its own session by token
  await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(del.accessToken), payload: { refreshToken: del.refreshToken } });
  const delRefresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: del.refreshToken } });
  assert.equal(delRefresh.statusCode, 401);
});

test('revoking a delegate blocks new logins and kills its live sessions', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const delKp = Keypair.generate();
  await createDelegate(master.accessToken, masterKp, delKp);
  const del = await login(delKp);

  const revoke = await app.inject({ method: 'POST', url: `/auth/delegates/${b58(delKp)}/revoke`, headers: bearer(master.accessToken) });
  assert.equal(revoke.statusCode, 200);

  // existing refresh token dies immediately (session revoked), and a fresh login is refused
  const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: del.refreshToken } });
  assert.equal(refreshed.statusCode, 401);
  const relogin = await loginRaw(delKp);
  assert.equal(relogin.statusCode, 401);
  assert.equal(relogin.json().code, 'delegate_revoked');

  // a revoked key is burned forever — re-authorizing it is rejected
  const reauth = await createDelegate(master.accessToken, masterKp, delKp);
  assert.equal(reauth.statusCode, 409);
  assert.equal(reauth.json().code, 'delegate_exists');
});

test('an expired delegate cannot log in and creates no shadow user', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const delKp = Keypair.generate();
  // insert a delegate row already expired (the API only accepts future expiries)
  await db.query(
    `INSERT INTO delegated_keys(pubkey, user_id, label, expires_at) VALUES($1, $2, '', now() - interval '1 hour')`,
    [b58(delKp), master.user.id],
  );
  const r = await loginRaw(delKp);
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().code, 'delegate_revoked');
  const users = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE solana_pubkey = $1`, [b58(delKp)]);
  assert.equal(users.rows[0].n, '0');
});

test('the active-delegate cap is enforced', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  for (let i = 0; i < 4; i++) {
    const ok = await createDelegate(master.accessToken, masterKp, Keypair.generate(), { label: `bot${i}` });
    assert.equal(ok.statusCode, 200, ok.body);
  }
  const over = await createDelegate(master.accessToken, masterKp, Keypair.generate());
  assert.equal(over.statusCode, 409);
  assert.equal(over.json().code, 'delegate_cap_reached');
});

test('a label with a newline is rejected (no message-line injection)', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const res = await app.inject({
    method: 'POST',
    url: '/auth/delegate/nonce',
    headers: bearer(master.accessToken),
    payload: { delegatePubkey: b58(Keypair.generate()), label: 'evil\nDelegate: attacker' },
  });
  assert.equal(res.statusCode, 400);
});

test('expiresAt must be future and within the max lifetime', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const past = await app.inject({
    method: 'POST', url: '/auth/delegate/nonce', headers: bearer(master.accessToken),
    payload: { delegatePubkey: b58(Keypair.generate()), expiresAt: new Date(Date.now() - 1000).toISOString() },
  });
  assert.equal(past.statusCode, 400);
  const tooFar = await app.inject({
    method: 'POST', url: '/auth/delegate/nonce', headers: bearer(master.accessToken),
    payload: { delegatePubkey: b58(Keypair.generate()), expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() },
  });
  assert.equal(tooFar.statusCode, 400);
  assert.equal(tooFar.json().code, 'invalid_expiry');
});

test('swapping the delegate pubkey after the master signed fails verification', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const signedFor = Keypair.generate();
  const attacker = Keypair.generate();
  // get a nonce+message naming `signedFor`, master signs it...
  const nres = await app.inject({ method: 'POST', url: '/auth/delegate/nonce', headers: bearer(master.accessToken), payload: { delegatePubkey: b58(signedFor) } });
  const { message } = nres.json();
  const signature = sign(message, masterKp);
  // ...but submit with the ATTACKER's pubkey: the server re-renders with the attacker key, so the sig fails
  const res = await app.inject({
    method: 'POST', url: '/auth/delegate', headers: bearer(master.accessToken),
    payload: { delegatePubkey: b58(attacker), message, signature },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'signature_invalid');
});

test('a key that is already an account cannot be delegated', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const otherKp = Keypair.generate();
  await login(otherKp); // otherKp now exists as a users row
  const res = await createDelegate(master.accessToken, masterKp, otherKp);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'delegate_is_user');
});

test('refresh preserves trade scope and re-checks revocation', async () => {
  const masterKp = Keypair.generate();
  const master = await login(masterKp);
  const delKp = Keypair.generate();
  await createDelegate(master.accessToken, masterKp, delKp);
  const del = await login(delKp);

  const r1 = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: del.refreshToken } });
  assert.equal(r1.statusCode, 200);
  const rotated = r1.json();
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(rotated.accessToken) });
  assert.equal(me.json().scope, 'trade'); // NOT escalated to full on rotation
  assert.equal(me.json().act, b58(delKp));
  // the rotated token still can't reach a full route
  const chat = await app.inject({ method: 'POST', url: '/chat', headers: bearer(rotated.accessToken), payload: { body: 'x' } });
  assert.equal(chat.statusCode, 403);

  // expire the delegate (no session kill — this exercises refresh's delegate re-check directly):
  // the still-valid rotated refresh token must now be refused.
  await db.query(`UPDATE delegated_keys SET expires_at = now() - interval '1 minute' WHERE pubkey = $1`, [b58(delKp)]);
  const r2 = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: rotated.refreshToken } });
  assert.equal(r2.statusCode, 401);
  assert.equal(r2.json().code, 'delegate_revoked');
});

test('every authenticated route declares an explicit scope (fail-closed walk)', () => {
  const table = (app as unknown as { routeTable: { url: string; method: string | string[]; preHandler: unknown; scope?: string }[] }).routeTable;
  assert.ok(table.length > 0);
  const undeclared: string[] = [];
  for (const r of table) {
    const pres = Array.isArray(r.preHandler) ? r.preHandler : r.preHandler ? [r.preHandler] : [];
    if (pres.includes(authenticate) && r.scope !== 'full' && r.scope !== 'trade') {
      undeclared.push(`${String(r.method)} ${r.url}`);
    }
  }
  assert.deepEqual(undeclared, [], `authenticated routes missing a scope policy: ${undeclared.join(', ')}`);
});

test('/health exposes the api version', async () => {
  const h = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(h.json().apiVersion, 1);
});
