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
const { bonusConfig: cfg } = await import('./bonus-config.ts');
const bonus = await import('./bonus.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}
async function post(u: string, reason: string, amount: bigint, counterparty = 'LP_POOL'): Promise<void> {
  await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, u, 'USER_COLLATERAL');
    const other = await getOrCreateSystemAccount(q, counterparty as 'LP_POOL');
    await postTxn(q, { reason, entries: [{ accountId: coll, amount }, { accountId: other, amount: -amount }] });
  });
}
async function moveMargin(u: string, amount: bigint): Promise<void> {
  await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, u, 'USER_COLLATERAL');
    const marg = await getOrCreateUserAccount(q, u, 'USER_POSITION_MARGIN');
    await postTxn(q, { reason: 'OPEN', entries: [{ accountId: coll, amount: -amount }, { accountId: marg, amount }] });
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
async function dep(u: string, amount: bigint): Promise<string | null> {
  const { creditDeposit } = await import('./custody/deposits.ts');
  const id = randomUUID();
  await db.query(`INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, status) VALUES($1,$2,$3,'USDC',$4,'detected')`, [id, u, 'sig-' + id, amount.toString()]);
  return creditDeposit(db, id);
}
let _mkt: string | null = null;
async function addFill(u: string, ageDays = 0): Promise<void> {
  if (!_mkt) { _mkt = 'mkt-' + randomUUID().slice(0, 8); await db.query(`INSERT INTO markets(id, kind, symbol, display_name) VALUES($1,'card',$2,'QA Mkt')`, [_mkt, _mkt]); }
  const oid = 'o-' + randomUUID().slice(0, 8), pid = 'p-' + randomUUID().slice(0, 8), fid = 'f-' + randomUUID().slice(0, 8);
  const one = usdc(1).toString();
  await db.query(`INSERT INTO orders(id, user_id, market_id, idempotency_key, kind, side, qty_e6, leverage_e2, status) VALUES($1,$2,$3,$4,'market','long',$5,100,'filled')`, [oid, u, _mkt, 'idem-' + oid, one]);
  await db.query(`INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2) VALUES($1,$2,$3,'long',$4,$5,0,100)`, [pid, u, _mkt, one, one]);
  await db.query(`INSERT INTO fills(id, order_id, position_id, market_id, exec_price_e6, qty_e6, created_at) VALUES($1,$2,$3,$4,$5,$6, now() - ($7::int * interval '1 day'))`, [fid, oid, pid, _mkt, one, one, ageDays]);
}
// reset all knobs per test (velocityTripped isn't settable via the admin patch, so set it directly)
async function setCfg(o: { signupEnabled?: boolean; signupUsd?: number; depositEnabled?: boolean; depositPct?: number; depositMaxUsd?: number; wagerDep?: number; wagerVol?: number; expiry?: number; cap?: number } = {}): Promise<void> {
  await cfg.signupEnabled.set(db, o.signupEnabled ?? false);
  await cfg.signupUsd.set(db, o.signupUsd ?? 0);
  await cfg.depositEnabled.set(db, o.depositEnabled ?? false);
  await cfg.depositPct.set(db, o.depositPct ?? 0);
  await cfg.depositMaxUsd.set(db, o.depositMaxUsd ?? 0);
  await cfg.wagerDepositUsd.set(db, o.wagerDep ?? 50);
  await cfg.wagerVolumeUsd.set(db, o.wagerVol ?? 1000);
  await cfg.expiryDays.set(db, o.expiry ?? 7);
  await cfg.dailyAccountCap.set(db, o.cap ?? 1_000_000);
  await cfg.velocityTripped.set(db, false);
}

test('floorWithdrawable — the §3 rule (principal locked forever)', () => {
  const G = usdc(50);
  assert.equal(bonus.floorWithdrawable(usdc(90), { grantE6: G, netDepositsE6: 0n, wageringMet: false }), 0n);
  assert.equal(bonus.floorWithdrawable(usdc(90), { grantE6: G, netDepositsE6: 0n, wageringMet: true }), usdc(40)); // winnings only; grant locked
  assert.equal(bonus.floorWithdrawable(usdc(70), { grantE6: G, netDepositsE6: usdc(100), wageringMet: false }), usdc(20)); // deposit-then-lose, grant never leaks
  assert.equal(bonus.floorWithdrawable(usdc(200), { grantE6: G, netDepositsE6: usdc(100), wageringMet: true }), usdc(150)); // deposit + winnings, grant still locked
  assert.equal(bonus.floorWithdrawable(usdc(123), { grantE6: 0n, netDepositsE6: 0n, wageringMet: false }), usdc(123)); // no bonus → raw balance
});

