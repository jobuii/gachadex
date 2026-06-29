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
const { openPack, sellBack, convert, reconcilePending, reconcileAllPending, scanCustodyLeftovers, autoSweepCustodyLeftovers, nftWithdrawNonce, requestNftWithdraw, extractCard, listInventory, remediateMisrecordedTurboCommon } = await import('./gacha.ts');
const { config } = await import('../config.ts');
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
    custodyBalances: {} as Record<string, bigint>, // tests set this to simulate on-chain custody USDC
    async custodyUsdcBalances(pubkeys: string[]) { const o: Record<string, bigint> = {}; for (const pk of pubkeys) o[pk] = c.custodyBalances[pk] ?? 0n; return o; },
    sweeps: [] as { custody: string; amountE6: bigint }[],
    async sweepCustodyUsdc(custody: Keypair, amountE6: bigint) { c.sweeps.push({ custody: custody.publicKey.toBase58(), amountE6 }); return { sig: `sweep-${c.sweeps.length}` }; },
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
    submitConf: 'finalized' as string, // submitTransaction confirmationStatus ('confirmed'|'finalized'|'submitted')
    packRefunded: false,
    packStatus: undefined as string | undefined, // getPackStatus pack.status ('confirmed' = the payment landed)
    turboBuybackConfirmed: true, // getPackStatus reports the turbo auto-sell buyback as webhook-confirmed (set false to test the #6 defer)
    alwaysWait: false,
    buybackAmount: 40_000_000, // base units ($40)
    submits: 0,
    async getMachines() { return { machines: [{ code: 'pokemon_50', name: 'Elite', price: cc.price, instantBuyback: 85, odds: {}, stock: {} }] }; },
    async getNfts() { return { nfts: [] }; },
    async generatePack(_p: unknown) { if (cc.generateFail) throw new Error('generatePack failed'); return { memo: `memo-${randomUUID().slice(0, 8)}`, transaction: 'unsigned' }; },
    async submitTransaction(_s: string) { cc.submits++; if (cc.submitThrow) throw new Error('simulated submit failure (broadcast-then-timeout)'); return { success: !cc.submitNoSig, signature: cc.submitNoSig ? '' : `paysig-${cc.submits}`, confirmationStatus: cc.submitConf }; },
    async openPackReveal(_m: string) { if (cc.alwaysWait) return waiting() as never; return (cc.reveals.length ? cc.reveals.shift() : keptReveal()) as never; },
    async getPackStatus(m: string) { return { memo: m, pack: { refunded: cc.packRefunded, status: cc.packStatus }, send: null, buyback: cc.turboBuybackConfirmed ? [{ refund_amount: String(cc.buybackAmount), status: 'complete', webhook_confirmed: true }] : [] }; },
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

test('open: an operator-disabled machine is rejected on the BUY path (not just hidden), no charge (#8)', async () => {
  const user = await newUser();
  const before = await collOf(user);
  await setGachaConfig(db, { disabledMachines: ['pokemon_50'] }); // operator disables the machine
  try {
    const cc = fakeCc();
    await assert.rejects(
      openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'disabled' }, { chain: fakeChain(), cc, ...noWait }),
      (e: unknown) => (e as { code?: string })?.code === 'machine_disabled',
    );
    assert.equal(await collOf(user), before, 'no charge for a disabled machine');
    assert.equal(cc.submits, 0, 'never paid CC');
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int n FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0].n, 0, 'no open row created');
  } finally {
    await setGachaConfig(db, { disabledMachines: [] }); // reset
  }
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

