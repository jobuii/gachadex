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
process.env.GOLD_ENABLED = 'true'; // P4: enable pay-with-Gold + loyalty earn for the gold tests

const { getDb } = await import('../db/client.ts');
const { migrate } = await import('../db/migrate.ts');
const { usdc } = await import('../money.ts');
const { fund, sign } = await import('../test-helpers.ts');
const { openPack, sellBack, convert, reconcilePending, nftWithdrawNonce, requestNftWithdraw, extractCard, listInventory, remediateMisrecordedTurboCommon } = await import('./gacha.ts');
const { reconcileStuckPrizes } = await import('./gacha-reconcile.ts');
const { pollMachineStock, recentRestocks } = await import('./gacha-stock.ts');
const { goldEarnedForOpen, goldPriceForPack, earnGold, getGoldSummary, resetGoldBalances } = await import('./gold.ts');
const { setGachaConfig, gachaAdminConfig } = await import('./gacha-config.ts');
const { gachaMonitoring, fundGachaRewardsBudget } = await import('./gacha-monitoring.ts');
const { postTxn: ledgerPostTxn, getOrCreateSystemAccount: sysAcct } = await import('./ledger.ts');

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
    submitThrow: false,
    packRefunded: false,
    alwaysWait: false,
    buybackAmount: 40_000_000, // base units ($40)
    submits: 0,
    async getMachines() { return { machines: [{ code: 'pokemon_50', name: 'Elite', price: cc.price, instantBuyback: 85, odds: {}, stock: {} }] }; },
    async getNfts() { return { nfts: [] }; },
    async generatePack(_p: unknown) { if (cc.generateFail) throw new Error('generatePack failed'); return { memo: `memo-${randomUUID().slice(0, 8)}`, transaction: 'unsigned' }; },
    async submitTransaction(_s: string) { cc.submits++; if (cc.submitThrow) throw new Error('simulated submit failure (broadcast-then-timeout)'); return { success: !cc.submitNoSig, signature: cc.submitNoSig ? '' : `paysig-${cc.submits}`, confirmationStatus: 'finalized' }; },
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

test('extractCard: grade number falls back to "The Grade" when GradeNum is absent (PSA 10 / CGC 8.5, not bare "PSA")', () => {
  const reveal = (attrs: Array<{ trait_type: string; value: string }>) =>
    ({ success: true, nft_address: 'M1', rarity: 'rare', nftWon: { content: { metadata: { name: 'Card', attributes: attrs }, links: { image: 'x' } } } }) as never;
  // GradeNum present → used directly (unchanged behaviour)
  assert.equal(extractCard(reveal([{ trait_type: 'Grading Company', value: 'PSA' }, { trait_type: 'GradeNum', value: '10' }])).grade, 'PSA 10');
  // only 'The Grade' (e.g. CC's "GEM-MT 10") → parse the number → "PSA 10" (was a bare "PSA" before the fix)
  assert.equal(extractCard(reveal([{ trait_type: 'Grading Company', value: 'PSA' }, { trait_type: 'The Grade', value: 'GEM-MT 10' }])).grade, 'PSA 10');
  // decimal grade out of 'The Grade'
  assert.equal(extractCard(reveal([{ trait_type: 'Grading Company', value: 'CGC' }, { trait_type: 'The Grade', value: 'GEM MINT 8.5' }])).grade, 'CGC 8.5');
  // no grade attributes at all → null (no crash)
  assert.equal(extractCard(reveal([])).grade, null);
});

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

test('open: a sold-out machine (generatePack fails) refunds IMMEDIATELY — no 90s wait, no money to CC', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const cc = fakeCc();
  cc.generateFail = true; // CC's build call is the stock gate; a sold-out throw moves no money
  // NOTE: no `now: future` — the refund must happen in-request (the catch), not only after the grace window.
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'soldout' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(r.status, 'failed');
  assert.equal(await collOf(user), before); // made whole instantly
  assert.equal(cc.submits, 0); // never submitted a payment to CC
});

