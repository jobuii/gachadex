import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { Keypair } = await import('@solana/web3.js');
const { initDb } = await import('../db/init.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { getOrCreateSystemAccount, getBalance, postTxn } = await import('./ledger.ts');
const { treasuryPass, treasuryState, withdrawalsFrozen, unfreezeWithdrawals, customerFunds } = await import('./custody/treasury.ts');
const { requestWithdrawal, processWithdrawal, processAllRequested } = await import('./custody/withdrawals.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');
const { fund: fundDb, fakeWithdrawChain, fakeTreasury } = await import('../test-helpers.ts');

await initDb();
const db = await getDb();

const DEST = Keypair.generate().publicKey.toBase58();
const fund = (userId: string, amount: bigint) => fundDb(db, userId, amount);

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}

/** What the ledger says the platform owes (the PoR right-hand side). */
async function liability(): Promise<bigint> {
  const acct = await getOrCreateSystemAccount(db, 'TREASURY_USDC');
  const bal = await getBalance(db, acct);
  return bal < 0n ? -bal : 0n;
}

/** Credited-but-unswept deposit total (part of on-chain custody) — so the breach math stays exact regardless
 *  of unswept rows left by other tests. */
async function unsweptNow(): Promise<bigint> {
  const r = await db.query<{ t: string }>(
    `SELECT COALESCE(SUM(usdc_credited_e6), 0)::text AS t FROM deposits WHERE asset = 'USDC' AND status = 'credited' AND sweep_sig IS NULL`,
  );
  return BigInt(r.rows[0].t);
}
const clearStreak = () => db.query(`DELETE FROM system_flags WHERE key = 'por_breach_since'`);