test('open: a never-landed payment is refunded after the hard window + funding becomes recoverable (bug #2)', async () => {
  const user = await newUser();
  const cc = fakeCc();
  cc.alwaysWait = true; // CC never confirms a reveal → the open stays 'paid' (payment unconfirmed)
  const before = await collOf(user);
  const chain = fakeChain();
  const r0 = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'unlanded' }, { chain, cc, ...noWait });
  assert.equal(r0.status, 'paid'); // charged, no card — stuck 'paid'
  assert.equal(await collOf(user), before - PRICE); // debited
  const open = (await db.query<{ custody_pubkey: string }>(`SELECT custody_pubkey FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0];
  const statusNow = async () => (await db.query<{ s: string }>(`SELECT status s FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0].s;
  chain.custodyBalances[open.custody_pubkey] = PRICE; // the price never left the custody — the payment never executed

  // INSIDE the hard window: stays conservative (NOT refunded) even though CC has no confirmed purchase.
  await reconcileAllPending(db, { chain, cc, now: () => Date.now() + 120_000, ...noWait }); // >90s grace, <10min window
  assert.equal(await statusNow(), 'paid', 'not refunded inside the hard window');
  assert.equal(await collOf(user), before - PRICE);

  // PAST the hard window: CC still reports no confirmed purchase + the funding is still in custody → refund.
  await reconcileAllPending(db, { chain, cc, now: () => Date.now() + 11 * 60_000, ...noWait });
  assert.equal(await statusNow(), 'failed', 'refunded once the payment provably expired');
  assert.equal(await collOf(user), before, 'buyer made whole');

  // and the open is no longer 'paid' → autoSweepCustodyLeftovers can now reclaim the stranded funding (was blocked).
  const { custodies } = await scanCustodyLeftovers(db, { chain, cc, ...noWait });
  assert.ok(custodies.some((x) => x.custodyPubkey === open.custody_pubkey), 'stranded custody funding now recoverable');
});

test('open: a LANDED payment (CC status=confirmed) is NEVER refunded, even past the hard window with funds in custody', async () => {
  const user = await newUser();
  const cc = fakeCc();
  cc.alwaysWait = true; // reveal not delivered yet, but...
  cc.packStatus = 'confirmed'; // ...CC confirms the purchase LANDED → the money is at CC awaiting delivery, not lost
  const chain = fakeChain();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'landed' }, { chain, cc, ...noWait });
  const open = (await db.query<{ custody_pubkey: string }>(`SELECT custody_pubkey FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0];
  chain.custodyBalances[open.custody_pubkey] = PRICE; // even with funds visible in the (shared per-user) custody…
  await reconcileAllPending(db, { chain, cc, now: () => Date.now() + 11 * 60_000, ...noWait });
  // …a confirmed purchase is the real guard — it is never refunded (the balance gate alone must NOT trigger it).
  assert.equal((await db.query<{ s: string }>(`SELECT status s FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0].s, 'paid');
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

test('open: a refunded USDC open also reverses the loyalty Gold earned at payment', async () => {
  const user = await newUser();
  const cc = fakeCc();
  cc.reveals = [{ success: true, code: 'WEIRD_UNHANDLED' }]; // non-deliverable → refund path
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'goldrev' }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(r.status, 'failed');
  // the $50 open earned Gold at payment, then the refund reversed it → net 0
  assert.equal((await getGoldSummary(db, user)).balance, '0', 'earned Gold clawed back on refund');
  // both legs are on the ledger for audit and net to zero
  const rows = (await db.query<{ reason: string; delta: string }>(
    `SELECT reason, delta::text AS delta FROM gold_ledger WHERE user_id = $1 ORDER BY created_at, delta DESC`, [user])).rows;
  assert.deepEqual(rows.map((x) => x.reason), ['PACK_OPEN_EARN', 'PACK_OPEN_EARN_REVERSAL']);
  assert.equal(BigInt(rows[0].delta) + BigInt(rows[1].delta), 0n, 'earn + reversal net to zero');
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

test('open: YOLO/turbo — an UNCONFIRMED auto-sell is NOT credited; left paid until the reconciler confirms it (#6)', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const cc = fakeCc();
  const turboReveal = { success: true, code: 'TURBO_MODE_BUYBACK', buybackAmount: 30_000_000 }; // auto-sold $30
  cc.reveals = [{ ...turboReveal }];
  cc.turboBuybackConfirmed = false; // CC hasn't confirmed the auto-sell USDC landed yet
  const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'yolo-unconf', turbo: true }, { chain: fakeChain(), cc, ...noWait });
  assert.equal(r.status, 'paid'); // NOT credited on an unconfirmed buyback — deferred
  assert.equal(await collOf(user), before - PRICE); // debited the pack, NOT credited the $27

  // the reconciler settles it once CC confirms the buyback landed (re-reveal returns CC's same turbo response)
  cc.turboBuybackConfirmed = true;
  cc.reveals = [{ ...turboReveal }];
  const rec = await reconcilePending(db, user, { chain: fakeChain(), cc, now: () => Date.now() + 120_000, ...noWait });
  assert.equal(rec.recovered, 1);
  assert.equal((await db.query<{ s: string }>(`SELECT status s FROM gacha_pack_opens WHERE user_id = $1`, [user])).rows[0].s, 'turbo_sold');
  assert.equal(await collOf(user), before - PRICE + 27_000_000n); // now credited 90% of $30
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

