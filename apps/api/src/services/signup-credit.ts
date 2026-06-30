import { randomUUID } from 'node:crypto';
import type { Db, Queryer } from '../db/client.ts';
import { usdc } from '../money.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, getBalance, getBalanceForUpdate, postTxn } from './ledger.ts';
import { signupCreditConfig } from './signup-credit-config.ts';

/**
 * Free signup-credit money engine (docs/signup-credit-spec.md, Phase 1 — DARK behind signup_credit_enabled).
 * The grant is a SIGNUP_CREDIT ledger entry into USER_COLLATERAL drawn from CREDIT_BUDGET; the principal is
 * never withdrawable (the floor); winnings withdraw only after the wagering gate. `signup_credits` tracks the
 * lifecycle. The whole withdrawal rule lives in ONE helper (floorWithdrawable / withdrawableBalance) so the
 * chokepoint, the UI, and tests share it. NB: never use it in treasury PoR liability — the credit is still a
 * real liability (spec §2.4 / M7).
 */

const max0 = (x: bigint): bigint => (x > 0n ? x : 0n);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b); // bigint clamp (Math.min doesn't take bigint)

export interface CreditState {
  grantE6: bigint; // outstanding grant principal: Σ SIGNUP_CREDIT − Σ SIGNUP_CREDIT_EXPIRE (>= 0)
  netDepositsE6: bigint; // own net real capital in: Σ DEPOSIT − Σ WITHDRAWAL + Σ WITHDRAWAL_REVERSAL (>= 0)
  wageringMet: boolean; // LIVE: netDeposits >= wagerDeposit AND post-first-deposit fill volume >= wagerVolume
}

/** Ledger-derived credit state (no locks — historical sums). */
export async function creditState(q: Queryer, userId: string): Promise<CreditState> {
  const sums = await q.query<{ grant: string; net_dep: string; first_dep: string | null }>(
    `SELECT
       COALESCE(SUM(le.amount_uusdc) FILTER (WHERE le.reason IN ('SIGNUP_CREDIT','SIGNUP_CREDIT_EXPIRE')), 0)::text AS grant,
       COALESCE(SUM(le.amount_uusdc) FILTER (WHERE le.reason IN ('DEPOSIT','WITHDRAWAL','WITHDRAWAL_REVERSAL')), 0)::text AS net_dep,
       MIN(le.created_at) FILTER (WHERE le.reason = 'DEPOSIT')::text AS first_dep
     FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
     WHERE a.user_id = $1 AND a.type = 'USER_COLLATERAL'`,
    [userId],
  );
  const grantE6 = max0(BigInt(sums.rows[0]?.grant ?? '0'));
  const netDepositsE6 = max0(BigInt(sums.rows[0]?.net_dep ?? '0'));
  const firstDep = sums.rows[0]?.first_dep ?? null;

  let wageringMet = false;
  // Only bother computing volume when the deposit threshold is already met (and there's a grant to gate).
  if (grantE6 > 0n && firstDep && netDepositsE6 >= usdc(signupCreditConfig.wagerDepositUsd.get())) {
    const vol = await q.query<{ vol: string }>(
      `SELECT COALESCE(FLOOR(SUM(f.qty_e6::numeric * f.exec_price_e6) / 1000000), 0)::text AS vol
       FROM fills f JOIN orders o ON o.id = f.order_id
       WHERE o.user_id = $1 AND f.created_at >= $2`,
      [userId, firstDep],
    );
    wageringMet = BigInt(vol.rows[0]?.vol ?? '0') >= usdc(signupCreditConfig.wagerVolumeUsd.get());
  }
  return { grantE6, netDepositsE6, wageringMet };
}

/**
 * THE withdrawable rule (spec §2.2 — single authority). `collateralE6` is the user's USER_COLLATERAL balance
 * (pass the row-locked balance at the withdrawal chokepoint). A normal (non-credit) account returns the full
 * balance unchanged. A credit account: post-wagering = everything above the grant; pre-wagering = only their
 * own deposited capital back (no winnings). The grant principal is never returned.
 */
export function floorWithdrawable(collateralE6: bigint, s: CreditState): bigint {
  if (s.grantE6 <= 0n) return max0(collateralE6); // no credit → identical to the raw balance (spec L2)
  const nonGrant = max0(collateralE6 - s.grantE6); // ceiling: everything above the locked grant
  if (s.wageringMet) return nonGrant;
  return min(nonGrant, s.netDepositsE6); // pre-wagering: capped to own deposits
}

