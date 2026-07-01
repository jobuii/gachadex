import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { usdc } = await import('../money.ts');
const { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn, getBalance } = await import('./ledger.ts');
const { signupCreditConfig } = await import('./signup-credit-config.ts');
const sc = await import('./signup-credit.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}
// Post a signed delta onto a user's USER_COLLATERAL, with a system counterparty (mirrors how the real
// reasons settle: DEPOSIT vs TREASURY_USDC, REALIZED_PNL vs LP_POOL, WITHDRAWAL vs TREASURY_USDC).
async function post(userId: string, reason: string, amount: bigint, counterparty = 'LP_POOL'): Promise<void> {
  await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const other = await getOrCreateSystemAccount(q, counterparty as 'LP_POOL');
    await postTxn(q, { reason, entries: [{ accountId: coll, amount }, { accountId: other, amount: -amount }] });
  });
}
async function fundFee(amount: bigint): Promise<void> {
  await db.tx(async (q) => {
    const fee = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
    const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
    await postTxn(q, { reason: 'OPEN_FEE', entries: [{ accountId: fee, amount }, { accountId: lp, amount: -amount }] });
  });
}
const collBal = async (u: string) => getBalance(db, await getOrCreateUserAccount(db, u, 'USER_COLLATERAL'));
const sysBal = async (t: 'CREDIT_BUDGET' | 'FEE_REVENUE') => getBalance(db, await getOrCreateSystemAccount(db, t));

// Record a trade for a user `ageDays` days ago (the dormancy sweep keys off fills → orders.user_id). Reuses a
// single shared test market. Minimal FK chain: market → order + position → fill.
let _mkt: string | null = null;
async function ensureMarket(): Promise<string> {
  if (_mkt) return _mkt;
  _mkt = 'mkt-' + randomUUID().slice(0, 8);
  await db.query(`INSERT INTO markets(id, kind, symbol, display_name) VALUES($1,'card',$2,'Test Market')`, [_mkt, _mkt]);
  return _mkt;
}
async function addFill(userId: string, ageDays = 0): Promise<void> {
  const mkt = await ensureMarket();
  const oid = 'o-' + randomUUID().slice(0, 8), pid = 'p-' + randomUUID().slice(0, 8), fid = 'f-' + randomUUID().slice(0, 8);
  const one = usdc(1).toString();
  await db.query(`INSERT INTO orders(id, user_id, market_id, idempotency_key, kind, side, qty_e6, leverage_e2, status) VALUES($1,$2,$3,$4,'market','long',$5,100,'filled')`, [oid, userId, mkt, 'idem-' + oid, one]);
  await db.query(`INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2) VALUES($1,$2,$3,'long',$4,$5,0,100)`, [pid, userId, mkt, one, one]);
  await db.query(`INSERT INTO fills(id, order_id, position_id, market_id, exec_price_e6, qty_e6, created_at) VALUES($1,$2,$3,$4,$5,$6, now() - ($7::int * interval '1 day'))`, [fid, oid, pid, mkt, one, one, ageDays]);
}

test('floorWithdrawable — the §2.2 rule (single authority)', () => {
  const G = usdc(50);
  // no deposit, won to $90: pre-wagering nothing; once wagering met, the $40 winnings unlock (C2)
  assert.equal(sc.floorWithdrawable(usdc(90), { grantE6: G, netDepositsE6: 0n, wageringMet: false }), 0n);
  assert.equal(sc.floorWithdrawable(usdc(90), { grantE6: G, netDepositsE6: 0n, wageringMet: true }), usdc(40));
  // $100 deposit + $50 grant, lost to $70: withdrawable = surviving cash $20; grant never leaks (C1)
  assert.equal(sc.floorWithdrawable(usdc(70), { grantE6: G, netDepositsE6: usdc(100), wageringMet: false }), usdc(20));
  // $100 deposit + $50 grant, won to $200, wagering met: deposit + winnings = $150 (grant locked)
  assert.equal(sc.floorWithdrawable(usdc(200), { grantE6: G, netDepositsE6: usdc(100), wageringMet: true }), usdc(150));
  // normal account (no grant) → identical to the raw balance (L2 equivalence)
  assert.equal(sc.floorWithdrawable(usdc(123), { grantE6: 0n, netDepositsE6: 0n, wageringMet: false }), usdc(123));
});

