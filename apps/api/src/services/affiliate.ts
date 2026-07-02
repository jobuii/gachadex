import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import type { Db, Queryer } from '../db/client.ts';
import { liveKnob } from './live-knob.ts';
import { upsertUser } from './auth.ts';
import { setReferralCodeTx } from './referral.ts';

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

/** The game-revenue share can be up to 100% of the gacha house revenue it's drawn from — gacha cuts/markup post
 *  fully to FEE_REVENUE (no LP split) — and the accrual clamps to the actual revenue at runtime. */
export function maxGameRevenueBps(): number {
  return 10000;
}

export interface FeeAffiliate {
  discountBps: number; // the trader's own fee discount (0 if they're not an active affiliate)
  cashback: { userId: string; bps: number } | null; // cashback owed to the trader's referrer (null if none)
}

/** One indexed lookup on the fee hot path: resolve BOTH the trader's own fee discount AND any cashback
 *  owed to the affiliate who referred them. An active per-wallet `affiliate_terms` row OVERRIDES (even with a
 *  lower/zero rate); otherwise the platform-wide defaults apply (0 unless an operator set them). Cashback is
 *  still only owed when the trader was referred — there has to be a referrer to pay. */
export async function resolveFeeAffiliate(q: Queryer, traderUserId: string): Promise<FeeAffiliate> {
  const r = await q.query<{ own_discount: number | null; referrer_id: string | null; ref_cashback: number | null }>(
    `SELECT own.fee_discount_bps AS own_discount,
            u.referred_by        AS referrer_id,
            ref.cashback_bps     AS ref_cashback
       FROM users u
       LEFT JOIN affiliate_terms own ON own.user_id = u.id          AND own.active
       LEFT JOIN affiliate_terms ref ON ref.user_id = u.referred_by AND ref.active
      WHERE u.id = $1`,
    [traderUserId],
  );
  const row = r.rows[0];
  // own fee discount: an active individual term wins (even if lower/zero); else the platform default.
  const discountBps = row?.own_discount ?? getPlatformFeeDiscountBps();
  // cashback to the referrer (only when this trader was referred): their active term wins; else platform default.
  let cashback: FeeAffiliate['cashback'] = null;
  if (row?.referrer_id) {
    const bps = row.ref_cashback ?? getPlatformCashbackBps();
    if (bps > 0) cashback = { userId: row.referrer_id, bps };
  }
  return { discountBps, cashback };
}

/** Resolve the game-revenue share owed to the affiliate who referred `playerUserId`, for a gacha house-revenue
 *  event (sell-back cut / pack markup). The referrer's active per-wallet term wins; else the platform default.
 *  Null when the player wasn't referred or the rate is 0. (Separate from cashback, which stays perps-only.) */
export async function resolveGameRevenueAffiliate(q: Queryer, playerUserId: string): Promise<{ userId: string; bps: number } | null> {
  const r = await q.query<{ referrer_id: string | null; ref_game: number | null }>(
    `SELECT u.referred_by AS referrer_id, ref.game_revenue_bps AS ref_game
       FROM users u LEFT JOIN affiliate_terms ref ON ref.user_id = u.referred_by AND ref.active
      WHERE u.id = $1`,
    [playerUserId],
  );
  const row = r.rows[0];
  if (!row?.referrer_id) return null;
  const bps = row.ref_game ?? getPlatformGameRevenueBps();
  return bps > 0 ? { userId: row.referrer_id, bps } : null;
}

/** Apply a fee discount (bps off the gross fee). discountBps clamped to [0, 10000]. Integer-floor. */
export function applyFeeDiscount(grossFee: bigint, discountBps: number): bigint {
  const d = BigInt(Math.max(0, Math.min(10000, Math.floor(discountBps || 0))));
  return grossFee - (grossFee * d) / 10000n;
}

// ---- platform-wide defaults -----------------------------------------------
// Cashback % + own-fee-discount % that apply to EVERY wallet by default (settings-backed, cached for the fee
// hot path; default 0 = dormant, zero behaviour change). An active per-wallet `affiliate_terms` row overrides
// these for that wallet. Cashback is still only paid when a trader was referred (there must be a referrer).
const platformCashback = liveKnob('platform_cashback_bps', 0, (v) => validateBps(v, 'platform cashbackBps', maxCashbackBps()));
const platformFeeDiscount = liveKnob('platform_fee_discount_bps', 0, (v) => validateBps(v, 'platform feeDiscountBps', 10000));
const platformGameRevenue = liveKnob('platform_game_revenue_bps', 0, (v) => validateBps(v, 'platform gameRevenueBps', maxGameRevenueBps()));

export const getPlatformCashbackBps = platformCashback.get;
export const getPlatformFeeDiscountBps = platformFeeDiscount.get;
export const getPlatformGameRevenueBps = platformGameRevenue.get;
export const loadPlatformCashbackBps = platformCashback.load;
export const loadPlatformFeeDiscountBps = platformFeeDiscount.load;
export const loadPlatformGameRevenueBps = platformGameRevenue.load;

export function platformDefaultsView(): { cashbackBps: number; feeDiscountBps: number; gameRevenueBps: number; maxCashbackBps: number; maxGameRevenueBps: number } {
  return { cashbackBps: platformCashback.get(), feeDiscountBps: platformFeeDiscount.get(), gameRevenueBps: platformGameRevenue.get(), maxCashbackBps: maxCashbackBps(), maxGameRevenueBps: maxGameRevenueBps() };
}