/** A 'requested' withdrawal row planted directly (already-debited state is irrelevant here). */
async function insertRequested(userId: string, amountE6: bigint): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO withdrawals(id, user_id, dest_address, amount_e6, status, idempotency_key)
     VALUES($1, $2, $3, $4, 'requested', $5)`,
    [id, userId, DEST, amountE6.toString(), `t-idem-${id.slice(0, 8)}`],
  );
  return id;
}

test('a proof-of-reserves breach auto-freezes withdrawals; unfreezing is manual', async () => {
  const u = await newUser();
  await fund(u, usdc(100));
  const held = await insertRequested(u, usdc(20));

  // on-chain custody short of liabilities -> freeze
  const broke = fakeTreasury({ hot: usdc(30), cold: usdc(50) });
  const report = await treasuryPass(db, broke);
  assert.equal(report.breached, true);
  assert.match((await withdrawalsFrozen(db)) ?? '', /proof-of-reserves breach/);

  // new requests are rejected before any signature work
  await assert.rejects(
    () =>
      requestWithdrawal(db, u, 'pk-any', {
        amountE6: usdc(10),
        dest: DEST,
        idempotencyKey: 'frozen-try-1',
        message: 'irrelevant',
        signature: 'irrelevant',
      }),
    /frozen/,
  );
  // new payouts are blocked too — both the single-row path and the auto loop
  const wchain = fakeWithdrawChain();
  await assert.rejects(() => processWithdrawal(db, wchain, held), /frozen/);
  assert.deepEqual(await processAllRequested(db, wchain), { confirmed: 0 });
  assert.equal(wchain.signed.length, 0); // nothing was ever signed while frozen

  // a healthy pass does NOT unfreeze by itself — that's an operator call
  const solvent = fakeTreasury({ hot: usdc(30), cold: await liability() });
  assert.equal((await treasuryPass(db, solvent)).breached, false);
  assert.match((await withdrawalsFrozen(db)) ?? '', /proof-of-reserves breach/);

  await unfreezeWithdrawals(db);
  assert.equal(await withdrawalsFrozen(db), null);
  assert.deepEqual(await processAllRequested(db, wchain), { confirmed: 1 }); // the held row pays out
  assert.equal((await reconcile(db)).ok, true);
});

test('a transient chain read failure does NOT trigger a false freeze (RPC blip != zero custody)', async () => {
  const u = await newUser();
  await fund(u, usdc(100)); // real liabilities exist, so a false-zero custody read would "breach"
  await unfreezeWithdrawals(db); // clean slate regardless of prior tests
  assert.equal(await withdrawalsFrozen(db), null);

  // a balance read errors out (simulated RPC outage) — custody is UNKNOWN this pass, not zero
  const flaky = fakeTreasury({ failBalance: true });
  await assert.rejects(() => treasuryPass(db, flaky), /RPC outage/);
  // the pass aborted before any freeze decision — no spurious freeze from an unreadable balance
  assert.equal(await withdrawalsFrozen(db), null);
});

test('credited-but-unswept deposit balances count toward proof of reserves', async () => {
  const u = await newUser();
  const unswept = usdc(50);
  await fund(u, unswept);
  await db.query(
    `INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, usdc_credited_e6, status)
     VALUES($1, $2, 'sig-unswept-por', 'USDC', $3, $3, 'credited')`, // sweep_sig NULL
    [randomUUID(), u, unswept.toString()],
  );

  // cold + hot deliberately short by exactly the unswept amount: still solvent overall
  const chain = fakeTreasury({ hot: 0n, cold: (await liability()) - unswept });
  const report = await treasuryPass(db, chain);
  assert.equal(report.breached, false);
  assert.equal(await withdrawalsFrozen(db), null);
  assert.equal(report.onchainE6, report.liabilityE6); // balanced to the micro-dollar
});

test('hot wallet runs as a band: at the cap it drains to the floor; below the cap it sits', async () => {
  const SAFE_COLD = usdc(1_000_000_000); // PoR comfortably satisfied in float-only tests
  // defaults: cap = hotWalletMaxUsd ($25k), floor = hotWalletFloorPct (20%) of the cap = $5k

  // at/above the cap -> drain down to the FLOOR: $30k hot sweeps $25k to cold, leaving $5k
  const over = fakeTreasury({ hot: usdc(30_000), cold: SAFE_COLD });
  assert.equal((await treasuryPass(db, over)).sweptE6, usdc(25_000));
  assert.deepEqual(over.sweeps, [usdc(25_000)]);
  assert.equal(over.hot, usdc(5_000)); // left at the floor, not pinned at the cap

  // below the cap -> the band isn't full; deposits keep filling it, nothing swept
  const under = fakeTreasury({ hot: usdc(20_000), cold: SAFE_COLD });
  assert.equal((await treasuryPass(db, under)).sweptE6, 0n);
  assert.equal(under.sweeps.length, 0);

  // just shy of the cap -> still nothing (no premature dribble of sweeps)
  const nearly = fakeTreasury({ hot: usdc(25_000) - usdc(1), cold: SAFE_COLD });
  assert.equal((await treasuryPass(db, nearly)).sweptE6, 0n);
});

test('customerFunds aggregates customer free collateral (delta-checked, isolated from other rows)', async () => {
  const before = await customerFunds(db);
  const u = await newUser();
  await fund(u, usdc(100)); // adds USER_COLLATERAL (free) for one user
  const after = await customerFunds(db);
  assert.equal(after.freeE6 - before.freeE6, usdc(100)); // exactly the new free collateral, nothing else moved
  assert.ok(after.lockedE6 >= 0n); // locked margin aggregates by the same query path (filled by the engine)
});

test('treasuryState surfaces accumulated platform fee revenue (FEE_REVENUE), delta-checked', async () => {
  const chain = fakeTreasury({ hot: usdc(1_000_000_000) }); // chain balances are irrelevant to fee revenue
  const before = await treasuryState(db, chain);
  // the house's share of a trading fee lands in FEE_REVENUE (the LP share goes to LP_POOL elsewhere)
  await db.tx(async (q) => {
    const rev = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    await postTxn(q, {
      reason: 'OPEN_FEE',
      entries: [
        { accountId: treasury, amount: -usdc(3) },
        { accountId: rev, amount: usdc(3) },
      ],
    });
  });
  const after = await treasuryState(db, chain);
  assert.equal(after.feeRevenueE6 - before.feeRevenueE6, usdc(3)); // exactly the fee that hit FEE_REVENUE
});

test('treasuryState surfaces NET funding the house collected (LP_POOL FUNDING legs, net of payouts)', async () => {
  const chain = fakeTreasury({ hot: usdc(1_000_000_000) });
  const before = await treasuryState(db, chain);
  await db.tx(async (q) => {
    const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC'); // stand-in counterparty for the test
    // a customer pays $4 funding -> LP up $4
    await postTxn(q, { reason: 'FUNDING', refType: 'position', refId: 'fr1', entries: [
      { accountId: treasury, amount: -usdc(4) }, { accountId: lp, amount: usdc(4) },
    ] });
    // the house pays $1 funding back out -> LP down $1 (net $3 kept)
    await postTxn(q, { reason: 'FUNDING', refType: 'position', refId: 'fr2', entries: [
      { accountId: lp, amount: -usdc(1) }, { accountId: treasury, amount: usdc(1) },
    ] });
    // a NON-funding LP leg (e.g. trader PnL) must NOT count toward funding revenue
    await postTxn(q, { reason: 'REALIZED_PNL', refType: 'position', refId: 'pnl1', entries: [
      { accountId: treasury, amount: -usdc(50) }, { accountId: lp, amount: usdc(50) },
    ] });
  });
  const after = await treasuryState(db, chain);
  assert.equal(after.fundingRevenueE6 - before.fundingRevenueE6, usdc(3), 'net = $4 collected − $1 paid out; PnL leg excluded');
  assert.equal(after.fundingCollectedE6 - before.fundingCollectedE6, usdc(4), 'gross collected = only the inbound funding leg ($4)');
});

test('pending payouts are reserved in the float target, and a shortfall is reported', async () => {
  const SAFE_COLD = usdc(1_000_000_000);
  const u = await newUser();
  const big = await insertRequested(u, usdc(28_000)); // above the $25k cap on its own

  // $30k hot, $28k pending -> target is the pending amount, only $2k is sweepable
  const chain = fakeTreasury({ hot: usdc(30_000), cold: SAFE_COLD });
  const r1 = await treasuryPass(db, chain);
  assert.equal(r1.sweptE6, usdc(2_000));
  assert.equal(r1.shortfallE6, 0n);

  // hot wallet can't cover the pending payout -> shortfall flagged, nothing swept
  const broke = fakeTreasury({ hot: usdc(1_000), cold: SAFE_COLD });
  const r2 = await treasuryPass(db, broke);
  assert.equal(r2.sweptE6, 0n);
  assert.equal(r2.shortfallE6, usdc(27_000));

  await db.query(`UPDATE withdrawals SET status = 'reversed', reason = 'test cleanup' WHERE id = $1`, [big]);
});

test('the auto loop only pays out up to the auto-approve cap; larger rows wait for an operator', async () => {
  const u = await newUser();
  const small = await insertRequested(u, usdc(500)); // <= the $1k auto cap
  const large = await insertRequested(u, usdc(5_000)); // operator-only

  const wchain = fakeWithdrawChain();
  assert.deepEqual(await processAllRequested(db, wchain), { confirmed: 1 });
  const rows = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM withdrawals WHERE id = ANY($1) ORDER BY amount_e6`,
    [[small, large]],
  );
  assert.deepEqual(
    rows.rows.map((r) => r.status),
    ['confirmed', 'requested'],
  );

  // the operator path ignores the auto cap — explicit approval processes the large row
  assert.equal((await processWithdrawal(db, wchain, large)).status, 'confirmed');
});