test('open: a pre-submit fund/sign failure (memo stored, no payment) refunds immediately', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const chain = fakeChain();
  chain.fundFail = true; // generatePack succeeds + stores the memo, then fundCustody throws BEFORE any CC payment
  const cc = fakeCc();
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'fundfail' }, { chain, cc, ...noWait });
  assert.equal(r.status, 'failed');
  assert.equal(await collOf(user), before); // refunded — not stranded 'paid' (the pre-submit-strand fix)
  const open = (await db.query<{ cc_memo: string | null; payment_sig: string | null; payment_attempted_at: string | null }>(
    `SELECT cc_memo, payment_sig, payment_attempted_at FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0];
  assert.ok(open.cc_memo); // got past generatePack
  assert.equal(open.payment_sig, null);
  assert.equal(open.payment_attempted_at, null); // never reached submit → marker unset → provably safe to refund
  assert.equal(cc.submits, 0);
});

test('open: a submit that may have broadcast (marker set) is NOT auto-refunded — waits for CC', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const cc = fakeCc();
  cc.submitThrow = true; // payment_attempted_at is stamped just before this → the tx may have landed
  cc.alwaysWait = true; // CC can't confirm a reveal yet
  const future = () => Date.now() + 120_000; // past grace
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'maybe' }, { chain: fakeChain(), cc, now: future, ...noWait });
  assert.equal(r.status, 'paid'); // conservative: never auto-refund a maybe-paid buy
  assert.equal(await collOf(user), before - PRICE); // still debited (money may be at CC)
  const open = (await db.query<{ payment_attempted_at: string | null }>(`SELECT payment_attempted_at FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0];
  assert.ok(open.payment_attempted_at); // marker set → reconciler stays conservative
  // Only once CC confirms the refund does the buy reverse.
  cc.packRefunded = true;
  const rec = await reconcilePending(db, user, { chain: fakeChain(), cc, now: future, ...noWait });
  assert.equal(rec.recovered, 1);
  assert.equal(await collOf(user), before); // now made whole, on CC's confirmation
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

test('open: YOLO/turbo — a Common buyback that ALSO carries nft_address still auto-sells + routes USDC to hot', async () => {
  // CC's real TURBO_MODE_BUYBACK response carries nft_address + transactionSignature (gacha API docs). The
  // buyback signal MUST win over the nft_address delivery branch, else the auto-sold common is mis-recorded as a
  // held slab and never credited (the prod bug). And generatePack must pass altFundsRecipient so the auto-sell
  // USDC lands in the hot wallet, backing settleTurboSold's TREASURY debit.
  const user = await newUser();
  const before = await collOf(user);
  const cc = fakeCc();
  let genParams: { altFundsRecipient?: string } = {};
  cc.generatePack = async (p: unknown) => { genParams = (p as { altFundsRecipient?: string }) ?? {}; return { memo: `m-${randomUUID().slice(0, 8)}`, transaction: 'unsigned' }; };
  cc.reveals = [{ success: true, nft_address: 'MintTurbo1', transactionSignature: 'sig', code: 'TURBO_MODE_BUYBACK', buybackAmount: 30_000_000, rarity: 'Common' }];
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'yolo-nft', turbo: true }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(r.status, 'turbo_sold'); // auto-sold, NOT 'opened'
  assert.equal(r.card, null);
  assert.equal(await collOf(user), before - PRICE + 27_000_000n); // credited 90% of $30
  assert.ok(genParams.altFundsRecipient, 'turbo routes the auto-sell USDC via altFundsRecipient');
  const inv = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gacha_nft_inventory WHERE mint = 'MintTurbo1'`);
  assert.equal(inv.rows[0].n, 0); // the common was NOT mis-recorded as a held NFT
});

test('open: normal (non-turbo) delivery is unchanged — no altFundsRecipient, card still recorded as held', async () => {
  const user = await newUser();
  const cc = fakeCc();
  let genParams: { altFundsRecipient?: string } = {};
  cc.generatePack = async (p: unknown) => { genParams = (p as { altFundsRecipient?: string }) ?? {}; return { memo: `m-${randomUUID().slice(0, 8)}`, transaction: 'unsigned' }; };
  cc.reveals = [keptReveal(4475)]; // nft_address, rarity epic, NO buyback signal
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'normal-deliver', turbo: false }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(r.status, 'opened');
  assert.ok(r.card && r.card.mint.startsWith('Mint'));
  assert.equal(genParams.altFundsRecipient, undefined, 'normal mode never sends altFundsRecipient');
});

test('remediate turbo mis-record: books the auto-sell (credit −10%), retires the prize, idempotent + dry-run', async () => {
  const user = await newUser();
  const cc = fakeCc();
  // Reproduce the OLD bug state: a turbo Common CC auto-sold, but recorded as a delivered held slab + never credited.
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'misrec' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(r.status, 'opened');
  const prizeId = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE open_id=$1`, [r.openId])).rows[0].id;
  await db.query(`UPDATE gacha_pack_opens SET turbo=true, rarity='Common', turbo_refund_e6=NULL WHERE id=$1`, [r.openId]);
  const before = await collOf(user); // baseline AFTER the (mis-recorded) open — the auto-sell was never credited
  const feeBefore = await feeRev();

  const gross = 30_000_000n; // CC's confirmed buyback ($30)
  const dry = await remediateMisrecordedTurboCommon(db, prizeId, gross, { dryRun: true });
  assert.equal(dry.status, 'dry_run');
  assert.equal(dry.payoutE6, '27000000');
  assert.equal(await collOf(user), before); // dry run writes nothing

  const res = await remediateMisrecordedTurboCommon(db, prizeId, gross);
  assert.equal(res.status, 'applied');
  assert.equal(res.payoutE6, '27000000'); // 90% of $30
  assert.equal(res.cutE6, '3000000'); // 10%
  assert.equal(await collOf(user), before + 27_000_000n); // user credited
  assert.equal((await feeRev()) - feeBefore, 3_000_000n); // cut → FEE_REVENUE
  const open = (await db.query<{ status: string; turbo_refund_e6: string }>(`SELECT status, turbo_refund_e6 FROM gacha_pack_opens WHERE id=$1`, [r.openId])).rows[0];
  assert.equal(open.status, 'turbo_sold');
  assert.equal(String(open.turbo_refund_e6), '27000000');
  const inv = (await db.query<{ status: string; sell_value_e6: string }>(`SELECT status, sell_value_e6 FROM gacha_nft_inventory WHERE id=$1`, [prizeId])).rows[0];
  assert.equal(inv.status, 'sold'); // phantom held card retired
  assert.equal(String(inv.sell_value_e6), '27000000');

  // idempotent: re-run does NOT double-credit
  const again = await remediateMisrecordedTurboCommon(db, prizeId, gross);
  assert.equal(again.status, 'already_done');
  assert.equal(await collOf(user), before + 27_000_000n);
});