test('grant — dark when disabled, clamped to CREDIT_BUDGET, one per user', async () => {
  await signupCreditConfig.enabled.set(db, false);
  await signupCreditConfig.grantUsd.set(db, 50);
  const u = await newUser();
  assert.equal(await sc.grantSignupCredit(db, u), 0n, 'disabled → no grant');

  await signupCreditConfig.enabled.set(db, true);
  assert.equal(await sc.grantSignupCredit(db, u), 0n, 'empty budget → no grant');

  await fundFee(usdc(200));
  assert.equal(await sc.fundCreditBudget(db, usdc(200)), usdc(200), 'funded the budget from fees');
  assert.equal(await sysBal('CREDIT_BUDGET'), usdc(200));

  assert.equal(await sc.grantSignupCredit(db, u), usdc(50), 'granted $50');
  assert.equal(await collBal(u), usdc(50), 'collateral +$50');
  assert.equal(await sysBal('CREDIT_BUDGET'), usdc(150), 'budget −$50');
  assert.equal(await sc.grantSignupCredit(db, u), 0n, 'idempotent — no second grant');
  assert.equal(await sc.withdrawableBalance(db, u), 0n, 'principal is not withdrawable');
});

test('fundCreditBudget — clamped to the FEE_REVENUE balance', async () => {
  await fundFee(usdc(30));
  // ask for more than FEE_REVENUE holds → clamps to what's there
  const before = await sysBal('FEE_REVENUE');
  const moved = await sc.fundCreditBudget(db, before + usdc(1000));
  assert.equal(moved, before, 'moved only the available fee balance');
  assert.equal(await sysBal('FEE_REVENUE'), 0n, 'fees drained, never negative');
});

test('integration C1 — deposit-then-lose never leaks the grant', async () => {
  await signupCreditConfig.enabled.set(db, true);
  await signupCreditConfig.grantUsd.set(db, 50);
  const u = await newUser();
  await fundFee(usdc(100));
  await sc.fundCreditBudget(db, usdc(100));
  await sc.grantSignupCredit(db, u); // +$50 grant
  await post(u, 'DEPOSIT', usdc(100), 'TREASURY_USDC'); // → $150 collateral
  await post(u, 'REALIZED_PNL', -usdc(80), 'LP_POOL'); // lose $80 → $70 collateral
  assert.equal(await collBal(u), usdc(70));
  assert.equal(await sc.withdrawableBalance(db, u), usdc(20), 'withdrawable = surviving cash; $50 grant locked');
});

test('wagering — LIVE: deposit must still be in, and volume must clear (H3)', async () => {
  await signupCreditConfig.enabled.set(db, true);
  await signupCreditConfig.grantUsd.set(db, 50);
  const u = await newUser();
  await fundFee(usdc(50));
  await sc.fundCreditBudget(db, usdc(50));
  await sc.grantSignupCredit(db, u); // $50 grant
  await post(u, 'DEPOSIT', usdc(50), 'TREASURY_USDC'); // deposit $50 → collateral $100
  await post(u, 'REALIZED_PNL', usdc(40), 'LP_POOL'); // win $40 → collateral $140
  // wagering NOT met: deposit is in ($50) but post-deposit volume is 0 (< $1000) → winnings locked, only the
  // $50 deposit is withdrawable; the $40 winnings stay gated, the $50 grant locked.
  let s = await sc.creditState(db, u);
  assert.equal(s.wageringMet, false, 'no trade volume yet → wagering unmet');
  assert.equal(await sc.withdrawableBalance(db, u), usdc(50), 'pre-wagering: own deposit only');
  // H3: withdraw the $50 deposit → net deposits 0 → winnings can never unlock without re-depositing
  await post(u, 'WITHDRAWAL', -usdc(50), 'TREASURY_USDC'); // collateral $90
  s = await sc.creditState(db, u);
  assert.equal(s.netDepositsE6, 0n, 'deposit withdrawn → net deposits 0');
  assert.equal(await sc.withdrawableBalance(db, u), 0n, 'deposit-then-withdraw does NOT keep wagering met');
});

test('expiry — dormancy: unused grants expire, an account still trading keeps the credit', async () => {
  await signupCreditConfig.enabled.set(db, true);
  await signupCreditConfig.grantUsd.set(db, 50);
  await signupCreditConfig.expiryDays.set(db, 7);
  // (A) unused account — grant older than the window, never traded → due to expire
  const dormant = await newUser();
  await fundFee(usdc(50)); await sc.fundCreditBudget(db, usdc(50));
  await sc.grantSignupCredit(db, dormant);
  assert.deepEqual(await sc.expireSignupCredits(db), { swept: 0, clawedE6: 0n }, 'fresh grant not yet due');
  await db.query(`UPDATE signup_credits SET granted_at = now() - interval '8 days' WHERE user_id = $1`, [dormant]);
  // (B) active account — same old grant, but a trade inside the window → must NOT expire
  const active = await newUser();
  await fundFee(usdc(50)); await sc.fundCreditBudget(db, usdc(50));
  await sc.grantSignupCredit(db, active);
  await db.query(`UPDATE signup_credits SET granted_at = now() - interval '8 days' WHERE user_id = $1`, [active]);
  await addFill(active, 1); // traded yesterday → dormancy clock reset

  const budgetBefore = await sysBal('CREDIT_BUDGET'); // shared db accumulates across tests → assert the delta
  const r = await sc.expireSignupCredits(db);
  assert.equal(r.swept, 1, 'only the dormant account is swept');
  assert.equal(r.clawedE6, usdc(50));
  assert.equal(await collBal(dormant), 0n, 'dormant grant clawed out of collateral');
  assert.equal(await collBal(active), usdc(50), 'active trader keeps the credit');
  assert.equal(await sysBal('CREDIT_BUDGET'), budgetBefore + usdc(50), 'only the dormant residual returned');
  // (C) the active account goes quiet — backdate its trade past the window → now it expires too
  await db.query(`UPDATE fills SET created_at = now() - interval '9 days' WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)`, [active]);
  assert.equal((await sc.expireSignupCredits(db)).swept, 1, 'now-dormant account expires on a later sweep');
  assert.equal(await collBal(active), 0n, 'residual clawed once dormant');
  // idempotent — already expired
  assert.deepEqual(await sc.expireSignupCredits(db), { swept: 0, clawedE6: 0n });
});

