import { randomUUID } from 'node:crypto';
import type { Db, Queryer } from '../db/client.ts';
import { usdc } from '../money.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, getBalance, getBalanceForUpdate, postTxn } from './ledger.ts';
import { bonusConfig } from './bonus-config.ts';

/**
 * Bonus-credits money engine (docs/bonus-credits-spec.md). Two sources — a flat-$ SIGNUP bonus (at account
 * creation) and a %-of-first-deposit DEPOSIT bonus — both go through ONE shared hook, `issueBonus`, and every
 * downstream protection reads the AGGREGATE bonus principal so nothing is duplicated per source:
 *   • non-withdrawable floor (floorWithdrawable / withdrawableBalance)  • wagering gate (bonusState)
 *   • dormancy expiry (expireBonuses)  • first-withdrawal review hold (needsFirstWithdrawalReview)
 *   • velocity pause (enforceBonusVelocity)  • CREDIT_BUDGET funding + hard cap.
 * NB: the floor is never used in treasury PoR liability — the credit is still a real liability (spec §11).
 */

const max0 = (x: bigint): bigint => (x > 0n ? x : 0n);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b); // bigint clamp (Math.min doesn't take bigint)

export type BonusType = 'signup' | 'deposit';

export interface BonusState {
  grantE6: bigint; // outstanding bonus principal: Σ(SIGNUP_BONUS+DEPOSIT_BONUS) − Σ BONUS_EXPIRE (>= 0)
  netDepositsE6: bigint; // own net real capital in: Σ DEPOSIT − Σ WITHDRAWAL + Σ WITHDRAWAL_REVERSAL (>= 0)
  wageringMet: boolean; // LIVE: netDeposits >= wagerDeposit AND post-first-deposit fill volume >= wagerVolume
}

/** Ledger-derived bonus state across BOTH sources (no locks — historical sums). */
export async function bonusState(q: Queryer, userId: string): Promise<BonusState> {
  const sums = await q.query<{ grant: string; net_dep: string; first_dep: string | null }>(
    `SELECT
       COALESCE(SUM(le.amount_uusdc) FILTER (WHERE le.reason IN ('SIGNUP_BONUS','DEPOSIT_BONUS','BONUS_EXPIRE')), 0)::text AS grant,
       COALESCE(SUM(le.amount_uusdc) FILTER (WHERE le.reason IN ('DEPOSIT','WITHDRAWAL','WITHDRAWAL_REVERSAL')), 0)::text AS net_dep,
       MIN(le.created_at) FILTER (WHERE le.reason = 'DEPOSIT')::text AS first_dep
     FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
     WHERE a.user_id = $1 AND a.type = 'USER_COLLATERAL'`,
    [userId],
  );
  const grantE6 = max0(BigInt(sums.rows[0]?.grant ?? '0')); // BONUS_EXPIRE is negative on collateral → nets to outstanding
  const netDepositsE6 = max0(BigInt(sums.rows[0]?.net_dep ?? '0'));
  const firstDep = sums.rows[0]?.first_dep ?? null;

  let wageringMet = false;
  if (grantE6 > 0n && firstDep && netDepositsE6 >= usdc(bonusConfig.wagerDepositUsd.get())) {
    const vol = await q.query<{ vol: string }>(
      `SELECT COALESCE(FLOOR(SUM(f.qty_e6::numeric * f.exec_price_e6) / 1000000), 0)::text AS vol
       FROM fills f JOIN orders o ON o.id = f.order_id
       WHERE o.user_id = $1 AND f.created_at >= $2`,
      [userId, firstDep],
    );
    wageringMet = BigInt(vol.rows[0]?.vol ?? '0') >= usdc(bonusConfig.wagerVolumeUsd.get());
  }
  return { grantE6, netDepositsE6, wageringMet };
}

/**
 * THE withdrawable rule (spec §3 — single authority). `collateralE6` is the user's USER_COLLATERAL balance
 * (pass the row-locked balance at the withdrawal chokepoint). A non-bonus account returns the full balance
 * unchanged. A bonus account: post-wagering = everything above the grant; pre-wagering = only their own
 * deposited capital back. The bonus principal is NEVER returned (D5 — locked forever).
 */
export function floorWithdrawable(collateralE6: bigint, s: BonusState): bigint {
  if (s.grantE6 <= 0n) return max0(collateralE6); // no bonus → identical to the raw balance
  const nonGrant = max0(collateralE6 - s.grantE6); // ceiling: everything above the locked grant
  if (s.wageringMet) return nonGrant;
  return min(nonGrant, s.netDepositsE6); // pre-wagering: capped to own deposits
}

/** The one withdrawal-cap helper for non-locked contexts (UI "max withdrawable"). The chokepoint computes
 *  floorWithdrawable() directly off its row-locked balance. NOT for treasury PoR liability. */