// ── PoR breach grace + material carve-out (transient measurement blips must not auto-freeze) ──
test('PoR grace: a small (non-material) breach does NOT freeze on a single pass', async () => {
  await unfreezeWithdrawals(db);
  await clearStreak();
  const L = await liability();
  const deficit = L / 100n; // 1% of liabilities — well under the 5% material threshold
  const chain = fakeTreasury({ hot: L - deficit - (await unsweptNow()), cold: 0n });
  const r = await treasuryPass(db, chain, undefined, () => 1_000_000);
  assert.equal(r.breached, true); // it IS breached this instant…
  assert.equal(await withdrawalsFrozen(db), null); // …but not frozen — it's within the grace window
});

test('PoR grace: a small breach that PERSISTS past the grace freezes', async () => {
  await unfreezeWithdrawals(db);
  await clearStreak();
  const L = await liability();
  const chain = fakeTreasury({ hot: L - L / 100n - (await unsweptNow()), cold: 0n }); // 1% deficit
  await treasuryPass(db, chain, undefined, () => 2_000_000); // pass 1: records the streak, no freeze
  assert.equal(await withdrawalsFrozen(db), null);
  await treasuryPass(db, chain, undefined, () => 2_000_000 + 90_001); // past TREASURY_BREACH_GRACE_MS
  assert.match((await withdrawalsFrozen(db)) ?? '', /proof-of-reserves breach/);
});

