import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import type { Db, Queryer } from '../db/client.ts';
import { upsertUser } from './auth.ts';
import { setReferralCode } from './referral.ts';

/**
 * Affiliate / KOL referral economics. An affiliate is a user; their shared code is `users.referral_code`
 * and their referees link via `users.referred_by` (the existing referral plumbing). Two operator-set knobs
 * (in `affiliate_terms`): a discount on the affiliate's OWN trading fees, and a cashback % of their
 * referees' fees paid to them from the house FEE_REVENUE share. See docs/affiliate-referral-economics-spec.md.
 */

/** Cashback can't exceed the house's share of a fee (FEE_REVENUE = 100% − feeLpSharePct), or the house
 *  revenue leg would underflow. Enforced at set-time here; chargeFee also clamps at runtime. */
export function maxCashbackBps(): number {
  return Math.max(0, 10000 - config.feeLpSharePct * 100);
}

export interface FeeAffiliate {
  discountBps: number; // the trader's own fee discount (0 if they're not an active affiliate)
  cashback: { userId: string; bps: number } | null; // cashback owed to the trader's referrer (null if none)
}

/** One indexed lookup on the fee hot path: resolve BOTH the trader's own fee discount AND any cashback
 *  owed to the affiliate who referred them. Inactive affiliates resolve to no discount / no cashback. */
export async function resolveFeeAffiliate(q: Queryer, traderUserId: string): Promise<FeeAffiliate> {
  const r = await q.query<{ discount_bps: number | null; cb_user: string | null; cb_bps: number | null }>(
    `SELECT own.fee_discount_bps AS discount_bps, ref.user_id AS cb_user, ref.cashback_bps AS cb_bps
       FROM users u
       LEFT JOIN affiliate_terms own ON own.user_id = u.id          AND own.active
       LEFT JOIN affiliate_terms ref ON ref.user_id = u.referred_by AND ref.active
      WHERE u.id = $1`,
    [traderUserId],
  );
  const row = r.rows[0];
  const discountBps = row?.discount_bps ?? 0;
  const cashback = row?.cb_user && (row.cb_bps ?? 0) > 0 ? { userId: row.cb_user, bps: row.cb_bps as number } : null;
  return { discountBps, cashback };
}

/** Apply a fee discount (bps off the gross fee). discountBps clamped to [0, 10000]. Integer-floor. */
export function applyFeeDiscount(grossFee: bigint, discountBps: number): bigint {
  const d = BigInt(Math.max(0, Math.min(10000, Math.floor(discountBps || 0))));
  return grossFee - (grossFee * d) / 10000n;
}

// ---- operator (admin) ------------------------------------------------------

function validateBps(v: unknown, name: string, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, `${name} must be an integer 0–${max} bps`);
  return n;
}

export interface AffiliateRow {
  userId: string;
  pubkey: string;
  code: string | null;
  cashbackBps: number;
  feeDiscountBps: number;
  label: string | null;
  active: boolean;
  referrals: number; // how many accounts this affiliate has referred
  cashbackPaidUusdc: string; // lifetime cashback credited to this affiliate
}

interface AffiliateDbRow {
  user_id: string;
  pubkey: string;
  code: string | null;
  cashback_bps: number;
  fee_discount_bps: number;
  label: string | null;
  active: boolean;
  referrals: string;
  cashback_paid: string;
}

const SELECT_AFFILIATES = `
  SELECT t.user_id, u.solana_pubkey AS pubkey, u.referral_code AS code,
         t.cashback_bps, t.fee_discount_bps, t.label, t.active,
         (SELECT count(*) FROM users r WHERE r.referred_by = t.user_id) AS referrals,
         COALESCE((SELECT SUM(le.amount_uusdc) FROM ledger_entries le
                     JOIN accounts a ON a.id = le.account_id
                    WHERE a.user_id = t.user_id AND a.type = 'USER_COLLATERAL'
                      AND le.reason = 'REFERRAL_CASHBACK'), 0) AS cashback_paid
    FROM affiliate_terms t JOIN users u ON u.id = t.user_id`;

function toRow(x: AffiliateDbRow): AffiliateRow {
  return {
    userId: x.user_id,
    pubkey: x.pubkey,
    code: x.code,
    cashbackBps: x.cashback_bps,
    feeDiscountBps: x.fee_discount_bps,
    label: x.label,
    active: x.active,
    referrals: Number(x.referrals),
    cashbackPaidUusdc: x.cashback_paid,
  };
}

/** Lifetime referral cashback credited to this user (for their Portfolio "Cashback" card). */
export async function getCashbackTotal(q: Queryer, userId: string): Promise<bigint> {
  const r = await q.query<{ total: string }>(
    `SELECT COALESCE(SUM(le.amount_uusdc), 0)::text AS total
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
      WHERE a.user_id = $1 AND a.type = 'USER_COLLATERAL' AND le.reason = 'REFERRAL_CASHBACK'`,
    [userId],
  );
  return BigInt(r.rows[0].total);
}

export async function listAffiliates(db: Db): Promise<AffiliateRow[]> {
  const r = await db.query<AffiliateDbRow>(`${SELECT_AFFILIATES} ORDER BY t.created_at DESC`);
  return r.rows.map(toRow);
}

/** Operator: link a wallet to a (branded, optional) referral code with cashback + discount terms.
 *  Creates the account if the wallet never signed in. Idempotent per wallet (upsert). */
export async function setAffiliateTerms(
  db: Db,
  opts: { pubkey: string; code?: string; cashbackBps: unknown; feeDiscountBps: unknown; label?: string; active?: boolean },
): Promise<AffiliateRow> {
  const cashbackBps = validateBps(opts.cashbackBps, 'cashbackBps', maxCashbackBps());
  const feeDiscountBps = validateBps(opts.feeDiscountBps, 'feeDiscountBps', 10000);
  const pubkey = opts.pubkey?.trim();
  if (!pubkey) throw new HttpError(400, 'pubkey required');
  // null = "leave unchanged" on update — so editing an affiliate's rates doesn't silently re-enable
  // one the operator deactivated; defaults to true on create.
  const active = opts.active ?? null;

  const userId = await upsertUser(db, pubkey);
  if (opts.code) await setReferralCode(db, userId, opts.code); // validates length/charset + uniqueness, reserves old code
  await db.query(
    `INSERT INTO affiliate_terms(user_id, cashback_bps, fee_discount_bps, label, active, updated_at)
       VALUES($1, $2, $3, $4, COALESCE($5, true), now())
     ON CONFLICT(user_id) DO UPDATE SET
       cashback_bps = EXCLUDED.cashback_bps, fee_discount_bps = EXCLUDED.fee_discount_bps,
       label = EXCLUDED.label, active = COALESCE($5, affiliate_terms.active), updated_at = now()`,
    [userId, cashbackBps, feeDiscountBps, opts.label ?? null, active],
  );
  const r = await db.query<AffiliateDbRow>(`${SELECT_AFFILIATES} WHERE t.user_id = $1`, [userId]);
  return toRow(r.rows[0]);
}