export async function withdrawableBalance(q: Queryer, userId: string): Promise<bigint> {
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  return floorWithdrawable(await getBalance(q, coll), await bonusState(q, userId));
}

/** New accounts created in the last 24h — the shared velocity signal (spec §4). */
export async function signupCount24h(q: Queryer): Promise<number> {
  const r = await q.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE created_at > now() - interval '24 hours'`);
  return r.rows[0]?.n ?? 0;
}

/**
 * Shared velocity guard (spec §4): if more than `dailyAccountCap` accounts were created in the last 24h,
 * PAUSE both sources by switching their enable toggles OFF and flag the admin (the `bonus_velocity_tripped`
 * banner). Edge-triggered — trips once per breach episode (crossing ≤cap → >cap) and re-arms only after the
 * count falls back to ≤cap — so an admin's manual re-enable (via the toggles) is never immediately overridden.
 * Only trips while a source is live (a flood before go-live must not pre-arm the latch). Signups are never
 * blocked; only issuance pauses.
 */
export async function enforceBonusVelocity(db: Db): Promise<{ count: number; cap: number; tripped: boolean }> {
  const cap = bonusConfig.dailyAccountCap.get();
  const count = await signupCount24h(db);
  let tripped = bonusConfig.velocityTripped.get();
  const anyLive = bonusConfig.signupEnabled.get() || bonusConfig.depositEnabled.get();
  if (anyLive && count > cap && !tripped) {
    await bonusConfig.signupEnabled.set(db, false); // pause == toggles off; admin re-enables via the toggles
    await bonusConfig.depositEnabled.set(db, false);
    await bonusConfig.velocityTripped.set(db, true);
    tripped = true;
  } else if (count <= cap && tripped) {
    await bonusConfig.velocityTripped.set(db, false); // re-arm for the next episode (toggles stay off until the admin acts)
    tripped = false;
  }
  return { count, cap, tripped };
}

/**
 * THE shared grant hook. Both sources call this; it owns velocity, per-source toggle, budget, idempotency, and
 * the grant record. Debits CREDIT_BUDGET with a row-lock (no concurrent overdraw), clamped to the funded
 * balance. Idempotent per (user, type) — one signup bonus and one first-deposit bonus per account. Returns the
 * amount actually granted. No-op when the source is off/paused, the amount is 0, or the budget is empty.
 */
export async function issueBonus(db: Db, userId: string, type: BonusType, amountE6: bigint, refDeposit?: string): Promise<bigint> {
  if (amountE6 <= 0n) return 0n;
  await enforceBonusVelocity(db); // may switch the toggles off on a breach — run BEFORE the enabled check
  const enabled = type === 'signup' ? bonusConfig.signupEnabled.get() : bonusConfig.depositEnabled.get();
  if (!enabled) return 0n;
  return db.tx(async (q) => {
    const id = randomUUID();
    const claimed = await q.query<{ id: string }>(
      `INSERT INTO bonus_grants(id, user_id, type, granted_e6, ref_deposit) VALUES($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, type) DO NOTHING RETURNING id`,
      [id, userId, type, amountE6.toString(), refDeposit ?? null],
    );
    if (!claimed.rows[0]) return 0n; // already granted this type to this user
    const budget = await getOrCreateSystemAccount(q, 'CREDIT_BUDGET');
    const budgetBal = await getBalanceForUpdate(q, budget); // LOCK the source — no concurrent overdraw
    const amount = min(amountE6, budgetBal); // clamp to the funded balance
    if (amount <= 0n) {
      await q.query(`DELETE FROM bonus_grants WHERE id = $1`, [id]); // budget empty → no phantom grant row
      return 0n;
    }
    if (amount !== amountE6) await q.query(`UPDATE bonus_grants SET granted_e6 = $2 WHERE id = $1`, [id, amount.toString()]);
    await q.query(`INSERT INTO bonus_accounts(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING`, [userId]); // credit-origin (review hook)
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    await postTxn(q, {
      reason: type === 'signup' ? 'SIGNUP_BONUS' : 'DEPOSIT_BONUS',
      refType: 'bonus_grant', refId: id,
      entries: [{ accountId: coll, amount }, { accountId: budget, amount: -amount }],
    });
    return amount;
  });
}

/** Signup source: flat `signup_bonus_usd` at account creation. Fired from the login path for NEW accounts only. */
export async function grantSignupBonus(db: Db, userId: string): Promise<bigint> {
  const amount = usdc(bonusConfig.signupUsd.get());
  if (amount <= 0n) return 0n;
  return issueBonus(db, userId, 'signup', amount);
}

/** Deposit source: `deposit_bonus_pct` % of the deposit, $-capped. First deposit only (one 'deposit' grant per
 *  user via the unique index). A 0% rate or a $0 cap ⇒ no bonus (you cannot ship an uncapped % match). */
export async function grantDepositBonus(db: Db, userId: string, depositE6: bigint, depositId: string): Promise<bigint> {
  const pctVal = bonusConfig.depositPct.get();
  const cap = usdc(bonusConfig.depositMaxUsd.get());
  if (pctVal <= 0 || cap <= 0n || depositE6 <= 0n) return 0n;
  const raw = (depositE6 * BigInt(Math.round(pctVal * 100))) / 10000n; // pct → basis points, floored
  return issueBonus(db, userId, 'deposit', min(raw, cap), depositId);
}

/** Admin: move USDC from FEE_REVENUE into CREDIT_BUDGET (the program's funding source). Row-locks + clamps to
 *  the FEE_REVENUE balance — you can't fund more than you've earned. Returns the amount moved. */
export async function fundCreditBudget(db: Db, amountE6: bigint): Promise<bigint> {
  if (amountE6 <= 0n) return 0n;
  return db.tx(async (q) => {
    const fee = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
    const feeBal = await getBalanceForUpdate(q, fee);
    const amount = min(amountE6, feeBal);
    if (amount <= 0n) return 0n;
    const budget = await getOrCreateSystemAccount(q, 'CREDIT_BUDGET');
    await postTxn(q, {
      reason: 'CREDIT_BUDGET_FUND', refType: 'admin', refId: null,
      entries: [{ accountId: budget, amount }, { accountId: fee, amount: -amount }],
    });
    return amount;
  });
}

/**
 * Dormancy-expiry sweep (spec §3.3). Per-grant: claws a bonus grant that has gone UNUSED — no fills by the user
 * in the last `expiryDays` days AND the grant itself is that old — back to CREDIT_BUDGET. Oldest grant first.
 * Margin-safe: claws only `min(remaining, free collateral)`, tracks the claw in `clawed_e6`, and marks a row
 * expired only once its residual is fully clawed — so credit parked in open-position margin is clawed on a later
 * sweep after the position closes, never un-locking the principal. Idempotent (row-locked).
 */
export async function expireBonuses(db: Db): Promise<{ swept: number; clawedE6: bigint }> {
  const days = bonusConfig.expiryDays.get();
  const due = await db.query<{ id: string; user_id: string }>(
    `SELECT bg.id, bg.user_id FROM bonus_grants bg
     WHERE bg.expired_at IS NULL
       AND bg.granted_at < now() - ($1::int * interval '1 day')
       AND NOT EXISTS (
         SELECT 1 FROM fills f JOIN orders o ON o.id = f.order_id
         WHERE o.user_id = bg.user_id AND f.created_at > now() - ($1::int * interval '1 day')
       )
     ORDER BY bg.granted_at ASC`,
    [days],
  );
  let swept = 0;
  let clawedE6 = 0n;
  for (const { id, user_id } of due.rows) {
    const claw = await db.tx(async (q) => {
      const row = await q.query<{ remaining: string }>(
        `SELECT (granted_e6 - clawed_e6)::text AS remaining FROM bonus_grants WHERE id = $1 AND expired_at IS NULL FOR UPDATE`,
        [id],
      );
      if (!row.rows[0]) return 0n; // expired by a concurrent sweep
      const remaining = BigInt(row.rows[0].remaining);
      const coll = await getOrCreateUserAccount(q, user_id, 'USER_COLLATERAL');
      const c = await getBalanceForUpdate(q, coll); // lock — races position-close + withdrawal
      const amount = remaining > 0n ? min(remaining, c) : 0n; // only the free part (residual sits in margin)
      if (amount > 0n) {
        const budget = await getOrCreateSystemAccount(q, 'CREDIT_BUDGET');
        await postTxn(q, {
          reason: 'BONUS_EXPIRE', refType: 'bonus_grant', refId: id,
          entries: [{ accountId: coll, amount: -amount }, { accountId: budget, amount }],
        });
        await q.query(`UPDATE bonus_grants SET clawed_e6 = clawed_e6 + $2 WHERE id = $1`, [id, amount.toString()]);
      }
      if (remaining - amount <= 0n) await q.query(`UPDATE bonus_grants SET expired_at = now() WHERE id = $1`, [id]);
      return amount;
    });
    if (claw > 0n) { swept++; clawedE6 += claw; }
  }
  return { swept, clawedE6 };
}

/** A bonus-origin account's FIRST withdrawal is held for manual review (spec §3d): a grant exists, the operator
 *  hasn't cleared it, and there's no prior confirmed withdrawal. Such a row must NOT auto-approve. */
export async function needsFirstWithdrawalReview(q: Queryer, userId: string): Promise<boolean> {
  const r = await q.query<{ reviewed: boolean }>(`SELECT first_withdrawal_reviewed AS reviewed FROM bonus_accounts WHERE user_id = $1`, [userId]);
  if (!r.rows[0] || r.rows[0].reviewed) return false; // not bonus-origin, or already cleared
  const w = await q.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM withdrawals WHERE user_id = $1 AND status = 'confirmed'`, [userId]);
  return (w.rows[0]?.n ?? 0) === 0;
}