test('signup bonus — dark when disabled/zero, clamped to budget, one per account', async () => {
  await setCfg({ signupEnabled: false, signupUsd: 50 });
  const u = await newUser();
  assert.equal(await bonus.grantSignupBonus(db, u), 0n, 'disabled → nothing');
  await setCfg({ signupEnabled: true, signupUsd: 0 });
  assert.equal(await bonus.grantSignupBonus(db, u), 0n, 'zero amount → nothing even if enabled');
  await setCfg({ signupEnabled: true, signupUsd: 50 });
  assert.equal(await bonus.grantSignupBonus(db, u), 0n, 'empty budget → nothing');
  await fundFee(usdc(200)); await bonus.fundCreditBudget(db, usdc(200));
  assert.equal(await bonus.grantSignupBonus(db, u), usdc(50), 'granted $50');
  assert.equal(await collBal(u), usdc(50));
  assert.equal(await sysBal('CREDIT_BUDGET'), usdc(150), 'budget −$50');
  assert.equal(await bonus.grantSignupBonus(db, u), 0n, 'idempotent — one signup bonus per account');
  assert.equal(await bonus.withdrawableBalance(db, u), 0n, 'principal not withdrawable');
});

test('deposit bonus — % of deposit, $-capped, first deposit only; 0% or $0 cap ⇒ nothing', async () => {
  await setCfg({ depositEnabled: true, depositPct: 10, depositMaxUsd: 100 });
  await fundFee(usdc(500)); await bonus.fundCreditBudget(db, usdc(500));
  const u = await newUser();
  assert.equal(await bonus.grantDepositBonus(db, u, usdc(200), 'dep-1'), usdc(20), '10% of $200 = $20');
  assert.equal(await bonus.grantDepositBonus(db, u, usdc(999), 'dep-2'), 0n, 'first deposit only — second deposit no bonus');
  const u2 = await newUser();
  assert.equal(await bonus.grantDepositBonus(db, u2, usdc(2000), 'dep-3'), usdc(100), '10% of $2000 = $200, capped to $100');
  // guards: 0% or $0 cap ⇒ nothing
  await setCfg({ depositEnabled: true, depositPct: 0, depositMaxUsd: 100 });
  assert.equal(await bonus.grantDepositBonus(db, await newUser(), usdc(500), 'dep-4'), 0n, '0% ⇒ no bonus');
  await setCfg({ depositEnabled: true, depositPct: 10, depositMaxUsd: 0 });
  assert.equal(await bonus.grantDepositBonus(db, await newUser(), usdc(500), 'dep-5'), 0n, '$0 cap ⇒ no bonus (never uncapped)');
});

test('both sources stack — a signup who deposits gets both; floor covers the aggregate', async () => {
  await setCfg({ signupEnabled: true, signupUsd: 25, depositEnabled: true, depositPct: 10, depositMaxUsd: 100 });
  await fundFee(usdc(200)); await bonus.fundCreditBudget(db, usdc(200));
  const u = await newUser();
  assert.equal(await bonus.grantSignupBonus(db, u), usdc(25), 'signup bonus $25');
  await dep(u, usdc(100)); // deposit fires the deposit bonus (10% of $100 = $10)
  assert.equal(await collBal(u), usdc(135), '$100 deposit + $25 signup + $10 deposit bonus');
  assert.equal((await bonus.bonusState(db, u)).grantE6, usdc(35), 'aggregate bonus principal = $35');
  assert.equal(await bonus.withdrawableBalance(db, u), usdc(100), 'pre-wagering: own $100 deposit; $35 bonus locked');
});

test('wagering — LIVE: deposit must still be in AND volume must clear', async () => {
  await setCfg({ signupEnabled: true, signupUsd: 50, wagerDep: 50, wagerVol: 1000 });
  await fundFee(usdc(50)); await bonus.fundCreditBudget(db, usdc(50));
  const u = await newUser();
  await bonus.grantSignupBonus(db, u); // $50 signup
  await post(u, 'DEPOSIT', usdc(50), 'TREASURY_USDC'); // collateral $100
  await post(u, 'REALIZED_PNL', usdc(40), 'LP_POOL'); // win $40 → $140, no volume yet
  assert.equal((await bonus.bonusState(db, u)).wageringMet, false, 'no volume → unmet');
  assert.equal(await bonus.withdrawableBalance(db, u), usdc(50), 'pre-wagering: own deposit only');
  await post(u, 'WITHDRAWAL', -usdc(50), 'TREASURY_USDC'); // pull the deposit → net deposits 0
  assert.equal((await bonus.bonusState(db, u)).netDepositsE6, 0n);
  assert.equal(await bonus.withdrawableBalance(db, u), 0n, 'deposit-then-withdraw does NOT keep wagering met');
});

