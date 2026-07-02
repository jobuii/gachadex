import { randomUUID } from 'node:crypto';
import type { Queryer } from '../db/client.ts';

/**
 * Double-entry ledger. Every money movement is a balanced set of entries (Σ = 0).
 * `balances` is a cache updated in the same transaction as the entries; the
 * reconciler proves it equals SUM(ledger_entries) and that every txn nets to zero.
 *
 * All `postTxn` calls MUST run inside a db.tx(...) so entries + balance updates
 * commit atomically and the deferred balanced-txn constraint can validate at COMMIT.
 */

export type AccountType =
  | 'USER_COLLATERAL'
  | 'USER_POSITION_MARGIN'
  // Per-user reserve held against a resting limit-OPEN order (docs/limit-stop-orders-spec.md). Lazily
  // created via getOrCreateUserAccount on first reserve; released to collateral on fill/cancel. NOT a
  // system account. Always 0 until resting orders ship (P1).
  | 'RESTING_ORDER_MARGIN'
  | 'LP_POOL'
  | 'INSURANCE_FUND'
  | 'FEE_REVENUE'
  | 'FUNDING_POOL'
  | 'PNL_CLEARING'
  | 'FAUCET_SOURCE'
  | 'TREASURY_USDC'
  | 'DROP_POOL'
  | 'GAME_POOL'
  | 'GACHA_REWARDS_BUDGET'
  | 'CREDIT_BUDGET';

/** System (house) accounts — one row each, user_id NULL. */
export const SYSTEM_ACCOUNT_TYPES: AccountType[] = [
  'LP_POOL',
  'INSURANCE_FUND',
  'FEE_REVENUE',
  'FUNDING_POOL',
  'PNL_CLEARING',
  'FAUCET_SOURCE',
  // DROP giveaway pot (docs/chat-social-spec.md F6). Funded by the house floor each round + real-USDC
  // player tips; debited to buy the TCG pack. Phase 1 only reads its balance for the admin CHAT view.
  'DROP_POOL',
  // Games house bankroll / prize pot (docs/games-spec.md). Wagers credit it; prize sell-backs debit
  // it; the net house edge (the buyback spread) accrues here. Operator seeds the float (play-money
  // from FAUCET_SOURCE; real-funds from treasury/fees) — a single prize can exceed its play's wager.
  'GAME_POOL',
  // Classic Gacha loyalty budget (docs/classic-gacha-cc-packs-spec.md §6b). Pre-funded by the operator; a
  // gold-bought pack debits it to pay CC real USDC (Gold is a cost, not revenue — kept OUT of FEE_REVENUE,
  // which is shared with LP fees + affiliate cashback). Its negative balance = outstanding deferred liability.
  'GACHA_REWARDS_BUDGET',
  // Bonus-credit budget (docs/bonus-credits-spec.md). Pre-funded by the operator from FEE_REVENUE
  // (admin Perks page); SIGNUP_BONUS / DEPOSIT_BONUS grants debit it into USER_COLLATERAL. Its balance is the
  // program's hard cap (grants clamp to it). Dark until the per-source *_bonus_enabled toggles.
  'CREDIT_BUDGET',
  // Real-funds custody mirror (docs/real-funds-custody-plan.md): the only account real deposits/
  // withdrawals touch. Its negative balance == total internal claims; the chain reconciler asserts
  // on-chain treasury USDC >= |TREASURY_USDC| (proof of reserves). Unused until REAL_FUNDS paths land.
  'TREASURY_USDC',
];

export interface Entry {
  accountId: string;
  amount: bigint; // signed micro-USDC; +credit / -debit
}

export interface PostTxnOpts {
  reason: string;
  refType?: string | null;
  refId?: string | null;
  entries: Entry[];
}

export async function getOrCreateSystemAccount(q: Queryer, type: AccountType): Promise<string> {
  const id = randomUUID();
  await q.query(
    `INSERT INTO accounts(id, user_id, type) VALUES($1, NULL, $2)
     ON CONFLICT (type) WHERE user_id IS NULL DO NOTHING`,
    [id, type],
  );
  const r = await q.query<{ id: string }>(
    `SELECT id FROM accounts WHERE user_id IS NULL AND type = $1`,
    [type],
  );
  return r.rows[0].id;
}

export async function getOrCreateUserAccount(q: Queryer, userId: string, type: AccountType): Promise<string> {
  const id = randomUUID();
  await q.query(
    `INSERT INTO accounts(id, user_id, type) VALUES($1, $2, $3)
     ON CONFLICT (user_id, type) WHERE user_id IS NOT NULL DO NOTHING`,
    [id, userId, type],
  );
  const r = await q.query<{ id: string }>(
    `SELECT id FROM accounts WHERE user_id = $1 AND type = $2`,
    [userId, type],
  );
  return r.rows[0].id;
}

export async function ensureSystemAccounts(q: Queryer): Promise<Record<AccountType, string>> {
  const out = {} as Record<AccountType, string>;
  for (const t of SYSTEM_ACCOUNT_TYPES) out[t] = await getOrCreateSystemAccount(q, t);
  return out;
}

/**
 * Post a balanced set of ledger entries as one transaction record. Asserts Σ = 0
 * (friendly error), then writes entries + updates the balance cache. Returns txn_id.
 */
export async function postTxn(q: Queryer, opts: PostTxnOpts): Promise<string> {
  const { reason, refType = null, refId = null, entries } = opts;
  if (entries.length === 0) throw new Error('postTxn: no entries');
  const sum = entries.reduce((a, e) => a + e.amount, 0n);
  if (sum !== 0n) throw new Error(`postTxn: unbalanced entries (sum=${sum.toString()})`);

  const txnId = randomUUID();
  for (const e of entries) {
    if (e.amount === 0n) continue; // skip no-op legs
    await q.query(
      `INSERT INTO ledger_entries(txn_id, account_id, amount_uusdc, reason, ref_type, ref_id)
       VALUES($1, $2, $3, $4, $5, $6)`,
      [txnId, e.accountId, e.amount.toString(), reason, refType, refId],
    );
    await q.query(
      `INSERT INTO balances(account_id, amount_uusdc, version) VALUES($1, $2, 1)
       ON CONFLICT(account_id) DO UPDATE
         SET amount_uusdc = balances.amount_uusdc + EXCLUDED.amount_uusdc,
             version = balances.version + 1,
             updated_at = now()`,
      [e.accountId, e.amount.toString()],
    );
  }
  return txnId;
}

export async function getBalance(q: Queryer, accountId: string): Promise<bigint> {
  const r = await q.query<{ amt: string }>(
    `SELECT amount_uusdc::text AS amt FROM balances WHERE account_id = $1`,
    [accountId],
  );
  return r.rows[0] ? BigInt(r.rows[0].amt) : 0n;
}

/** Like getBalance, but takes a row-lock (SELECT … FOR UPDATE) on the balance row inside the caller's tx, so a
 *  check-then-debit is atomic: concurrent debits on the same account serialize, and two callers can't both pass
 *  a balance guard and over-draw it. Use this (not getBalance) whenever the read gates a debit in the same tx.
 *  A missing balances row → no lock + 0n, which correctly fails any positive guard (nothing to debit). */
export async function getBalanceForUpdate(q: Queryer, accountId: string): Promise<bigint> {
  const r = await q.query<{ amt: string }>(
    `SELECT amount_uusdc::text AS amt FROM balances WHERE account_id = $1 FOR UPDATE`,
    [accountId],
  );
  return r.rows[0] ? BigInt(r.rows[0].amt) : 0n;
}
