import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

// In-memory PGlite + Classic Gacha ON + a deposit seed (for the per-user NFT-custody keypair). Set before
// importing config/client. The on-chain GachaChain + the CC API are FAKES (inline below), so these tests
// exercise the money / idempotency / state-machine logic; the live Solana + CC behavior is the operator's
// real-funds test (spec P1).
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.CLASSIC_GACHA_ENABLED = 'true';
process.env.DEPOSIT_MASTER_SEED = 'a'.repeat(64); // 32 bytes hex — pure-crypto derivation, no real funds

const { getDb } = await import('../db/client.ts');
const { migrate } = await import('../db/migrate.ts');
const { usdc } = await import('../money.ts');
const { fund, sign } = await import('../test-helpers.ts');
const { openPack, sellBack, reconcilePending, nftWithdrawNonce, requestNftWithdraw } = await import('./gacha.ts');

const db = await getDb();
await migrate();

// ── inline fakes (custody.test.ts pattern) ──
function fakeChain() {
  const c = {
    funded: [] as { dest: string; usdcE6: bigint }[],
    signs: 0,
    fundFail: false,
    async fundCustody(dest: string, usdcE6: bigint) {
      if (c.fundFail) throw new Error('simulated funding failure');
      c.funded.push({ dest, usdcE6 });
      return { sig: `gfund-${c.funded.length}` };
    },
    signTx(_b64: string, _kp: unknown) { c.signs++; return `signed-${c.signs}`; },
    hotPubkey() { return 'Hot1111111111111111111111111111111111111111'; },
    transfers: [] as { mint: string; dest: string }[],
    async transferNft(mint: string, dest: string, _signer: unknown) { c.transfers.push({ mint, dest }); return { sig: `nft-xfer-${c.transfers.length}` }; },
  };
  return c;
}

let mintSeq = 0;
const keptReveal = (insured = 4475) => ({
  success: true,
  nft_address: `Mint${++mintSeq}`,
  rarity: 'epic',
  nftWon: { content: { metadata: { name: 'Charizard PSA 10', attributes: [{ trait_type: 'insured value', value: insured }, { trait_type: 'Grading Company', value: 'PSA' }, { trait_type: 'GradeNum', value: '10' }] }, links: { image: 'https://cc/x.png' } } },
});
const waiting = () => ({ success: false, code: 'WAITING_FOR_WEBHOOK' });

function fakeCc() {
  const cc = {
    price: 50,
    reveals: [] as unknown[],
    generateFail: false,
    submitNoSig: false,
    packRefunded: false,
    alwaysWait: false,
    buybackAmount: 40_000_000, // base units ($40)
    submits: 0,
    async getMachines() { return { machines: [{ code: 'pokemon_50', name: 'Elite', price: cc.price, instantBuyback: 85, odds: {}, stock: {} }] }; },
    async getNfts() { return { nfts: [] }; },
    async generatePack(_p: unknown) { if (cc.generateFail) throw new Error('generatePack failed'); return { memo: `memo-${randomUUID().slice(0, 8)}`, transaction: 'unsigned' }; },
    async submitTransaction(_s: string) { cc.submits++; return { success: !cc.submitNoSig, signature: cc.submitNoSig ? '' : `paysig-${cc.submits}`, confirmationStatus: 'finalized' }; },
    async openPackReveal(_m: string) { if (cc.alwaysWait) return waiting() as never; return (cc.reveals.length ? cc.reveals.shift() : keptReveal()) as never; },
    async getPackStatus(m: string) { return { memo: m, pack: { refunded: cc.packRefunded }, send: null, buyback: [] }; },
    async buyback(_p: unknown) { return { success: true, serializedTransaction: 'bb', refundAmount: cc.buybackAmount, memo: 'bb' }; },
    async buybackAvailable() { return { available: cc.buybackAmount > 0, amount: cc.buybackAmount }; },
  };
  return cc;
}

async function newUser(faucetUsd = 10_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await fund(db, id, usdc(faucetUsd));
  return id;
}
const collOf = async (userId: string): Promise<bigint> =>
  BigInt((await db.query<{ a: string }>(`SELECT b.amount_uusdc AS a FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = $1 AND a.type = 'USER_COLLATERAL'`, [userId])).rows[0]?.a ?? '0');
const feeRev = async (): Promise<bigint> =>
  BigInt((await db.query<{ a: string }>(`SELECT b.amount_uusdc AS a FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id IS NULL AND a.type = 'FEE_REVENUE'`)).rows[0]?.a ?? '0');

const noWait = { sleepMs: async () => {} };
const PRICE = usdc(50);

