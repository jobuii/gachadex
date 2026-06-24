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
process.env.TOKENS_ENABLED = 'true'; // P4: enable pay-with-Tokens + loyalty earn for the token tests

const { getDb } = await import('../db/client.ts');
const { migrate } = await import('../db/migrate.ts');
const { usdc } = await import('../money.ts');
const { fund, sign } = await import('../test-helpers.ts');
const { openPack, sellBack, reconcilePending, nftWithdrawNonce, requestNftWithdraw } = await import('./gacha.ts');
const { tokensEarnedForOpen, tokenPriceForPack, earnTokens, getTokenSummary } = await import('./tokens.ts');

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

test('open: a non-deliverable reveal with no buyback amount refunds, never strands paid', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const cc = fakeCc();
  cc.reveals = [{ success: true, code: 'WEIRD_UNHANDLED' }]; // no nft_address, not WAITING, no buybackAmount
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'nondeliver' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(r.status, 'failed');         // refunded, not stuck 'paid' forever
  assert.equal(await collOf(user), before); // fully refunded
});

test('open: YOLO/turbo — CC auto-sells the common, credits buyback minus the 10% cut (turbo_sold)', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const feeBefore = await feeRev();
  const cc = fakeCc();
  cc.reveals = [{ success: true, code: 'TURBO_MODE_BUYBACK', buybackAmount: 30_000_000 }]; // auto-sold $30
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'yolo', turbo: true }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(r.status, 'turbo_sold');
  assert.equal(r.turboRefundE6, '27000000'); // 90% of $30
  assert.equal(await collOf(user), before - PRICE + 27_000_000n); // paid $50, got $27 back
  assert.equal((await feeRev()) - feeBefore, 3_000_000n); // 10% cut → FEE_REVENUE
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

test('sell-back: instant (sell-on-reveal) takes the 10% cut, not 5%', async () => {
  const user = await newUser();
  const chain = fakeChain();
  const cc = fakeCc();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'inst' }, { chain, cc, ...noWait });
  const prize = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE user_id = $1`, [user])).rows[0].id;
  cc.buybackAmount = 40_000_000; // $40
  const sell = await sellBack(db, user, prize, { chain, cc, ...noWait }, { instant: true });
  assert.equal(sell.payoutE6, '36000000'); // 90%
  assert.equal(sell.cutE6, '4000000'); // 10%
});

test('open: best-effort matches the won card to a GDEX market + surfaces a verify link', async () => {
  const user = await newUser();
  const marketId = randomUUID();
  // the fake reveal's name is "Charizard PSA 10" → a "Charizard" market is a substring match
  await db.query(`INSERT INTO markets(id, kind, symbol, display_name) VALUES($1, 'card', 'CHAR-MATCH', 'Charizard')`, [marketId]);
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'match' }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  assert.equal(r.card!.marketId, marketId);
  assert.ok(r.verifyUrl && r.verifyUrl.includes('/api/vrf/verify?memo='));
});

// ── P4: loyalty Tokens ──
const tokenBal = async (userId: string): Promise<bigint> =>
  BigInt((await db.query<{ balance: string }>(`SELECT balance FROM token_balances WHERE user_id = $1`, [userId])).rows[0]?.balance ?? '0');
const rewardsBudget = async (): Promise<bigint> =>
  BigInt((await db.query<{ a: string }>(`SELECT b.amount_uusdc AS a FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id IS NULL AND a.type = 'GACHA_REWARDS_BUDGET'`)).rows[0]?.a ?? '0');

test('tokens: earn-rate + price helpers are correct at the $1000 default threshold', () => {
  assert.equal(tokensEarnedForOpen(usdc(50), 1000), 1250n);  // $50 open → 1,250 Tokens (≈2.5% rebate)
  assert.equal(tokensEarnedForOpen(usdc(25), 1000), 625n);   // $25 open → 625
  assert.equal(tokensEarnedForOpen(usdc(100), 1000), 2500n); // $100 open → 2,500
  assert.equal(tokensEarnedForOpen(usdc(50), 500), 2500n);   // a more generous $500 threshold doubles it
  assert.equal(tokenPriceForPack(usdc(50)), 50_000n);        // a $50 pack costs 50,000 Tokens
});

test('tokens: a USDC open earns loyalty Tokens (PACK_OPEN_EARN)', async () => {
  const user = await newUser();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'earn1' }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  assert.equal(await tokenBal(user), 1250n); // $50 at the $1000 threshold
  assert.equal((await getTokenSummary(db, user)).untilFreePackTokens, (25_000n - 1250n).toString());
});

test('tokens: a token-bought open spends Tokens, funds CC from the rewards budget, earns nothing', async () => {
  const user = await newUser();
  await db.tx(async (q) => earnTokens(q, user, 100_000n, 'SEED', {})); // enough for a $50 pack (50,000)
  const budgetBefore = await rewardsBudget();
  const collBefore = await collOf(user);
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tok1', payWith: 'tokens' }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  assert.equal(r.status, 'opened');
  assert.equal(await tokenBal(user), 100_000n - 50_000n); // spent the token price; NO earn on a token open
  assert.equal(await collOf(user), collBefore);           // no USDC collateral debit
  assert.equal((await rewardsBudget()) - budgetBefore, -PRICE); // the budget paid CC the real USDC
});

test('tokens: a token open with too few Tokens is rejected (no pack, no charge)', async () => {
  const user = await newUser();
  await assert.rejects(
    openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tok-broke', payWith: 'tokens' }, { chain: fakeChain(), cc: fakeCc(), ...noWait }),
    /insufficient Tokens/i,
  );
  assert.equal(await tokenBal(user), 0n);
});

test('tokens: Σ token_ledger == token_balances per user (invariant)', async () => {
  const user = await newUser();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tinv1' }, { chain: fakeChain(), cc: fakeCc(), ...noWait }); // +1250
  await db.tx(async (q) => earnTokens(q, user, 100_000n, 'SEED', {}));
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tinv2', payWith: 'tokens' }, { chain: fakeChain(), cc: fakeCc(), ...noWait }); // -50,000
  const ledgerSum = BigInt((await db.query<{ s: string }>(`SELECT COALESCE(SUM(delta),0)::text AS s FROM token_ledger WHERE user_id = $1`, [user])).rows[0].s);
  assert.equal(ledgerSum, await tokenBal(user));
  assert.equal(await tokenBal(user), 1250n + 100_000n - 50_000n);
});

test('tokens: a refunded token-bought open returns Tokens (not USDC) and reverses the budget', async () => {
  const user = await newUser();
  await db.tx(async (q) => earnTokens(q, user, 100_000n, 'SEED', {}));
  const cc = fakeCc();
  cc.alwaysWait = true;   // CC never reveals
  cc.packRefunded = true; // then reports refunded
  const future = () => Date.now() + 120_000;
  const collBefore = await collOf(user);
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tref', payWith: 'tokens' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(await tokenBal(user), 100_000n - 50_000n); // spent the token price
  const budgetAfterBuy = await rewardsBudget();
  const rec = await reconcilePending(db, user, { chain: fakeChain(), cc, now: future, ...noWait });
  assert.equal(rec.recovered, 1);
  assert.equal(await tokenBal(user), 100_000n);                  // Tokens fully returned
  assert.equal(await collOf(user), collBefore);                 // NO USDC credited (no money minted)
  assert.equal(await rewardsBudget(), budgetAfterBuy + PRICE);   // rewards budget reversed
});