test('remediate turbo mis-record: refuses a prize NOT in the mis-recorded state (normal held card)', async () => {
  const user = await newUser();
  const cc = fakeCc();
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'normalheld' }, { chain: fakeChain(), cc, ...noWait });
  const prizeId = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE open_id=$1`, [r.openId])).rows[0].id;
  // A normal delivered card (turbo=false, rarity=epic, held) must be refused — no money moves.
  const before = await collOf(user);
  await assert.rejects(remediateMisrecordedTurboCommon(db, prizeId, 30_000_000n), /not in mis-recorded turbo-Common state/);
  assert.equal(await collOf(user), before);
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

// ── P4: loyalty Gold ──
const goldBal = async (userId: string): Promise<bigint> =>
  BigInt((await db.query<{ balance: string }>(`SELECT balance FROM gold_balances WHERE user_id = $1`, [userId])).rows[0]?.balance ?? '0');
const rewardsBudget = async (): Promise<bigint> =>
  BigInt((await db.query<{ a: string }>(`SELECT b.amount_uusdc AS a FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id IS NULL AND a.type = 'GACHA_REWARDS_BUDGET'`)).rows[0]?.a ?? '0');

test('gold: earn-rate + price helpers are correct at the $1000 default threshold', () => {
  assert.equal(goldEarnedForOpen(usdc(50), 1000), 1250n);  // $50 open → 1,250 Gold (≈2.5% rebate)
  assert.equal(goldEarnedForOpen(usdc(25), 1000), 625n);   // $25 open → 625
  assert.equal(goldEarnedForOpen(usdc(100), 1000), 2500n); // $100 open → 2,500
  assert.equal(goldEarnedForOpen(usdc(50), 500), 2500n);   // a more generous $500 threshold doubles it
  assert.equal(goldPriceForPack(usdc(50)), 50_000n);        // a $50 pack costs 50,000 Gold
});

test('gold: a USDC open earns loyalty Gold (PACK_OPEN_EARN)', async () => {
  const user = await newUser();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'earn1' }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  assert.equal(await goldBal(user), 1250n); // $50 at the $1000 threshold
  assert.equal((await getGoldSummary(db, user)).untilFreePackGold, (25_000n - 1250n).toString());
});

test('gold: a gold-bought open spends Gold, funds CC from the rewards budget, earns nothing', async () => {
  const user = await newUser();
  await setGachaConfig(db, { payWithGoldEnabled: true }); // general pay-with-Gold (the toggle defaults off)
  await db.tx(async (q) => earnGold(q, user, 100_000n, 'SEED', {})); // enough for a $50 pack (50,000)
  const budgetBefore = await rewardsBudget();
  const collBefore = await collOf(user);
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tok1', payWith: 'gold' }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  assert.equal(r.status, 'opened');
  assert.equal(await goldBal(user), 100_000n - 50_000n); // spent the gold price; NO earn on a gold open
  assert.equal(await collOf(user), collBefore);           // no USDC collateral debit
  assert.equal((await rewardsBudget()) - budgetBefore, -PRICE); // the budget paid CC the real USDC
});

test('gold: a gold open with too few Gold is rejected (no pack, no charge)', async () => {
  const user = await newUser();
  await setGachaConfig(db, { payWithGoldEnabled: true });
  await assert.rejects(
    openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tok-broke', payWith: 'gold' }, { chain: fakeChain(), cc: fakeCc(), ...noWait }),
    /insufficient Gold/i,
  );
  assert.equal(await goldBal(user), 0n);
});

test('gold: Σ gold_ledger == gold_balances per user (invariant)', async () => {
  const user = await newUser();
  await setGachaConfig(db, { payWithGoldEnabled: true });
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tinv1' }, { chain: fakeChain(), cc: fakeCc(), ...noWait }); // +1250
  await db.tx(async (q) => earnGold(q, user, 100_000n, 'SEED', {}));
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tinv2', payWith: 'gold' }, { chain: fakeChain(), cc: fakeCc(), ...noWait }); // -50,000
  const ledgerSum = BigInt((await db.query<{ s: string }>(`SELECT COALESCE(SUM(delta),0)::text AS s FROM gold_ledger WHERE user_id = $1`, [user])).rows[0].s);
  assert.equal(ledgerSum, await goldBal(user));
  assert.equal(await goldBal(user), 1250n + 100_000n - 50_000n);
});

test('gold: a refunded gold-bought open returns Gold (not USDC) and reverses the budget', async () => {
  const user = await newUser();
  await setGachaConfig(db, { payWithGoldEnabled: true });
  await db.tx(async (q) => earnGold(q, user, 100_000n, 'SEED', {}));
  const cc = fakeCc();
  cc.alwaysWait = true;   // CC never reveals
  cc.packRefunded = true; // then reports refunded
  const future = () => Date.now() + 120_000;
  const collBefore = await collOf(user);
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'tref', payWith: 'gold' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(await goldBal(user), 100_000n - 50_000n); // spent the gold price
  const budgetAfterBuy = await rewardsBudget();
  const rec = await reconcilePending(db, user, { chain: fakeChain(), cc, now: future, ...noWait });
  assert.equal(rec.recovered, 1);
  assert.equal(await goldBal(user), 100_000n);                  // Gold fully returned
  assert.equal(await collOf(user), collBefore);                 // NO USDC credited (no money minted)
  assert.equal(await rewardsBudget(), budgetAfterBuy + PRICE);   // rewards budget reversed
});

// ── Gold gates: master switch · pay-with-Gold toggle · the free-pack-claim exception · reset ──
test('gold gate: master OFF rejects a Gold open (earn still works elsewhere)', async () => {
  const user = await newUser();
  await setGachaConfig(db, { goldEnabled: false });
  await db.tx(async (q) => earnGold(q, user, 100_000n, 'SEED', {}));
  await assert.rejects(openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'gm-off', payWith: 'gold' }, { chain: fakeChain(), cc: fakeCc(), ...noWait }), /Gold is not enabled/);
  await setGachaConfig(db, { goldEnabled: true }); // restore for later tests
});

test('gold gate: master ON but pay-with-Gold OFF rejects a general Gold open', async () => {
  const user = await newUser();
  await setGachaConfig(db, { goldEnabled: true, payWithGoldEnabled: false });
  await db.tx(async (q) => earnGold(q, user, 100_000n, 'SEED', {}));
  await assert.rejects(openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'pwg-off', payWith: 'gold' }, { chain: fakeChain(), cc: fakeCc(), ...noWait }), /paying with Gold is not available/);
});

test('gold gate: a free-pack CLAIM ($25) succeeds with pay-with-Gold OFF; a non-$25 claim is rejected', async () => {
  const user = await newUser();
  await setGachaConfig(db, { goldEnabled: true, payWithGoldEnabled: false });
  await db.tx(async (q) => earnGold(q, user, 30_000n, 'SEED', {}));
  const cc25 = fakeCc(); cc25.price = 25; // a $25 machine → gold cost 25,000 == FREE_PACK_GOLD
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'claim25', payWith: 'gold', claim: true }, { chain: fakeChain(), cc: cc25, ...noWait });
  assert.equal(r.status, 'opened');
  assert.equal(await goldBal(user), 30_000n - 25_000n); // spent the $25-pack gold price
  // a claim on a NON-$25 pack is rejected (the claim exception is the $25 reward only)
  await assert.rejects(openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'claim50', payWith: 'gold', claim: true }, { chain: fakeChain(), cc: fakeCc(), ...noWait }), /free-pack claim is the \$25 pack/);
});

test('gold reset: zeroes every balance + writes ADMIN_RESET, keeping the Σ invariant', async () => {
  const u1 = await newUser(); const u2 = await newUser();
  await db.tx(async (q) => { await earnGold(q, u1, 12_340n, 'SEED', {}); await earnGold(q, u2, 500n, 'SEED', {}); });
  const r = await resetGoldBalances(db);
  assert.ok(r.usersReset >= 2);
  assert.equal(await goldBal(u1), 0n);
  assert.equal(await goldBal(u2), 0n);
  const sum1 = BigInt((await db.query<{ s: string }>(`SELECT COALESCE(SUM(delta),0)::text AS s FROM gold_ledger WHERE user_id = $1`, [u1])).rows[0].s);
  assert.equal(sum1, 0n); // Σ ledger == balance == 0
  const reset = (await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM gold_ledger WHERE reason = 'ADMIN_RESET'`)).rows[0].n;
  assert.ok(Number(reset) >= 2);
});