/** The one withdrawal-cap helper for non-locked contexts (UI "max withdrawable"). The chokepoint computes
 *  floorWithdrawable() directly off its row-locked balance instead. NOT for treasury PoR liability (M7). */
export async function withdrawableBalance(q: Queryer, userId: string): Promise<bigint> {
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  return floorWithdrawable(await getBalance(q, coll), await creditState(q, userId));
}

/**
 * Grant the configured signup credit to a user. Idempotent (one row per user). Debits CREDIT_BUDGET with a
 * row-lock so concurrent grants can't overdraw it (spec M3), clamped to the funded balance. No-op when
 * disabled, the amount is 0, or the budget is empty. Returns the amount actually granted.
 */
export async function grantSignupCredit(db: Db, userId: string): Promise<bigint> {
  if (!signupCreditConfig.enabled.get()) return 0n;
  const want = usdc(signupCreditConfig.grantUsd.get());
  if (want <= 0n) return 0n;
  return db.tx(async (q) => {
    const id = randomUUID();
    const claimed = await q.query<{ id: string }>(
      `INSERT INTO signup_credits(id, user_id, granted_e6) VALUES($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING RETURNING id`,
      [id, userId, want.toString()],
    );
    if (!claimed.rows[0]) return 0n; // already granted once
    const budget = await getOrCreateSystemAccount(q, 'CREDIT_BUDGET');
    const budgetBal = await getBalanceForUpdate(q, budget); // LOCK the source — no concurrent overdraw
    const amount = min(want, budgetBal); // clamp to the funded balance
    if (amount <= 0n) {
      await q.query(`DELETE FROM signup_credits WHERE id = $1`, [id]); // budget empty → no phantom grant row
      return 0n;
    }
    if (amount !== want) await q.query(`UPDATE signup_credits SET granted_e6 = $2 WHERE id = $1`, [id, amount.toString()]);
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    await postTxn(q, {
      reason: 'SIGNUP_CREDIT', refType: 'signup_credit', refId: id,
      entries: [{ accountId: coll, amount }, { accountId: budget, amount: -amount }],
    });
    return amount;
  });
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
 * Hard-expiry sweep (spec §2.5 / M1, M2). Claws the residual grant of accounts whose grant is older than
 * `expiryDays` back to CREDIT_BUDGET. Margin-safe: claws only what's in free collateral, reduces the
 * outstanding grant by exactly what's clawed, and only marks the row expired once nothing is outstanding —
 * so credit parked in open-position margin is clawed on a later sweep after the position closes, never
 * un-locking the principal. Idempotent (row-locked).
 */
export async function expireSignupCredits(db: Db): Promise<{ swept: number; clawedE6: bigint }> {
  const days = signupCreditConfig.expiryDays.get();
  const due = await db.query<{ user_id: string }>(
    `SELECT user_id FROM signup_credits
     WHERE expired_at IS NULL AND granted_at < now() - ($1::int * interval '1 day')`,
    [days],
  );
  let swept = 0;
  let clawedE6 = 0n;
  for (const { user_id } of due.rows) {
    const claw = await db.tx(async (q) => {
      const coll = await getOrCreateUserAccount(q, user_id, 'USER_COLLATERAL');
      const c = await getBalanceForUpdate(q, coll); // lock — races position-close + withdrawal
      const s = await creditState(q, user_id);
      if (s.grantE6 <= 0n) {
        await q.query(`UPDATE signup_credits SET expired_at = now() WHERE user_id = $1 AND expired_at IS NULL`, [user_id]);
        return 0n;
      }
      const amount = min(s.grantE6, c); // only the free part (residual sits in margin)
      if (amount > 0n) {
        const budget = await getOrCreateSystemAccount(q, 'CREDIT_BUDGET');
        await postTxn(q, {
          reason: 'SIGNUP_CREDIT_EXPIRE', refType: 'signup_credit', refId: user_id,
          entries: [{ accountId: coll, amount: -amount }, { accountId: budget, amount }],
        });
      }
      if (s.grantE6 - amount <= 0n) {
        await q.query(`UPDATE signup_credits SET expired_at = now() WHERE user_id = $1 AND expired_at IS NULL`, [user_id]);
      }
      return amount;
    });
    if (claw > 0n) {
      swept++;
      clawedE6 += claw;
    }
  }
  return { swept, clawedE6 };
}

/** A credit-origin account's FIRST withdrawal is held for manual review (spec §3d): a grant exists, the
 *  operator hasn't cleared it, and there's no prior confirmed withdrawal. Such a row must NOT auto-approve. */
export async function needsFirstWithdrawalReview(q: Queryer, userId: string): Promise<boolean> {
  const r = await q.query<{ reviewed: boolean }>(`SELECT first_withdrawal_reviewed AS reviewed FROM signup_credits WHERE user_id = $1`, [userId]);
  if (!r.rows[0] || r.rows[0].reviewed) return false; // not credit-origin, or already cleared
  const w = await q.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM withdrawals WHERE user_id = $1 AND status = 'confirmed'`, [userId]);
  return (w.rows[0]?.n ?? 0) === 0;
}

/** Per-user figures for the admin Customers columns. granted = original grant (Free Credit); remaining =
 *  min(outstanding grant, collateral) = the still-locked floor (Remaining). */
export async function creditSummary(q: Queryer, userId: string): Promise<{ grantedE6: bigint; remainingE6: bigint }> {
  const row = await q.query<{ granted: string }>(`SELECT COALESCE(granted_e6, 0)::text AS granted FROM signup_credits WHERE user_id = $1`, [userId]);
  const grantedE6 = BigInt(row.rows[0]?.granted ?? '0');
  if (grantedE6 <= 0n) return { grantedE6: 0n, remainingE6: 0n };
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  const c = await getBalance(q, coll);
  const s = await creditState(q, userId);
  return { grantedE6, remainingE6: max0(min(s.grantE6, c)) };
}

export interface SignupCreditOverview {
  budgetE6: string; // CREDIT_BUDGET balance (the program's funding / hard cap)
  feeRevenueE6: string; // FEE_REVENUE balance available to top up the budget
  totalIssuedE6: string; // Σ granted across all users (the "total bonuses issued" box)
  activeGrants: number;
  reviewQueue: Array<{ userId: string; pubkey: string; grantedE6: string; pendingWithdrawalE6: string }>;
}

/** Admin Perks overview: balances, total issued, and the first-withdrawal review queue (credit-origin
 *  accounts with a `requested` withdrawal that hasn't been cleared and has no prior confirmed withdrawal). */
export async function signupCreditOverview(db: Db): Promise<SignupCreditOverview> {
  const budget = await getBalance(db, await getOrCreateSystemAccount(db, 'CREDIT_BUDGET'));
  const fee = await getBalance(db, await getOrCreateSystemAccount(db, 'FEE_REVENUE'));
  const tot = await db.query<{ t: string; n: number }>(
    `SELECT COALESCE(SUM(granted_e6), 0)::text AS t, COUNT(*) FILTER (WHERE expired_at IS NULL)::int AS n FROM signup_credits`,
  );
  const q = await db.query<{ user_id: string; pubkey: string; granted: string; pending: string }>(
    `SELECT sc.user_id, u.solana_pubkey AS pubkey, sc.granted_e6::text AS granted,
            COALESCE(SUM(w.amount_e6), 0)::text AS pending
     FROM signup_credits sc
     JOIN users u ON u.id = sc.user_id
     JOIN withdrawals w ON w.user_id = sc.user_id AND w.status = 'requested'
     WHERE sc.first_withdrawal_reviewed = false
       AND NOT EXISTS (SELECT 1 FROM withdrawals w2 WHERE w2.user_id = sc.user_id AND w2.status = 'confirmed')
     GROUP BY sc.user_id, u.solana_pubkey, sc.granted_e6`,
  );
  return {
    budgetE6: budget.toString(),
    feeRevenueE6: fee.toString(),
    totalIssuedE6: tot.rows[0]?.t ?? '0',
    activeGrants: tot.rows[0]?.n ?? 0,
    reviewQueue: q.rows.map((r) => ({ userId: r.user_id, pubkey: r.pubkey, grantedE6: r.granted, pendingWithdrawalE6: r.pending })),
  };
}

/** Operator clears a credit-origin account's first-withdrawal hold (after reviewing the cluster signal), so the
 *  auto-process loop will pay it next pass. Returns whether a held row was actually cleared. */
export async function clearFirstWithdrawalReview(db: Db, userId: string): Promise<boolean> {
  const r = await db.query<{ user_id: string }>(
    `UPDATE signup_credits SET first_withdrawal_reviewed = true WHERE user_id = $1 AND first_withdrawal_reviewed = false RETURNING user_id`,
    [userId],
  );
  return !!r.rows[0];
}
