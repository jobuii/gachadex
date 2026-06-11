import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// In-memory DB + real-funds mode (custody P2). The chain is injected (fakeWithdrawChain) — the
// secrets below only need to satisfy config presence checks; nothing touches a live RPC.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.REAL_FUNDS = 'true';
process.env.USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // devnet USDC
process.env.TREASURY_PUBKEY = '11111111111111111111111111111111';
process.env.DEPOSIT_MASTER_SEED = 'ab'.repeat(32);
process.env.HOT_WALLET_SECRET = 'unused-in-tests-chain-is-injected';

const { Keypair } = await import('@solana/web3.js');
const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { processWithdrawal, recoverInFlight, reverseWithdrawal } = await import('./custody/withdrawals.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');
const { sign, bearer, login: loginAs, fund: fundDb, fakeWithdrawChain } = await import('../test-helpers.ts');

await initDb();
const app = await buildServer();
const db = await getDb();

const DEST = Keypair.generate().publicKey.toBase58();
const login = (kp: InstanceType<typeof Keypair>) => loginAs(app, kp);
const fund = (userId: string, amount: bigint) => fundDb(db, userId, amount);

async function balanceOf(token: string): Promise<bigint> {
  const res = await app.inject({ method: 'GET', url: '/account/balance', headers: bearer(token) });
  return BigInt(res.json().availableUusdc);
}

/** Full client flow: fetch the step-up message, sign it, submit the withdrawal. */
async function withdraw(
  token: string,
  kp: InstanceType<typeof Keypair>,
  amountE6: bigint,
  opts: { idempotencyKey?: string; submitAmountE6?: bigint; signer?: InstanceType<typeof Keypair>; reuseMessage?: string } = {},
) {
  let message = opts.reuseMessage;
  if (!message) {
    const nonceRes = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw/nonce',
      headers: bearer(token),
      payload: { amountE6: amountE6.toString(), dest: DEST },
    });
    assert.equal(nonceRes.statusCode, 200, nonceRes.body);
    message = nonceRes.json().message as string;
  }
  return app.inject({
    method: 'POST',
    url: '/wallet/withdraw',
    headers: bearer(token),
    payload: {
      amountE6: (opts.submitAmountE6 ?? amountE6).toString(),
      dest: DEST,
      idempotencyKey: opts.idempotencyKey ?? `idem-${Math.random().toString(36).slice(2)}`,
      message,
      signature: sign(message, opts.signer ?? kp),
    },
  });
}

test('withdrawal happy path: step-up -> atomic debit -> process -> confirmed', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(100));

  const res = await withdraw(accessToken, kp, usdc(50));
  assert.equal(res.statusCode, 200, res.body);
  const w = res.json();
  assert.equal(w.status, 'requested');
  assert.equal(await balanceOf(accessToken), usdc(50)); // debited at acceptance, before any chain action

  const chain = fakeWithdrawChain();
  assert.equal((await processWithdrawal(db, chain, w.id)).status, 'confirmed');
  assert.equal(chain.signed.length, 1);
  assert.equal(chain.signed[0].dest, DEST);
  assert.equal(chain.signed[0].amountE6, usdc(50));
  assert.deepEqual(chain.broadcasts, [chain.signed[0].sig]); // exactly the signed tx went out

  // lifecycle feed + ledger history both show it
  const txs = (await app.inject({ method: 'GET', url: '/wallet/transactions', headers: bearer(accessToken) })).json();
  assert.deepEqual(
    txs.transactions.map((t: { kind: string; status: string; usdcE6: string }) => [t.kind, t.status, t.usdcE6]),
    [['withdrawal', 'confirmed', usdc(50).toString()]],
  );
  const hist = (await app.inject({ method: 'GET', url: '/history/transactions', headers: bearer(accessToken) })).json();
  assert.ok(
    hist.transactions.some((t: { type: string; amountUusdc: string }) => t.type === 'Transfer' && t.amountUusdc === (-usdc(50)).toString()),
    JSON.stringify(hist),
  );
  assert.equal((await reconcile(db)).ok, true);
});

test('step-up is enforced: a wrong signer and a tampered amount are both rejected, with no debit', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(100));

  // signed by a different wallet
  const wrongSigner = await withdraw(accessToken, kp, usdc(30), { signer: Keypair.generate() });
  assert.equal(wrongSigner.statusCode, 401);

  // message authorizes $30 but the request claims $60 — the server re-renders and mismatches
  const tampered = await withdraw(accessToken, kp, usdc(30), { submitAmountE6: usdc(60) });
  assert.equal(tampered.statusCode, 401);

  assert.equal(await balanceOf(accessToken), usdc(100)); // nothing debited
  const rows = await db.query(`SELECT id FROM withdrawals WHERE user_id = $1`, [user.id]);
  assert.equal(rows.rows.length, 0); // rejected requests leave no row
});

test('a rejected request leaves the nonce retryable; an accepted one burns it', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(5));

  // capture the signed message, then fail on balance — the rollback must un-claim the nonce
  const nonceRes = await app.inject({
    method: 'POST',
    url: '/wallet/withdraw/nonce',
    headers: bearer(accessToken),
    payload: { amountE6: usdc(8).toString(), dest: DEST },
  });
  const message = nonceRes.json().message as string;
  const rejected = await withdraw(accessToken, kp, usdc(8), { reuseMessage: message });
  assert.equal(rejected.statusCode, 400); // insufficient balance

  await fund(user.id, usdc(10));
  const retried = await withdraw(accessToken, kp, usdc(8), { reuseMessage: message });
  assert.equal(retried.statusCode, 200, retried.body); // same message + signature, now accepted

  const replayed = await withdraw(accessToken, kp, usdc(8), { reuseMessage: message });
  assert.equal(replayed.statusCode, 401); // single-use: the accepted request claimed the nonce
});