/** Operator clears a bonus-origin account's first-withdrawal hold (after reviewing). Returns whether a held row
 *  was actually cleared. */
export async function clearFirstWithdrawalReview(db: Db, userId: string): Promise<boolean> {
  const r = await db.query<{ user_id: string }>(
    `UPDATE bonus_accounts SET first_withdrawal_reviewed = true WHERE user_id = $1 AND first_withdrawal_reviewed = false RETURNING user_id`,
    [userId],
  );
  return !!r.rows[0];
}

/** Per-user figures for the admin Customers columns. granted = Σ original grants (Free Credit); remaining =
 *  min(outstanding grant, collateral) = the still-locked floor (Remaining). */
export async function bonusSummary(q: Queryer, userId: string): Promise<{ grantedE6: bigint; remainingE6: bigint }> {
  const row = await q.query<{ granted: string }>(`SELECT COALESCE(SUM(granted_e6), 0)::text AS granted FROM bonus_grants WHERE user_id = $1`, [userId]);
  const grantedE6 = BigInt(row.rows[0]?.granted ?? '0');
  if (grantedE6 <= 0n) return { grantedE6: 0n, remainingE6: 0n };
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  const c = await getBalance(q, coll);
  const s = await bonusState(q, userId);
  return { grantedE6, remainingE6: max0(min(s.grantE6, c)) };
}