test('needsFirstWithdrawalReview — first credit-origin withdrawal is held, then cleared', async () => {
  await signupCreditConfig.enabled.set(db, true);
  await signupCreditConfig.grantUsd.set(db, 50);
  const u = await newUser();
  assert.equal(await sc.needsFirstWithdrawalReview(db, u), false, 'non-credit account: no hold');
  await fundFee(usdc(50));
  await sc.fundCreditBudget(db, usdc(50));
  await sc.grantSignupCredit(db, u);
  assert.equal(await sc.needsFirstWithdrawalReview(db, u), true, 'credit-origin, no prior confirmed withdrawal → hold');
  // operator clears it
  await db.query(`UPDATE signup_credits SET first_withdrawal_reviewed = true WHERE user_id = $1`, [u]);
  assert.equal(await sc.needsFirstWithdrawalReview(db, u), false, 'cleared by operator → no longer held');
});

test('integration — first deposit triggers the deposit-first grant; a second deposit does not re-grant', async () => {
  await signupCreditConfig.enabled.set(db, true);
  await signupCreditConfig.grantUsd.set(db, 25);
  const { creditDeposit } = await import('./custody/deposits.ts');
  const u = await newUser();
  await fundFee(usdc(100));
  await sc.fundCreditBudget(db, usdc(100));
  const dep = async (amount: bigint) => {
    const id = randomUUID();
    await db.query(`INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, status) VALUES($1,$2,$3,'USDC',$4,'detected')`, [id, u, 'sig-' + id, amount.toString()]);
    return creditDeposit(db, id);
  };
  assert.ok(await dep(usdc(200)), 'first deposit credited');
  assert.equal(await collBal(u), usdc(225), '$200 deposit + $25 grant');
  assert.equal(await sc.withdrawableBalance(db, u), usdc(200), 'the $25 grant is locked; only the $200 deposit is withdrawable (wagering unmet, no volume)');
  await dep(usdc(50)); // second deposit — must NOT grant again (one per user)
  assert.equal(await collBal(u), usdc(275), '+$50 deposit, no second grant');
  assert.equal(await sc.withdrawableBalance(db, u), usdc(250), '$250 own capital withdrawable, $25 grant still locked');
});

test('velocity — >cap new accounts in 24h latches the grant-freeze until an admin unfreezes', async () => {
  await signupCreditConfig.enabled.set(db, true);
  await signupCreditConfig.grantUsd.set(db, 10);
  await signupCreditConfig.frozen.set(db, false);
  await fundFee(usdc(100));
  await sc.fundCreditBudget(db, usdc(100));
  // shared db accumulates users → set the cap just below the live 24h count so we're "over" it
  const n = await sc.signupCount24h(db);
  await signupCreditConfig.dailyAccountCap.set(db, Math.max(1, n - 1));
  const v = await sc.enforceSignupVelocity(db);
  assert.equal(v.frozen, true, 'over the daily cap → latched frozen');
  assert.equal(signupCreditConfig.frozen.get(), true, 'freeze persisted to the knob');
  const u = await newUser();
  assert.equal(await sc.grantSignupCredit(db, u), 0n, 'frozen → grant issues nothing');
  assert.equal(await sc.needsFirstWithdrawalReview(db, u), false, 'no grant row created while frozen');
  // admin unfreezes AND raises the cap so the surge no longer trips → grants resume
  await signupCreditConfig.frozen.set(db, false);
  await signupCreditConfig.dailyAccountCap.set(db, 1_000_000);
  assert.equal(await sc.grantSignupCredit(db, u), usdc(10), 'unfrozen + under cap → grant resumes');
  assert.equal(signupCreditConfig.frozen.get(), false, 'stays unfrozen while under the cap');
});