// ── §12 admin: markup money-path + knob validation + the economics readout ──

test('open: a purchase markup charges the user more, banks it to FEE_REVENUE; CC still gets the base', async () => {
  await setGachaConfig(db, { markupBps: 200 }); // +2% over CC's $50 price
  try {
    const user = await newUser();
    const before = await collOf(user);
    const feeBefore = await feeRev();
    const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'mk' }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
    assert.equal(r.status, 'opened');
    assert.equal(await collOf(user), before - usdc(51));   // user paid $51 (all-in)
    assert.equal((await feeRev()) - feeBefore, usdc(1));    // GDEX kept the $1 markup
    assert.equal((await db.query<{ p: string }>(`SELECT price_e6::text AS p FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0].p, usdc(51).toString());
  } finally {
    await setGachaConfig(db, { markupBps: 0 }); // reset so later tests see the default
  }
});

test('open: markup=0 is byte-identical to no markup (no FEE_REVENUE leg)', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const feeBefore = await feeRev();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'nomk' }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  assert.equal(await collOf(user), before - PRICE);  // exactly the base price
  assert.equal((await feeRev()) - feeBefore, 0n);    // no markup fee posted
});

test('gacha config: knobs validate + round-trip; out-of-range + bad codes rejected', async () => {
  await setGachaConfig(db, { buybackCutBps: 700, turboCutBps: 1200, freePackThresholdUsd: 500 });
  const c = gachaAdminConfig();
  assert.equal(c.buybackCutBps, 700);
  assert.equal(c.turboCutBps, 1200);
  assert.equal(c.freePackThresholdUsd, 500);
  await assert.rejects(setGachaConfig(db, { buybackCutBps: 99999 }), /0–5000 bps/);
  await assert.rejects(setGachaConfig(db, { disabledMachines: ['bad code!'] }), /bad machine code/);
  await setGachaConfig(db, { disabledMachines: 'pokemon_25, pokemon_50' }); // csv string parses + dedups
  assert.deepEqual(gachaAdminConfig().disabledMachines, ['pokemon_25', 'pokemon_50']);
  await setGachaConfig(db, { buybackCutBps: 500, turboCutBps: 1000, freePackThresholdUsd: 1000, disabledMachines: [] }); // reset
});

test('monitoring: a sell-back grows the cut revenue + the sell-back rate', async () => {
  const m0 = await gachaMonitoring(db);
  const user = await newUser();
  const cc = fakeCc();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'mon1' }, { chain: fakeChain(), cc, ...noWait }); // delivered, held
  const prize = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE user_id = $1 ORDER BY acquired_at DESC LIMIT 1`, [user])).rows[0].id;
  await sellBack(db, user, prize, { chain: fakeChain(), cc, ...noWait }); // 5% cut of the $40 buyback → FEE_REVENUE
  const m = await gachaMonitoring(db);
  assert.ok(BigInt(m.sellBackCutE6) > BigInt(m0.sellBackCutE6)); // cut revenue grew
  assert.ok(m.deliveredCards >= 1 && m.soldBack >= 1);
  assert.ok(m.sellBackRatePct > 0);
});

test('monitoring: reports packs opened, the rarity mix, volume + per-machine stats', async () => {
  const user = await newUser();
  const cc = fakeCc();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 's1' }, { chain: fakeChain(), cc, ...noWait }); // epic
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 's2' }, { chain: fakeChain(), cc, ...noWait }); // epic
  const m = await gachaMonitoring(db);
  assert.ok(m.packsOpened >= 2);
  assert.ok((m.rarity.epic ?? 0) >= 2);            // epics counted in the realized mix
  assert.ok(BigInt(m.volumeUsdcE6) > 0n);          // USDC volume tracked
  assert.ok(BigInt(m.prizeValueE6) > 0n);          // prize value delivered tracked
  const pm = m.machines.find((x) => x.code === 'pokemon_50');
  assert.ok(pm && pm.opens >= 2);                  // per-machine opens
  assert.ok((pm.rarity.epic ?? 0) >= 2);           // per-machine realized odds
});