export interface BonusOverview {
  budgetE6: string; // CREDIT_BUDGET balance (the program's funding / hard cap)
  feeRevenueE6: string; // FEE_REVENUE balance available to top up the budget
  totalIssuedE6: string; // Σ granted across all users + sources (the "total bonuses issued" box)
  signupIssuedE6: string; // Σ granted, signup source
  depositIssuedE6: string; // Σ granted, deposit source
  activeGrants: number; // grants not yet fully expired
  signups24h: number; // new accounts in the last 24h (velocity signal vs dailyAccountCap)
  reviewQueue: Array<{ userId: string; pubkey: string; grantedE6: string; pendingWithdrawalE6: string }>;
}

/** Admin Perks overview: balances, totals by source, the velocity signal, and the first-withdrawal review queue. */
export async function bonusOverview(db: Db): Promise<BonusOverview> {
  const budget = await getBalance(db, await getOrCreateSystemAccount(db, 'CREDIT_BUDGET'));
  const fee = await getBalance(db, await getOrCreateSystemAccount(db, 'FEE_REVENUE'));
  const tot = await db.query<{ t: string; s: string; d: string; n: number }>(
    `SELECT COALESCE(SUM(granted_e6), 0)::text AS t,
            COALESCE(SUM(granted_e6) FILTER (WHERE type = 'signup'), 0)::text AS s,
            COALESCE(SUM(granted_e6) FILTER (WHERE type = 'deposit'), 0)::text AS d,
            COUNT(*) FILTER (WHERE expired_at IS NULL)::int AS n
     FROM bonus_grants`,
  );
  const q = await db.query<{ user_id: string; pubkey: string; granted: string; pending: string }>(
    `SELECT ba.user_id, u.solana_pubkey AS pubkey,
            COALESCE((SELECT SUM(granted_e6) FROM bonus_grants bg WHERE bg.user_id = ba.user_id), 0)::text AS granted,
            COALESCE(SUM(w.amount_e6), 0)::text AS pending
     FROM bonus_accounts ba
     JOIN users u ON u.id = ba.user_id
     JOIN withdrawals w ON w.user_id = ba.user_id AND w.status = 'requested'
     WHERE ba.first_withdrawal_reviewed = false
       AND NOT EXISTS (SELECT 1 FROM withdrawals w2 WHERE w2.user_id = ba.user_id AND w2.status = 'confirmed')
     GROUP BY ba.user_id, u.solana_pubkey`,
  );
  return {
    budgetE6: budget.toString(),
    feeRevenueE6: fee.toString(),
    totalIssuedE6: tot.rows[0]?.t ?? '0',
    signupIssuedE6: tot.rows[0]?.s ?? '0',
    depositIssuedE6: tot.rows[0]?.d ?? '0',
    activeGrants: tot.rows[0]?.n ?? 0,
    signups24h: await signupCount24h(db),
    reviewQueue: q.rows.map((r) => ({ userId: r.user_id, pubkey: r.pubkey, grantedE6: r.granted, pendingWithdrawalE6: r.pending })),
  };
}