/** Operator: set the platform-wide default cashback + fee-discount (bps). Validates BOTH before writing
 *  either, so a bad value can't leave the two knobs half-applied. */
export async function setPlatformAffiliateDefaults(
  db: Db,
  opts: { cashbackBps: unknown; feeDiscountBps: unknown; gameRevenueBps: unknown },
): Promise<ReturnType<typeof platformDefaultsView>> {
  validateBps(opts.cashbackBps, 'cashbackBps', maxCashbackBps());
  validateBps(opts.feeDiscountBps, 'feeDiscountBps', 10000);
  validateBps(opts.gameRevenueBps, 'gameRevenueBps', maxGameRevenueBps());
  await platformCashback.set(db, opts.cashbackBps);
  await platformFeeDiscount.set(db, opts.feeDiscountBps);
  await platformGameRevenue.set(db, opts.gameRevenueBps);
  return platformDefaultsView();
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
  gameRevenueBps: number;
  label: string | null;
  active: boolean;
  referrals: number; // how many accounts this affiliate has referred
  cashbackPaidUusdc: string; // lifetime cashback credited to this affiliate
  gameRevenuePaidUusdc: string; // lifetime gacha game-revenue share credited to this affiliate
}

interface AffiliateDbRow {
  user_id: string;
  pubkey: string;
  code: string | null;
  cashback_bps: number;
  fee_discount_bps: number;
  game_revenue_bps: number;
  label: string | null;
  active: boolean;
  referrals: string;
  cashback_paid: string;
  game_revenue_paid: string;
}

const SELECT_AFFILIATES = `
  SELECT t.user_id, u.solana_pubkey AS pubkey, u.referral_code AS code,
         t.cashback_bps, t.fee_discount_bps, t.game_revenue_bps, t.label, t.active,
         (SELECT count(*) FROM users r WHERE r.referred_by = t.user_id) AS referrals,
         COALESCE((SELECT SUM(le.amount_uusdc) FROM ledger_entries le
                     JOIN accounts a ON a.id = le.account_id
                    WHERE a.user_id = t.user_id AND a.type = 'USER_COLLATERAL'
                      AND le.reason = 'REFERRAL_CASHBACK'), 0) AS cashback_paid,
         COALESCE((SELECT SUM(le.amount_uusdc) FROM ledger_entries le
                     JOIN accounts a ON a.id = le.account_id
                    WHERE a.user_id = t.user_id AND a.type = 'USER_COLLATERAL'
                      AND le.reason = 'GAME_REVENUE_SHARE'), 0) AS game_revenue_paid
    FROM affiliate_terms t JOIN users u ON u.id = t.user_id`;

function toRow(x: AffiliateDbRow): AffiliateRow {
  return {
    userId: x.user_id,
    pubkey: x.pubkey,
    code: x.code,
    cashbackBps: x.cashback_bps,
    feeDiscountBps: x.fee_discount_bps,
    gameRevenueBps: x.game_revenue_bps,
    label: x.label,
    active: x.active,
    referrals: Number(x.referrals),
    cashbackPaidUusdc: x.cashback_paid,
    gameRevenuePaidUusdc: x.game_revenue_paid,
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
  opts: { pubkey: string; code?: string; cashbackBps: unknown; feeDiscountBps: unknown; gameRevenueBps?: unknown; label?: string; active?: boolean },
): Promise<AffiliateRow> {
  const cashbackBps = validateBps(opts.cashbackBps, 'cashbackBps', maxCashbackBps());
  const feeDiscountBps = validateBps(opts.feeDiscountBps, 'feeDiscountBps', 10000);
  const gameRevenueBps = validateBps(opts.gameRevenueBps ?? 0, 'gameRevenueBps', maxGameRevenueBps());
  const pubkey = opts.pubkey?.trim();
  if (!pubkey) throw new HttpError(400, 'pubkey required');
  // null = "leave unchanged" on update — so editing an affiliate's rates doesn't silently re-enable
  // one the operator deactivated; defaults to true on create.
  const active = opts.active ?? null;

  // All three writes (account upsert → branded code → terms) run in ONE transaction so a mid-way
  // failure can't leave a half-made affiliate (a code with no terms, or terms with no code).
  const userId = await db.tx(async (q) => {
    const { id: uid } = await upsertUser(q, pubkey); // admin affiliate setup — no signup bonus (not an organic signup)
    if (opts.code) await setReferralCodeTx(q, uid, opts.code); // validates length/charset + uniqueness, reserves old code
    await q.query(
      `INSERT INTO affiliate_terms(user_id, cashback_bps, fee_discount_bps, game_revenue_bps, label, active, updated_at)
         VALUES($1, $2, $3, $4, $5, COALESCE($6, true), now())
       ON CONFLICT(user_id) DO UPDATE SET
         cashback_bps = EXCLUDED.cashback_bps, fee_discount_bps = EXCLUDED.fee_discount_bps,
         game_revenue_bps = EXCLUDED.game_revenue_bps,
         label = EXCLUDED.label, active = COALESCE($6, affiliate_terms.active), updated_at = now()`,
      [uid, cashbackBps, feeDiscountBps, gameRevenueBps, opts.label ?? null, active],
    );
    return uid;
  });
  const r = await db.query<AffiliateDbRow>(`${SELECT_AFFILIATES} WHERE t.user_id = $1`, [userId]);
  return toRow(r.rows[0]);
}