// ── lever C: convert a won card → a GDEX perp on its market (sell-back → openPosition) ──
async function seedMarket(markUsd: number | null) {
  const id = randomUUID();
  await db.query(`INSERT INTO markets(id, kind, game, symbol, display_name, status, tradeable, featured) VALUES($1,'card','pokemon',$2,$3,'active',true,true)`, [id, 'CONV-' + id.slice(0, 6), 'Conv ' + id.slice(0, 4)]);
  if (markUsd != null) await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1,$2,$2)`, [id, usdc(markUsd).toString()]);
  return id;
}
async function openAndMatch(user: string, key: string, marketId: string | null) {
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: key }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  const prize = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE user_id = $1 ORDER BY acquired_at DESC LIMIT 1`, [user])).rows[0];
  // set explicitly (incl. NULL) so we override any name-based auto-match left over from an earlier test
  await db.query(`UPDATE gacha_nft_inventory SET market_id = $2 WHERE id = $1`, [prize.id, marketId]);
  return prize.id;
}

test('convert: sells the card then opens a long perp sized so the proceeds are the margin', async () => {
  const user = await newUser();
  const marketId = await seedMarket(100); // $100 mark
  const prizeId = await openAndMatch(user, 'conv1', marketId);
  const r = await convert(db, user, prizeId, { chain: fakeChain(), cc: fakeCc(), ...noWait }, { side: 'long', leverage: 2 });
  assert.ok(r.positionId, 'a position opened');
  assert.ok(BigInt(r.payoutE6) > 0n);
  assert.equal((await db.query<{ s: string }>(`SELECT status s FROM gacha_nft_inventory WHERE id = $1`, [prizeId])).rows[0].s, 'sold'); // stage 1 done
  const pos = (await db.query<{ side: string; margin: string }>(`SELECT side, margin_uusdc::text margin FROM positions WHERE id = $1`, [r.positionId])).rows[0];
  assert.equal(pos.side, 'long');
  const d = BigInt(pos.margin) - BigInt(r.payoutE6); // margin ≈ proceeds (within $1 of rounding)
  assert.ok((d < 0n ? -d : d) <= usdc(1), `margin ${pos.margin} vs proceeds ${r.payoutE6}`);
});