test('dormancy — per-grant: unused expires, an account still trading keeps it; margin-safe', async () => {
  await setCfg({ signupEnabled: true, signupUsd: 50, expiry: 7 });
  // (A) unused → expires
  const dormant = await newUser();
  await fundFee(usdc(50)); await bonus.fundCreditBudget(db, usdc(50));
  await bonus.grantSignupBonus(db, dormant);
  await db.query(`UPDATE bonus_grants SET granted_at = now() - interval '8 days' WHERE user_id = $1`, [dormant]);
  // (B) active trader keeps it; and margin-parked credit is not clawed until it returns
  const active = await newUser();
  await fundFee(usdc(50)); await bonus.fundCreditBudget(db, usdc(50));
  await bonus.grantSignupBonus(db, active);
  await db.query(`UPDATE bonus_grants SET granted_at = now() - interval '8 days' WHERE user_id = $1`, [active]);
  await addFill(active, 1); // traded yesterday → keeps
  const margined = await newUser();
  await fundFee(usdc(50)); await bonus.fundCreditBudget(db, usdc(50));
  await bonus.grantSignupBonus(db, margined);
  await moveMargin(margined, usdc(50)); // whole grant parked as margin → free collateral $0
  await db.query(`UPDATE bonus_grants SET granted_at = now() - interval '8 days' WHERE user_id = $1`, [margined]);

  const budgetBefore = await sysBal('CREDIT_BUDGET');
  const r = await bonus.expireBonuses(db);
  assert.equal(r.swept, 1, 'only the dormant free grant is clawed');
  assert.equal(r.clawedE6, usdc(50));
  assert.equal(await collBal(dormant), 0n, 'dormant grant clawed');
  assert.equal(await collBal(active), usdc(50), 'active trader keeps the credit');
  assert.equal((await bonus.bonusState(db, margined)).grantE6, usdc(50), 'margin-parked grant NOT clawed (principal stays locked)');
  assert.equal(await sysBal('CREDIT_BUDGET'), budgetBefore + usdc(50));
  // margined account's position closes → margin returns → later sweep claws it
  await moveMargin(margined, -usdc(50));
  assert.equal((await bonus.expireBonuses(db)).swept, 1, 'now clawed once free');
  assert.equal(await collBal(margined), 0n);
});

test('velocity — a breach switches BOTH toggles off; re-enable via the toggle; only trips while live; re-arms', async () => {
  // (a) only trips while a source is live
  await setCfg({ signupEnabled: false, depositEnabled: false, cap: 1 });
  assert.equal((await bonus.enforceBonusVelocity(db)).tripped, false, 'dark → no trip even over cap');
  // (b) breach with a live source turns both toggles off + trips
  await setCfg({ signupEnabled: true, signupUsd: 10, depositEnabled: true, depositPct: 10, depositMaxUsd: 50 });
  const n = await bonus.signupCount24h(db);
  await cfg.dailyAccountCap.set(db, Math.max(1, n - 1));
  const v = await bonus.enforceBonusVelocity(db);
  assert.equal(v.tripped, true, 'breach → tripped');
  assert.equal(cfg.signupEnabled.get(), false, 'signup toggle switched OFF');
  assert.equal(cfg.depositEnabled.get(), false, 'deposit toggle switched OFF');
  // (c) grants are paused
  await fundFee(usdc(100)); await bonus.fundCreditBudget(db, usdc(100));
  const u = await newUser();
  assert.equal(await bonus.grantSignupBonus(db, u), 0n, 'paused → no grant');
  // (d) admin re-enables via the toggle → resumes even while still over cap (edge-trigger won't re-trip)
  await cfg.signupEnabled.set(db, true);
  assert.equal(await bonus.grantSignupBonus(db, u), usdc(10), 're-enabled via toggle → grant resumes');
  // (e) re-arm once the count is back under the cap
  await cfg.dailyAccountCap.set(db, 1_000_000);
  assert.equal((await bonus.enforceBonusVelocity(db)).tripped, false, 'count under cap → re-armed');
});

test('manual-review hold — first bonus-origin withdrawal held, then cleared', async () => {
  await setCfg({ signupEnabled: true, signupUsd: 50 });
  const u = await newUser();
  assert.equal(await bonus.needsFirstWithdrawalReview(db, u), false, 'non-bonus account: no hold');
  await fundFee(usdc(50)); await bonus.fundCreditBudget(db, usdc(50));
  await bonus.grantSignupBonus(db, u);
  assert.equal(await bonus.needsFirstWithdrawalReview(db, u), true, 'bonus-origin, no prior confirmed withdrawal → hold');
  assert.equal(await bonus.clearFirstWithdrawalReview(db, u), true, 'operator clears it');
  assert.equal(await bonus.needsFirstWithdrawalReview(db, u), false, 'cleared → no longer held');
});

test('deposit trigger — creditDeposit issues the deposit bonus once (first deposit only)', async () => {
  await setCfg({ depositEnabled: true, depositPct: 25, depositMaxUsd: 1000 });
  await fundFee(usdc(200)); await bonus.fundCreditBudget(db, usdc(200));
  const u = await newUser();
  assert.ok(await dep(u, usdc(200)), 'first deposit credited');
  assert.equal(await collBal(u), usdc(250), '$200 deposit + 25% = $50 bonus');
  await dep(u, usdc(100)); // second deposit — no re-grant
  assert.equal(await collBal(u), usdc(350), '+$100 deposit, no second bonus');
  assert.equal((await bonus.bonusState(db, u)).grantE6, usdc(50), 'still just the one $50 deposit bonus');
});