test('gacha affiliate: a referred player\'s sell-back pays the referrer their game-revenue share of the cut', async () => {
  const affiliate = await newUser();
  await db.query(`INSERT INTO affiliate_terms(user_id, game_revenue_bps, active) VALUES($1, 2000, true)`, [affiliate]); // 20% of gacha house revenue
  const player = await newUser();
  await db.query(`UPDATE users SET referred_by = $2 WHERE id = $1`, [player, affiliate]);
  const cc = fakeCc();
  cc.buybackAmount = 100_000_000; // CC buys back $100 → the sell-back cut hits FEE_REVENUE
  const affBefore = await collOf(affiliate);
  const r = await openPack(db, player, { machineCode: 'pokemon_50', idempotencyKey: 'refsell' }, { chain: fakeChain(), cc, ...noWait });
  const prizeId = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE open_id=$1`, [r.openId])).rows[0].id;
  await sellBack(db, player, prizeId, { chain: fakeChain(), cc, ...noWait });
  const cut = BigInt((await db.query<{ c: string }>(`SELECT sell_cut_e6 AS c FROM gacha_nft_inventory WHERE id=$1`, [prizeId])).rows[0].c);
  assert.ok(cut > 0n); // GDEX kept a cut
  assert.equal(await collOf(affiliate) - affBefore, (cut * 2000n) / 10000n); // referrer got 20% of that cut
});

test('gacha affiliate: a NON-referred player\'s sell-back keeps the full cut in FEE_REVENUE', async () => {
  const player = await newUser(); // no referrer
  const cc = fakeCc();
  cc.buybackAmount = 100_000_000;
  const feeBefore = await feeRev();
  const r = await openPack(db, player, { machineCode: 'pokemon_50', idempotencyKey: 'norefsell' }, { chain: fakeChain(), cc, ...noWait });
  const prizeId = (await db.query<{ id: string }>(`SELECT id FROM gacha_nft_inventory WHERE open_id=$1`, [r.openId])).rows[0].id;
  await sellBack(db, player, prizeId, { chain: fakeChain(), cc, ...noWait });
  const cut = BigInt((await db.query<{ c: string }>(`SELECT sell_cut_e6 AS c FROM gacha_nft_inventory WHERE id=$1`, [prizeId])).rows[0].c);
  assert.equal((await feeRev()) - feeBefore, cut); // full cut stays — no affiliate slice
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

test('refund: a marked-up buy fully reverses the markup from FEE_REVENUE (no PoR leak) — bug #3', async () => {
  await setGachaConfig(db, { markupBps: 1000 }); // +10% over CC's $50 price
  try {
    const user = await newUser();
    const cc = fakeCc();
    cc.generateFail = true; // pre-payment failure → immediate refund (settleRefund 'failed'), AFTER the buy posted the markup
    const collBefore = await collOf(user);
    const feeBefore = await feeRev();
    const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'mk-rf' }, { chain: fakeChain(), cc, ...noWait });
    assert.equal(r.status, 'failed'); // refunded
    assert.equal(await collOf(user), collBefore, 'buyer fully refunded the all-in (price + markup)');
    assert.equal(await feeRev(), feeBefore, 'markup reversed out of FEE_REVENUE — net zero, nothing left unbacked (the #3 leak)');
  } finally {
    await setGachaConfig(db, { markupBps: 0 }); // reset
  }
});

const MK_SHARE = (usdc(50) * 1000n) / 10000n * 1000n / 10000n; // 10% game-rev share of the $5 (10%) markup = $0.50
async function referredBuyer(): Promise<{ aff: string; buyer: string }> {
  const aff = await newUser();
  await db.query(`INSERT INTO affiliate_terms(user_id, game_revenue_bps, active) VALUES($1, 1000, true)`, [aff]); // 10% game-revenue share
  const buyer = await newUser();
  await db.query(`UPDATE users SET referred_by = $1 WHERE id = $2`, [aff, buyer]);
  return { aff, buyer };
}

test('refund: a marked-up buy by a referred player pays NO affiliate commission — the share accrues at delivery, not buy', async () => {
  await setGachaConfig(db, { markupBps: 1000 }); // +10% = $5 markup on the $50 base
  try {
    const { aff, buyer } = await referredBuyer();
    const cc = fakeCc();
    cc.generateFail = true; // refunded BEFORE delivery → never a completed sale
    const buyerBefore = await collOf(buyer);
    const affBefore = await collOf(aff);
    const feeBefore = await feeRev();
    const r = await openPack(db, buyer, { machineCode: 'pokemon_50', idempotencyKey: 'mk-aff-refund' }, { chain: fakeChain(), cc, ...noWait });
    assert.equal(r.status, 'failed');
    assert.equal(await collOf(buyer), buyerBefore, 'buyer fully refunded the all-in');
    assert.equal(await collOf(aff), affBefore, 'affiliate paid NOTHING on a refunded buy (no commission on a non-sale)');
    assert.equal(await feeRev(), feeBefore, 'FEE_REVENUE nets to zero — markup reversed, no share ever accrued');
  } finally {
    await setGachaConfig(db, { markupBps: 0 }); // reset
  }
});

test('open: a marked-up DELIVERED pack by a referred player pays the affiliate the markup share AT DELIVERY', async () => {
  await setGachaConfig(db, { markupBps: 1000 }); // +10% = $5 markup
  try {
    const { aff, buyer } = await referredBuyer();
    const cc = fakeCc(); // default reveal → delivered (a completed sale)
    const affBefore = await collOf(aff);
    const feeBefore = await feeRev();
    const r = await openPack(db, buyer, { machineCode: 'pokemon_50', idempotencyKey: 'mk-aff-open' }, { chain: fakeChain(), cc, ...noWait });
    assert.equal(r.status, 'opened'); // delivered
    assert.equal(await collOf(aff), affBefore + MK_SHARE, 'affiliate earns the markup share on a completed (delivered) sale');
    assert.equal((await feeRev()) - feeBefore, usdc(5) - MK_SHARE, 'FEE_REVENUE keeps markup − share');
  } finally {
    await setGachaConfig(db, { markupBps: 0 }); // reset
  }
});

test('open: a marked-up TURBO auto-sell by a referred player also pays the affiliate the markup share (completed sale)', async () => {
  await setGachaConfig(db, { markupBps: 1000 }); // +10% = $5 markup
  try {
    const { aff, buyer } = await referredBuyer();
    const cc = fakeCc();
    cc.reveals = [{ success: true, code: 'TURBO_MODE_BUYBACK', buybackAmount: 30_000_000 }]; // auto-sold $30 (confirmed by default)
    const affBefore = await collOf(aff);
    const r = await openPack(db, buyer, { machineCode: 'pokemon_50', idempotencyKey: 'mk-aff-turbo', turbo: true }, { chain: fakeChain(), cc, ...noWait });
    assert.equal(r.status, 'turbo_sold');
    const cutShare = (usdc(30) * 1000n) / 10000n * 1000n / 10000n; // 10% of the 10% turbo cut on $30 = $0.30
    assert.equal(await collOf(aff), affBefore + cutShare + MK_SHARE, 'affiliate earns BOTH the turbo-cut share and the markup share');
  } finally {
    await setGachaConfig(db, { markupBps: 0 }); // reset
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

test('monitoring: a refunded marked-up pack nets its markup back out of the dashboard revenue (#3 display)', async () => {
  await setGachaConfig(db, { markupBps: 1000 }); // +10% over CC's $50 price
  try {
    const m0 = await gachaMonitoring(db);
    const pm0 = m0.machines.find((x) => x.code === 'pokemon_50');
    const user = await newUser();
    const cc = fakeCc();
    cc.generateFail = true; // pre-payment fail → refund AFTER the markup (and its FEE_REVENUE leg) was booked
    const r = await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'mon-mkrf' }, { chain: fakeChain(), cc, ...noWait });
    assert.equal(r.status, 'failed');
    // The buy banks +markup, the refund reverses −markup; the dashboard counts BOTH, so the displayed markup +
    // total revenue are unchanged. Pre-fix they'd have risen by the refunded markup (the over-report).
    const m = await gachaMonitoring(db);
    assert.equal(m.markupE6, m0.markupE6, 'displayed markup revenue nets the refunded markup');
    assert.equal(m.revenueE6, m0.revenueE6, 'total revenue nets it too');
    const pm = m.machines.find((x) => x.code === 'pokemon_50');
    assert.equal(pm?.revenueE6 ?? '0', pm0?.revenueE6 ?? '0', 'per-machine revenue nets it as well');
  } finally {
    await setGachaConfig(db, { markupBps: 0 }); // reset
  }
});

test('monitoring: a CAPITALIZED DB rarity is lowercased so the web tiers match (no real pull reads 0%)', async () => {
  const user = await newUser();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'rmix' }, { chain: fakeChain(), cc: fakeCc(), ...noWait });
  // production CC stores capitalized tiers ('Epic'); force one here so this guards the casing fix on its OWN
  // fixture, independent of test ordering (the fake reveal happens to write lowercase).
  await db.query(`UPDATE gacha_pack_opens SET rarity = 'Epic' WHERE user_id = $1 AND idempotency_key = 'rmix'`, [user]);
  const m = await gachaMonitoring(db);
  // every key must be lowercase to match the web's RARITY_TIERS (pre-fix the 'Epic' row keys as 'Epic' → fails)
  const keys = Object.keys(m.rarity);
  assert.ok(keys.length > 0 && keys.every((k) => k === k.toLowerCase()), `rarity keys must be lowercase, got: ${keys.join(', ')}`);
  // and that capitalized Epic pull is counted on the lowercase 'epic' tier (would read 0% pre-fix)
  assert.ok((m.rarity.epic ?? 0) >= 1, 'the capitalized Epic open is counted under the lowercase epic tier');
  // per-machine keys are lowercase too
  for (const mc of m.machines) for (const k of Object.keys(mc.rarity)) assert.equal(k, k.toLowerCase(), `machine ${mc.code} rarity key "${k}" must be lowercase`);
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

test('reconcile-stuck: selling + NFT gone but NO CC buyback amount (no open_id) → flagged for a manual settle', async () => {
  const id = await seedStuck(await newUser(), 'RC-S-GONE', 'selling', 'CUSTODY2', STALE);
  const r = await reconcileStuckPrizes(db, { getAssetInfo: dasFor('RC-S-GONE', 'COLLECTORCRYPT') });
  assert.equal(r.flaggedSelling, 1);
  assert.equal(await statusOf(id), 'selling'); // no memo → no verified amount → fall back to a manual settle
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

test('sell-back: an UNCONFIRMED ("submitted") buyback defers — no credit, row left selling, then the reconciler settles it', async () => {
  const user = await newUser();
  const cc = fakeCc();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'sb-unconf' }, { chain: fakeChain(), cc, ...noWait });
  const row = (await db.query<{ id: string; mint: string }>(`SELECT id, mint FROM gacha_nft_inventory WHERE user_id = $1 ORDER BY acquired_at DESC LIMIT 1`, [user])).rows[0];
  const before = await collOf(user);

  // CC broadcasts the buyback but reports it only 'submitted' (sent, not yet landed) → must NOT credit now.
  cc.submitConf = 'submitted';
  await assert.rejects(
    sellBack(db, user, row.id, { chain: fakeChain(), cc, ...noWait }),
    (e: unknown) => (e as { code?: string })?.code === 'buyback_pending',
  );
  assert.equal(await collOf(user), before, 'no payout credited on an unconfirmed buyback');
  assert.equal(await statusOf(row.id), 'selling', 'row left selling (not reverted, not settled) for the reconciler');

  // The reconciler resolves it: DAS shows the NFT left custody (buyback landed) + CC confirms the amount → settle.
  const reconcileCc = { getPackStatus: async () => ({ memo: 'm', pack: null, send: null, buyback: [{ refund_amount: String(cc.buybackAmount), status: 'complete' }] }) };
  const r = await reconcileStuckPrizes(db, { graceSec: 0, getAssetInfo: dasFor(row.mint, 'COLLECTORCRYPT'), cc: reconcileCc });
  assert.equal(r.settledSelling, 1, 'reconciler auto-settled the sold-but-unsettled prize');
  assert.ok((await collOf(user)) > before, 'reconciler credited the seller');
  assert.equal(await statusOf(row.id), 'sold');
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

// ── sell-back / reconciler: DAS-gated revert + auto-settle (no stale 'held'; the seller is made whole) ──
test('sell-back failure + NFT CONFIRMED still in custody → reverts to held (safe retry)', async () => {
  const user = await newUser();
  const cc = fakeCc();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'sbf-cust' }, { chain: fakeChain(), cc, ...noWait });
  const row = (await db.query<{ id: string; mint: string; custody_pubkey: string }>(`SELECT id, mint, custody_pubkey FROM gacha_nft_inventory WHERE user_id=$1`, [user])).rows[0];
  cc.submitThrow = true; // buyback broadcast fails AFTER the held→selling claim
  await assert.rejects(sellBack(db, user, row.id, { chain: fakeChain(), cc, ...noWait, getAssetInfo: dasFor(row.mint, row.custody_pubkey) }));
  assert.equal(await statusOf(row.id), 'held'); // NFT still ours → released for retry
});

test('sell-back failure + NFT NOT in custody (broadcast-then-timeout) → left "selling" for the reconciler (no stale held)', async () => {
  const user = await newUser();
  const cc = fakeCc();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'sbf-gone' }, { chain: fakeChain(), cc, ...noWait });
  const row = (await db.query<{ id: string; mint: string }>(`SELECT id, mint FROM gacha_nft_inventory WHERE user_id=$1`, [user])).rows[0];
  cc.submitThrow = true;
  await assert.rejects(sellBack(db, user, row.id, { chain: fakeChain(), cc, ...noWait, getAssetInfo: dasFor(row.mint, 'COLLECTORCRYPT') }));
  assert.equal(await statusOf(row.id), 'selling'); // NFT gone → NOT reverted to 'held' (a stale held would be a phantom)
});

test('reconcile-stuck: selling + NFT gone + CC confirmed buyback → AUTO-SETTLED (credits the seller, marks sold)', async () => {
  const user = await newUser();
  const cc = fakeCc();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'rc-settle' }, { chain: fakeChain(), cc, ...noWait });
  const row = (await db.query<{ id: string; mint: string }>(`SELECT id, mint FROM gacha_nft_inventory WHERE user_id=$1`, [user])).rows[0];
  await db.query(`UPDATE gacha_nft_inventory SET status='selling', settled_at=$2 WHERE id=$1`, [row.id, STALE]); // crashed sell-back: stuck 'selling', NFT gone
  const collBefore = await collOf(user); const feeBefore = await feeRev();
  const GROSS = 40_000_000n;
  const r = await reconcileStuckPrizes(db, {
    getAssetInfo: dasFor(row.mint, 'COLLECTORCRYPT'),
    cc: { getPackStatus: async () => ({ memo: 'm', pack: { refunded: false }, send: null, buyback: [{ refund_amount: GROSS.toString(), status: 'confirmed' }] }) },
  });
  assert.equal(r.settledSelling, 1);
  assert.equal(await statusOf(row.id), 'sold');
  const collDelta = (await collOf(user)) - collBefore;
  const feeDelta = (await feeRev()) - feeBefore;
  assert.ok(collDelta > 0n, 'seller credited the payout');
  assert.equal(collDelta + feeDelta, GROSS); // the full gross splits: payout → user, cut → FEE_REVENUE
});

// ── reconcileAllPending: unattended boot/timer backstop for stranded 'paid' opens (the prevention) ──
test('reconcileAllPending: an aged stuck "paid" open (crashed before CC) is auto-refunded for ANY user', async () => {
  const user = await newUser();
  const before = await collOf(user);
  const id = randomUUID();
  await db.query(
    `INSERT INTO gacha_pack_opens(id, user_id, idempotency_key, machine_code, price_e6, custody_pubkey, paid_with, turbo, status, created_at)
     VALUES($1,$2,$3,'pokemon_50',$4,'CUST-X','usdc',false,'paid', now() - interval '10 minutes')`,
    [id, user, 'stuck-' + id, PRICE.toString()],
  );
  const r = await reconcileAllPending(db, { chain: fakeChain(), cc: fakeCc() });
  assert.ok(r.recovered >= 1);
  assert.equal((await db.query<{ s: string }>(`SELECT status s FROM gacha_pack_opens WHERE id=$1`, [id])).rows[0].s, 'failed');
  assert.equal(await collOf(user), before + PRICE); // the customer's money is returned
});

test('reconcileAllPending: a FRESH paid open (inside the grace) is never touched', async () => {
  const user = await newUser();
  const id = randomUUID();
  await db.query(
    `INSERT INTO gacha_pack_opens(id, user_id, idempotency_key, machine_code, price_e6, custody_pubkey, paid_with, turbo, status)
     VALUES($1,$2,$3,'pokemon_50',$4,'CUST-X','usdc',false,'paid')`,
    [id, user, 'fresh-' + id, PRICE.toString()],
  );
  await reconcileAllPending(db, { chain: fakeChain(), cc: fakeCc() });
  assert.equal((await db.query<{ s: string }>(`SELECT status s FROM gacha_pack_opens WHERE id=$1`, [id])).rows[0].s, 'paid'); // within grace → untouched
});

// ── custody-leftover scan + auto-sweep (the failure path self-heals on-chain; flag-gated) ──
test('scanCustodyLeftovers: includes a RESOLVED user with custody USDC, excludes one with an unresolved open', async () => {
  const a = await newUser(); const b = await newUser();
  const cc = fakeCc(); const chain = fakeChain();
  await openPack(db, a, { machineCode: 'pokemon_50', idempotencyKey: 'scan-a' }, { chain, cc, ...noWait }); // delivers → 'opened' (resolved)
  const custA = (await db.query<{ p: string }>(`SELECT custody_pubkey p FROM gacha_pack_opens WHERE user_id=$1 LIMIT 1`, [a])).rows[0].p;
  chain.custodyBalances[custA] = 50_000_000n; // $50 stranded
  const bid = randomUUID(); // B has an UNRESOLVED 'paid' open → must be excluded (could be live)
  await db.query(`INSERT INTO gacha_pack_opens(id,user_id,idempotency_key,machine_code,price_e6,custody_pubkey,paid_with,turbo,status) VALUES($1,$2,$3,'pokemon_50',$4,'CUST-B','usdc',false,'paid')`, [bid, b, 'scan-b-' + bid, PRICE.toString()]);
  chain.custodyBalances['CUST-B'] = 50_000_000n;
  const { custodies } = await scanCustodyLeftovers(db, { chain, cc, ...noWait });
  const pks = custodies.map((c) => c.custodyPubkey);
  assert.ok(pks.includes(custA), 'resolved user with leftover is included');
  assert.ok(!pks.includes('CUST-B'), 'user with an unresolved open is excluded');
});

test('autoSweepCustodyLeftovers: OFF by default (no-op); ON sweeps the leftover to hot', async () => {
  const user = await newUser();
  const cc = fakeCc(); const chain = fakeChain();
  await openPack(db, user, { machineCode: 'pokemon_50', idempotencyKey: 'sweep-1' }, { chain, cc, ...noWait });
  const cust = (await db.query<{ p: string }>(`SELECT custody_pubkey p FROM gacha_pack_opens WHERE user_id=$1 LIMIT 1`, [user])).rows[0].p;
  chain.custodyBalances[cust] = 50_000_000n;
  // flag OFF (default) → no-op, nothing swept
  assert.equal(config.gachaAutoSweepEnabled, false);
  assert.equal((await autoSweepCustodyLeftovers(db, { chain, cc, ...noWait })).swept, 0);
  assert.equal(chain.sweeps.length, 0);
  // flag ON → sweeps the $50 custody → hot
  config.gachaAutoSweepEnabled = true;
  try {
    const r = await autoSweepCustodyLeftovers(db, { chain, cc, ...noWait });
    assert.equal(r.swept, 1);
    assert.equal(r.sweptE6, '50000000');
    assert.equal(chain.sweeps.length, 1);
    assert.equal(chain.sweeps[0].custody, cust);
    assert.equal(chain.sweeps[0].amountE6, 50_000_000n);
  } finally {
    config.gachaAutoSweepEnabled = false;
  }
});