test('convert: a card with no matched market is rejected (no_market) and stays held', async () => {
  const user = await newUser();
  const prizeId = await openAndMatch(user, 'conv2', null); // no market_id
  await assert.rejects(convert(db, user, prizeId, { chain: fakeChain(), cc: fakeCc(), ...noWait }), /market/i);
  assert.equal((await db.query<{ s: string }>(`SELECT status s FROM gacha_nft_inventory WHERE id = $1`, [prizeId])).rows[0].s, 'held'); // never sold
});

test('convert: if the position fails to open, the user keeps the sell-back proceeds', async () => {
  const user = await newUser();
  const marketId = await seedMarket(null); // market with NO mark → stage 2 can't price → fails gracefully
  const prizeId = await openAndMatch(user, 'conv3', marketId);
  const before = await collOf(user);
  const r = await convert(db, user, prizeId, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  assert.equal(r.positionId, null);
  assert.ok(r.positionError);
  assert.equal((await db.query<{ s: string }>(`SELECT status s FROM gacha_nft_inventory WHERE id = $1`, [prizeId])).rows[0].s, 'sold'); // stage 1 still committed
  assert.ok((await collOf(user)) > before, 'proceeds credited to the user');
});

// ── stuck-row reconciler (recover 'selling'/'withdrawing' stranded by a crash; DAS owner is the oracle) ──
async function seedStuck(user: string, mint: string, status: string, custody: string, settledAtIso: string) {
  const id = randomUUID();
  await db.query(`INSERT INTO gacha_nft_inventory(id, user_id, mint, custody_pubkey, status, settled_at) VALUES($1,$2,$3,$4,$5,$6)`,
    [id, user, mint, custody, status, settledAtIso]);
  return id;
}
const statusOf = async (id: string) => (await db.query<{ s: string }>(`SELECT status s FROM gacha_nft_inventory WHERE id = $1`, [id])).rows[0].s;
// a DAS stub that only "knows" the target mint (every other row in the global scan → null → skipped, so a test
// asserts on its own row only). owner === custody means "still in custody".
const dasFor = (mint: string, owner: string) => async (m: string) => (m === mint ? { collection: null, owner, frozen: false } : null);
const STALE = new Date(Date.now() - 3_600_000).toISOString();

test('reconcile-stuck: selling + NFT still in custody → released to held', async () => {
  const id = await seedStuck(await newUser(), 'RC-S-CUST', 'selling', 'CUSTODY1', STALE);
  const r = await reconcileStuckPrizes(db, { getAssetInfo: dasFor('RC-S-CUST', 'CUSTODY1') });
  assert.equal(r.revertedToHeld, 1);
  assert.equal(await statusOf(id), 'held');
});

test('reconcile-stuck: selling + NFT gone (sold on-chain, unsettled) → flagged, left for an operator', async () => {
  const id = await seedStuck(await newUser(), 'RC-S-GONE', 'selling', 'CUSTODY2', STALE);
  const r = await reconcileStuckPrizes(db, { getAssetInfo: dasFor('RC-S-GONE', 'COLLECTORCRYPT') });
  assert.equal(r.flaggedSelling, 1);
  assert.equal(await statusOf(id), 'selling'); // can't auto-credit → needs a manual settle
});

test('reconcile-stuck: withdrawing + NFT left custody → marked withdrawn', async () => {
  const id = await seedStuck(await newUser(), 'RC-W-GONE', 'withdrawing', 'CUSTODY3', STALE);
  const r = await reconcileStuckPrizes(db, { getAssetInfo: dasFor('RC-W-GONE', 'USER-WALLET') });
  assert.equal(r.markedWithdrawn, 1);
  assert.equal(await statusOf(id), 'withdrawn');
});

test('reconcile-stuck: withdrawing + NFT still in custody → released to held', async () => {
  const id = await seedStuck(await newUser(), 'RC-W-CUST', 'withdrawing', 'CUSTODY4', STALE);
  const r = await reconcileStuckPrizes(db, { getAssetInfo: dasFor('RC-W-CUST', 'CUSTODY4') });
  assert.equal(r.revertedToHeld, 1);
  assert.equal(await statusOf(id), 'held');
});

test('reconcile-stuck: a freshly-claimed row inside the grace window is never touched', async () => {
  const id = await seedStuck(await newUser(), 'RC-FRESH', 'selling', 'CUSTODY5', new Date().toISOString());
  await reconcileStuckPrizes(db, { graceSec: 300, getAssetInfo: dasFor('RC-FRESH', 'CUSTODY5') });
  assert.equal(await statusOf(id), 'selling'); // within grace → not scanned
});

test('reconcile-stuck: DAS unavailable (null) → row left untouched, counted skipped', async () => {
  const id = await seedStuck(await newUser(), 'RC-DASNULL', 'selling', 'CUSTODY6', STALE);
  const r = await reconcileStuckPrizes(db, { getAssetInfo: async () => null });
  assert.ok(r.skipped >= 1);
  assert.equal(await statusOf(id), 'selling');
});

// ── stock worker: persist CC stock + log restocks (so they survive a closed admin tab) ──
const machinesFn = (code: string, stock: Record<string, number>) => async () => ({ machines: [{ code, stock }] });
const stockOf = async (code: string, tier: string) =>
  (await db.query<{ stock: number }>(`SELECT stock FROM gacha_machine_stock WHERE machine_code = $1 AND tier = $2`, [code, tier])).rows[0]?.stock;
const restocksOf = async (code: string) => (await recentRestocks(db)).filter((e) => e.machineCode === code);

test('stock poll: first sighting records the stock with no restock event', async () => {
  const code = 'rcA-' + randomUUID().slice(0, 6);
  const r = await pollMachineStock(db, { getMachinesFn: machinesFn(code, { common: 100, epic: 5 }) });
  assert.equal(r.restocks, 0);
  assert.equal(await stockOf(code, 'epic'), 5);
  assert.equal((await restocksOf(code)).length, 0);
});

test('stock poll: a tier whose stock went UP logs a restock event (delta + from/to)', async () => {
  const code = 'rcB-' + randomUUID().slice(0, 6);
  await pollMachineStock(db, { getMachinesFn: machinesFn(code, { epic: 2 }) });
  const r = await pollMachineStock(db, { getMachinesFn: machinesFn(code, { epic: 9 }) }); // +7
  assert.equal(r.restocks, 1);
  const ev = await restocksOf(code);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].tier, ev[0].fromStock, ev[0].toStock, ev[0].delta], ['epic', 2, 9, 7]);
  assert.equal(await stockOf(code, 'epic'), 9);
});