test('below the minimum withdrawal is rejected', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(100));
  const res = await withdraw(accessToken, kp, usdc(1)); // min is $5
  assert.equal(res.statusCode, 400);
  assert.equal(await balanceOf(accessToken), usdc(100));
});

test('cumulative withdrawals cannot exceed the balance — each debits, so the next sees the remainder', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(100));

  // first $60 is accepted and debited on the spot -> $40 left
  const first = await withdraw(accessToken, kp, usdc(60));
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(await balanceOf(accessToken), usdc(40));

  // a second $60 now exceeds the remaining $40 -> rejected, nothing further debited
  const second = await withdraw(accessToken, kp, usdc(60));
  assert.equal(second.statusCode, 400, second.body);
  assert.match(second.json().error, /insufficient/);
  assert.equal(await balanceOf(accessToken), usdc(40));

  assert.equal((await reconcile(db)).ok, true);
});

test('the daily velocity cap rejects the request that crosses it', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(20_000));

  assert.equal((await withdraw(accessToken, kp, usdc(9_000))).statusCode, 200);
  const over = await withdraw(accessToken, kp, usdc(1_500)); // 10.5k > the 10k/day cap
  assert.equal(over.statusCode, 429);
  assert.equal(await balanceOf(accessToken), usdc(11_000)); // only the first debit happened
});

test('an idempotency-key replay returns the same withdrawal without a second debit', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(100));

  const key = 'replay-key-1';
  const first = await withdraw(accessToken, kp, usdc(50), { idempotencyKey: key });
  assert.equal(first.statusCode, 200, first.body);

  // a client network-retry: same payload, same key — the nonce is already burned, so this only
  // works because the idempotent fast path answers before step-up verification
  const retry = await withdraw(accessToken, kp, usdc(50), { idempotencyKey: key, reuseMessage: 'Nonce: irrelevant' });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().id, first.json().id);
  assert.equal(retry.json().duplicate, true);
  assert.equal(await balanceOf(accessToken), usdc(50)); // one debit
});

test('crash recovery re-broadcasts the SAME signed tx — never signs twice', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(100));
  const { id } = (await withdraw(accessToken, kp, usdc(20))).json();

  const chain = fakeWithdrawChain();
  chain.failBroadcast = true;
  await assert.rejects(() => processWithdrawal(db, chain, id)); // signed + persisted, broadcast died
  const mid = (await db.query<{ status: string; onchain_sig: string }>(`SELECT status, onchain_sig FROM withdrawals WHERE id = $1`, [id])).rows[0];
  assert.equal(mid.status, 'broadcast');
  assert.equal(mid.onchain_sig, chain.signed[0].sig);

  chain.failBroadcast = false;
  assert.equal((await recoverInFlight(db, chain)).recovered, 1);
  assert.equal(chain.signed.length, 1); // signed exactly once
  assert.deepEqual(chain.broadcasts, [chain.signed[0].sig]); // the same tx went out
  const fin = (await db.query<{ status: string }>(`SELECT status FROM withdrawals WHERE id = $1`, [id])).rows[0];
  assert.equal(fin.status, 'confirmed');
  assert.equal((await reconcile(db)).ok, true);
});

test('a provably dead tx is replaced: old sig can never land, the new one pays', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(100));
  const { id } = (await withdraw(accessToken, kp, usdc(25))).json();

  const chain = fakeWithdrawChain();
  chain.failBroadcast = true;
  await assert.rejects(() => processWithdrawal(db, chain, id));
  chain.deadSigs.add(chain.signed[0].sig); // the un-broadcast tx's blockhash expired
  chain.failBroadcast = false;

  assert.equal((await recoverInFlight(db, chain)).recovered, 1);
  assert.equal(chain.signed.length, 2); // re-signed once
  assert.deepEqual(chain.broadcasts, [chain.signed[1].sig]); // only the replacement was paid
  const row = (await db.query<{ status: string; onchain_sig: string }>(`SELECT status, onchain_sig FROM withdrawals WHERE id = $1`, [id])).rows[0];
  assert.equal(row.status, 'confirmed');
  assert.equal(row.onchain_sig, chain.signed[1].sig);
  assert.equal((await reconcile(db)).ok, true);
});

test('reversal re-credits an abandoned request; a confirmed payout cannot be reversed', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  await fund(user.id, usdc(100));
  const chain = fakeWithdrawChain();

  const { id } = (await withdraw(accessToken, kp, usdc(40))).json();
  assert.equal(await balanceOf(accessToken), usdc(60));
  await reverseWithdrawal(db, chain, id, 'operator abandoned');
  assert.equal(await balanceOf(accessToken), usdc(100)); // re-credited
  const row = (await db.query<{ status: string }>(`SELECT status FROM withdrawals WHERE id = $1`, [id])).rows[0];
  assert.equal(row.status, 'reversed');

  const paid = (await withdraw(accessToken, kp, usdc(10))).json();
  await processWithdrawal(db, chain, paid.id);
  await assert.rejects(() => reverseWithdrawal(db, chain, paid.id, 'nope'), /confirmed/);
  assert.equal((await reconcile(db)).ok, true);
});

after(async () => {
  await app.close();
  await closeDb();
});