test('open: debits the price, records the held NFT, funds + pays CC', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const chain = fakeChain();
  const cc = fakeCc();
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'k1' }, { chain, cc, ...noWait });
  assert.equal(r.status, 'opened');
  assert.ok(r.card && r.card.mint.startsWith('Mint'));
  assert.equal(r.card!.valueE6, '4475000000'); // $4,475 → e6
  assert.equal(await collOf(user), before - PRICE); // debited exactly the price
  assert.equal(chain.funded[0].usdcE6, PRICE); // JIT-funded the custody wallet with the price
  const open = (await db.query<{ status: string; payment_sig: string; cc_memo: string }>(`SELECT status, payment_sig, cc_memo FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0];
  assert.equal(open.status, 'opened');
  assert.ok(open.payment_sig && open.cc_memo);
  const inv = (await db.query<{ status: string; mint: string }>(`SELECT status, mint FROM gacha_nft_inventory WHERE user_id = $1`, [user])).rows[0];
  assert.equal(inv.status, 'held');
});

test('open: insufficient balance is rejected before any charge', async () => {
  const user = await newUser(10); // $10 < $50 pack
  await assert.rejects(openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'k1' }, { chain: fakeChain(), cc: fakeCc(), ...noWait }), /insufficient/i);
  assert.equal(await collOf(user), usdc(10)); // untouched
});

test('open: replaying the idempotency key never double-charges', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const cc = fakeCc();
  const a = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'dup' }, { chain: fakeChain(), cc, ...noWait });
  const b = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'dup' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(a.openId, b.openId);
  assert.equal(b.status, 'opened');
  assert.equal(await collOf(user), before - PRICE); // charged once
  assert.equal((await db.query(`SELECT 1 FROM gacha_nft_inventory WHERE user_id = $1`, [user])).rows.length, 1);
});

test('open: webhook lag leaves it paid, then the reconciler delivers', async () => {
  const user = await newUser();
  const cc = fakeCc();
  cc.reveals = [waiting(), waiting(), waiting()]; // never reveals within the inline retries
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'k' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(r.status, 'paid'); // stranded
  cc.reveals = [keptReveal(200)]; // webhook arrives
  const rec = await reconcilePending(db, user, { chain: fakeChain(), cc, ...noWait });
  assert.equal(rec.recovered, 1);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0].status, 'opened');
});

test('open: a buy that never reaches CC is refunded (no payment_sig, after grace)', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const cc = fakeCc();
  cc.generateFail = true; // generatePack throws → no memo, no payment_sig
  const future = () => Date.now() + 120_000; // past the 90s grace
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'k' }, { chain: fakeChain(), cc, now: future, ...noWait });
  assert.equal(r.status, 'failed');
  assert.equal(await collOf(user), before); // fully refunded (GACHA_REFUND)
});

test('open: a CC-refunded pack credits the buy back', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const cc = fakeCc();
  cc.alwaysWait = true; // CC never reveals (payment confirmed but no card) — then reports refunded
  cc.packRefunded = true;
  const future = () => Date.now() + 120_000;
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'k' }, { chain: fakeChain(), cc, ...noWait });
  const rec = await reconcilePending(db, user, { chain: fakeChain(), cc, now: future, ...noWait });
  assert.equal(rec.recovered, 1);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0].status, 'refunded');
  assert.equal(await collOf(user), before); // refunded
});

test('sell-back: 95% to the user, 5% to FEE_REVENUE, prize sold once', async () => {
  const user = await newUser();
  const chain = fakeChain();
  const cc = fakeCc();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'k' }, { chain, cc, ...noWait });
  const prize = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE user_id = $1`, [user])).rows[0].id;
  const collBefore = await collOf(user);
  const feeBefore = await feeRev();
  cc.buybackAmount = 40_000_000; // $40
  const sell = await sellBack(db, user, prize, { chain, cc, ...noWait });
  assert.equal(sell.payoutE6, '38000000'); // 95%
  assert.equal(sell.cutE6, '2000000'); // 5%
  assert.equal(await collOf(user), collBefore + 38_000_000n);
  assert.equal(await feeRev(), feeBefore + 2_000_000n);
  // double-sell rejected
  await assert.rejects(sellBack(db, user, prize, { chain, cc, ...noWait }), /already settled/i);
});

// A user with a REAL keypair, so the withdraw step-up signature verifies.
async function newSignerUser(faucetUsd = 10_000): Promise<{ userId: string; kp: InstanceType<typeof Keypair>; pubkey: string }> {
  const kp = Keypair.generate();
  const pubkey = kp.publicKey.toBase58();
  const userId = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [userId, pubkey]);
  await fund(db, userId, usdc(faucetUsd));
  return { userId, kp, pubkey };
}

test('withdraw: step-up authorizes the transfer; held → withdrawn; double-withdraw rejected', async () => {
  const { userId, kp, pubkey } = await newSignerUser();
  const chain = fakeChain();
  await openPack(db, userId, { machineCode: 'pokemon_50', idempotencyKey: 'w' }, { chain, cc: fakeCc(), ...noWait });
  const prize = (await db.query<{ id: string; mint: string }>(`SELECT id, mint FROM gacha_nft_inventory WHERE user_id = $1`, [userId])).rows[0];
  const dest = Keypair.generate().publicKey.toBase58();

  const { message } = await nftWithdrawNonce(db, userId, pubkey, prize.id, dest);
  const r = await requestNftWithdraw(db, userId, pubkey, prize.id, { dest, message, signature: sign(message, kp) }, { chain });
  assert.equal(r.status, 'withdrawn');
  assert.deepEqual(chain.transfers[0], { mint: prize.mint, dest }); // transferred the right NFT to the right dest
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM gacha_nft_inventory WHERE id = $1`, [prize.id])).rows[0].status, 'withdrawn');
  // a withdrawn prize is no longer withdrawable
  await assert.rejects(nftWithdrawNonce(db, userId, pubkey, prize.id, dest), /not withdrawable/i);
});

test('withdraw: a bad step-up signature is rejected and the prize stays held', async () => {
  const { userId, pubkey } = await newSignerUser();
  const chain = fakeChain();
  await openPack(db, userId, { machineCode: 'pokemon_50', idempotencyKey: 'w' }, { chain, cc: fakeCc(), ...noWait });
  const prize = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE user_id = $1`, [userId])).rows[0];
  const dest = Keypair.generate().publicKey.toBase58();
  const { message } = await nftWithdrawNonce(db, userId, pubkey, prize.id, dest);
  const wrong = sign(message, Keypair.generate()); // signed by someone else
  await assert.rejects(requestNftWithdraw(db, userId, pubkey, prize.id, { dest, message, signature: wrong }, { chain }), /signature|nonce|invalid/i);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM gacha_nft_inventory WHERE id = $1`, [prize.id])).rows[0].status, 'held');
  assert.equal(chain.transfers.length, 0); // no transfer attempted
});