test('stock poll: a decrease (pulls) updates the stock but logs no event', async () => {
  const code = 'rcC-' + randomUUID().slice(0, 6);
  await pollMachineStock(db, { getMachinesFn: machinesFn(code, { rare: 50 }) });
  await pollMachineStock(db, { getMachinesFn: machinesFn(code, { rare: 30 }) });
  assert.equal((await restocksOf(code)).length, 0);
  assert.equal(await stockOf(code, 'rare'), 30);
});

test('fundGachaRewardsBudget: sweeps FEE_REVENUE → rewards budget, capped at fees, balanced', async () => {
  // Seed a known FEE_REVENUE amount (balanced against TREASURY_USDC). Appended last so the seed can't skew earlier tests.
  await db.tx(async (q) => {
    const fee = await sysAcct(q, 'FEE_REVENUE');
    const tre = await sysAcct(q, 'TREASURY_USDC');
    await ledgerPostTxn(q, { reason: 'TEST_SEED', entries: [{ accountId: fee, amount: 10_000_000n }, { accountId: tre, amount: -10_000_000n }] });
  });
  const feeAvail = await feeRev();
  const budgetBefore = BigInt((await gachaMonitoring(db)).rewardsBudgetE6);

  const r = await fundGachaRewardsBudget(db, 4_000_000n); // sweep $4
  assert.equal(BigInt(r.movedE6), 4_000_000n);
  assert.equal(BigInt(r.feeRevenueE6), feeAvail - 4_000_000n); // fees drop by the swept amount
  assert.equal(BigInt(r.rewardsBudgetE6), budgetBefore + 4_000_000n); // budget rises by it
  assert.equal(await feeRev(), feeAvail - 4_000_000n);

  // Can't sweep more than the remaining earned fees (no inventing USDC / negative FEE_REVENUE).
  await assert.rejects(() => fundGachaRewardsBudget(db, feeAvail), /exceeds|insufficient/i);
  await assert.rejects(() => fundGachaRewardsBudget(db, 0n), /positive/i);
  assert.equal(await feeRev(), feeAvail - 4_000_000n); // unchanged after the rejected sweeps

  // Double-entry holds across the whole ledger.
  const sum = await db.query<{ s: string }>(`SELECT COALESCE(SUM(amount_uusdc), 0)::text AS s FROM ledger_entries`);
  assert.equal(BigInt(sum.rows[0].s), 0n);
});