test('PoR grace: a flickering breach (a brief solvent blip < clearPasses) keeps accruing and still freezes', async () => {
  await unfreezeWithdrawals(db);
  await clearStreak();
  const L = await liability();
  const unswept = await unsweptNow();
  const broke = fakeTreasury({ hot: L - L / 100n - unswept, cold: 0n }); // 1% deficit
  const solvent = fakeTreasury({ hot: L - unswept, cold: 0n }); // onchain == liability
  await treasuryPass(db, broke, undefined, () => 5_000_000); // episode starts
  await treasuryPass(db, solvent, undefined, () => 5_030_000); // ONE solvent blip (< clearPasses) — episode kept, NOT reset
  assert.equal(await withdrawalsFrozen(db), null);
  await treasuryPass(db, broke, undefined, () => 5_000_000 + 90_001); // past the grace of the ORIGINAL start
  assert.match((await withdrawalsFrozen(db)) ?? '', /proof-of-reserves breach/); // froze — the blip didn't reset it
});

test('PoR grace: a SUSTAINED recovery (clearPasses consecutive solvent passes) resets the streak', async () => {
  await unfreezeWithdrawals(db);
  await clearStreak();
  const L = await liability();
  const unswept = await unsweptNow();
  const broke = fakeTreasury({ hot: L - L / 100n - unswept, cold: 0n }); // 1% deficit
  const solvent = fakeTreasury({ hot: L - unswept, cold: 0n });
  await treasuryPass(db, broke, undefined, () => 6_000_000); // episode starts
  await treasuryPass(db, solvent, undefined, () => 6_030_000); // solvent pass 1
  await treasuryPass(db, solvent, undefined, () => 6_060_000); // solvent pass 2 → episode cleared (default clearPasses=2)
  // a fresh breach long after the original start does NOT freeze — the streak reset, so the grace restarts
  await treasuryPass(db, broke, undefined, () => 6_000_000 + 200_000);
  assert.equal(await withdrawalsFrozen(db), null);
});

test('PoR grace: a MATERIAL breach (> 5% of liabilities) freezes IMMEDIATELY, no grace', async () => {
  await unfreezeWithdrawals(db);
  await clearStreak();
  const L = await liability();
  const chain = fakeTreasury({ hot: L - (L * 6n) / 100n - (await unsweptNow()), cold: 0n }); // 6% deficit
  await treasuryPass(db, chain, undefined, () => 4_000_000); // FIRST pass
  assert.match((await withdrawalsFrozen(db)) ?? '', /proof-of-reserves breach/);
});

after(async () => {
  await closeDb();
});