test('listInventory: surfaces each held card’s rarity (joined from its open — no rarity column on the inventory row)', async () => {
  const user = await newUser();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'inv-rarity' }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  const inv = await listInventory(db, user);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].status, 'held');
  assert.equal(inv[0].rarity, 'epic'); // the fake reveal is an epic → pulled through the LEFT JOIN to gacha_pack_opens
});

test('re-circulated mint: an NFT a prior holder SOLD BACK records to the new owner (no longer blocked by the stale sold row)', async () => {
  const a = await newUser(); const b = await newUser();
  const cc = fakeCc();
  const reveal = keptReveal();            // one specific mint
  const mint = reveal.nft_address;
  cc.reveals = [reveal];
  await openPack(db, a, { machineCode: 'pokemon_50', idempotencyKey: 'recirc-a' }, { chain: fakeChain(), cc, ...noWait });
  const aRow = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE user_id=$1 AND mint=$2`, [a, mint])).rows[0];
  assert.ok(aRow, 'A received the held row');
  await sellBack(db, a, aRow.id, { chain: fakeChain(), cc, ...noWait }); // → A's row goes 'sold' (NFT back to CC's pool)
  // B opens; CC re-rolls the SAME mint back out of the pool
  cc.reveals = [{ ...reveal }];
  const rb = await openPack(db, b, { machineCode: 'pokemon_50', idempotencyKey: 'recirc-b' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(rb.status, 'opened');
  const bInv = await listInventory(db, b);
  assert.equal(bInv.length, 1);          // THE FIX: B gets the held row (old global-unique code recorded 0)
  assert.equal(bInv[0].mint, mint);
});

test('phantom delivery: a reveal mint still ACTIVELY held elsewhere refunds instead of double-recording', async () => {
  const a = await newUser(); const b = await newUser();
  const cc = fakeCc();
  const reveal = keptReveal();
  cc.reveals = [reveal];
  await openPack(db, a, { machineCode: 'pokemon_50', idempotencyKey: 'phantom-a' }, { chain: fakeChain(), cc, ...noWait });
  // A KEEPS it ('held'); CC erroneously re-reports the SAME mint for B — it can't be in two custodies at once.
  cc.reveals = [{ ...reveal }];
  const before = await collOf(b);
  const rb = await openPack(db, b, { machineCode: 'pokemon_50', idempotencyKey: 'phantom-b' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(rb.status, 'failed');          // refunded, not falsely delivered
  assert.equal(await collOf(b), before);      // charged then refunded → net zero
  assert.equal((await listInventory(db, b)).length, 0); // no phantom inventory row
});
