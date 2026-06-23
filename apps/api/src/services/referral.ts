import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { Db, Queryer } from '../db/client.ts';
import { creditCapped } from './faucet.ts';
import { usdc } from '../money.ts';

// Codes are short and human-shareable. The alphabet omits 0/O/1/I to avoid transcription errors.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;

function randomCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `POKE-${s}`;
}

/**
 * Assign a unique referral code to a user that doesn't have one yet. The UPDATE only fires when the
 * user has no code AND the candidate is free, so it's race-safe; on a collision we retry, and if the
 * user already had a code we return it. Called at signup and lazily for pre-feature accounts.
 */
export async function assignReferralCode(q: Queryer, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    let set;
    try {
      set = await q.query<{ referral_code: string }>(
        `UPDATE users SET referral_code=$1
         WHERE id=$2 AND referral_code IS NULL
           AND NOT EXISTS (SELECT 1 FROM users WHERE referral_code=$1)
           AND NOT EXISTS (SELECT 1 FROM referral_code_aliases WHERE code=$1)
         RETURNING referral_code`,
        [code, userId],
      );
    } catch (e) {
      // A concurrent signup can win the same candidate between our NOT EXISTS check and commit,
      // tripping uq_users_referral_code (the only unique index on this UPDATE) — just retry.
      if ((e as { code?: string })?.code === '23505') continue;
      throw e;
    }
    if (set.rows[0]) return set.rows[0].referral_code;
    // Either the user already had a code, or the candidate collided — if it's the former, return it.
    const cur = await q.query<{ referral_code: string | null }>(`SELECT referral_code FROM users WHERE id=$1`, [userId]);
    if (cur.rows[0]?.referral_code) return cur.rows[0].referral_code;
  }
  throw new HttpError(500, 'could not allocate a referral code');
}

/**
 * Change a user's own referral code to a custom one. Normalizes to uppercase, validates the format,
 * and enforces global uniqueness: the pre-check returns a clean error for the common case, and the
 * uq_users_referral_code unique index (a caught 23505) closes the race against a concurrent claim.
 *
 * Runs on the caller's queryer so it can join a larger transaction (e.g. affiliate setup, where the
 * code change must be atomic with upserting the user + terms). `setReferralCode` wraps this in its
 * own tx for standalone callers.
 */
export async function setReferralCodeTx(q: Queryer, userId: string, rawCode: string): Promise<{ code: string }> {
  const code = rawCode.trim().toUpperCase();
  if (code.length < 4 || code.length > 20 || !/^[A-Z0-9-]+$/.test(code) || code.startsWith('-') || code.endsWith('-')) {
    throw new HttpError(400, 'code must be 4-20 characters: letters, numbers and dashes (not starting or ending with a dash)');
  }
  if (code.startsWith('POKE-')) throw new HttpError(400, 'the POKE- prefix is reserved for auto-assigned codes');

  const cur = await q.query<{ referral_code: string | null }>(`SELECT referral_code FROM users WHERE id=$1`, [userId]);
  const current = cur.rows[0]?.referral_code ?? null;
  if (current === code) return { code }; // no-op

  // uniqueness spans live codes AND reserved (renamed-away) aliases, excluding this user's own
  const taken = await q.query(
    `SELECT 1 FROM users WHERE referral_code=$1 AND id<>$2
     UNION ALL SELECT 1 FROM referral_code_aliases WHERE code=$1 AND user_id<>$2`,
    [code, userId],
  );
  if (taken.rows[0]) throw new HttpError(409, 'that referral code is already taken');

  // reserve the prior code permanently so it can't be hijacked and old links still resolve here
  if (current) {
    await q.query(`INSERT INTO referral_code_aliases(code, user_id) VALUES($1,$2) ON CONFLICT(code) DO NOTHING`, [current, userId]);
  }
  try {
    await q.query(`UPDATE users SET referral_code=$1 WHERE id=$2`, [code, userId]);
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') throw new HttpError(409, 'that referral code is already taken');
    throw e;
  }
  // if the new code was previously this user's reserved alias, it's now their live code
  await q.query(`DELETE FROM referral_code_aliases WHERE code=$1 AND user_id=$2`, [code, userId]);
  return { code };
}

export async function setReferralCode(db: Db, userId: string, rawCode: string): Promise<{ code: string }> {
  return db.tx((q) => setReferralCodeTx(q, userId, rawCode));
}

export interface ReferralInfo {
  code: string;
  referralsCount: number; // how many users this account has referred
  redeemed: boolean; // has this account redeemed someone else's code
  referredByCode: string | null;
  bonusUsd: number;
  rewardsEnabled: boolean;
}

export async function getReferralInfo(db: Db, userId: string): Promise<ReferralInfo> {
  // one self-join gets the caller's code + who referred them + that referrer's code in a single row
  const [cnt, row] = await Promise.all([
    db.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE referred_by=$1`, [userId]),
    db.query<{ referral_code: string | null; referred_by: string | null; referred_by_code: string | null }>(
      `SELECT u.referral_code, u.referred_by, r.referral_code AS referred_by_code
       FROM users u LEFT JOIN users r ON r.id = u.referred_by WHERE u.id = $1`,
      [userId],
    ),
  ]);
  if (!row.rows[0]) throw new HttpError(404, 'user not found');
  const code = row.rows[0].referral_code ?? (await assignReferralCode(db, userId)); // lazy for pre-feature accounts
  return {
    code,
    referralsCount: Number(cnt.rows[0].n),
    redeemed: Boolean(row.rows[0].referred_by),
    referredByCode: row.rows[0].referred_by_code,
    bonusUsd: config.referralBonusUsd,
    rewardsEnabled: !config.realFunds && config.referralBonusUsd > 0,
  };
}

/**
 * Redeem a referral code: attribute this account to the referrer (once) and, in play-money mode,
 * credit both parties the configured bonus from FAUCET_SOURCE. The attribution UPDATE is guarded
 * by `referred_by IS NULL`, so two racing redemptions can't both win.
 */
export async function redeemReferral(db: Db, userId: string, rawCode: string): Promise<{ ok: true; bonusUsd: number; credited: boolean }> {
  const code = rawCode.trim().toUpperCase();
  // resolve to the owner via their live code OR a reserved alias (so old ?ref= links keep working)
  const ref = await db.query<{ user_id: string }>(
    `SELECT id AS user_id FROM users WHERE referral_code=$1
     UNION ALL SELECT user_id FROM referral_code_aliases WHERE code=$1
     LIMIT 1`,
    [code],
  );
  const referrerId = ref.rows[0]?.user_id;
  if (!referrerId) throw new HttpError(404, 'invalid referral code');
  if (referrerId === userId) throw new HttpError(400, 'you cannot redeem your own code');

  const bonus = usdc(config.referralBonusUsd);
  const credited = !config.realFunds && bonus > 0n;

  let creditedToRedeemer = 0n;

  await db.tx(async (q) => {
    // Serialize concurrent redemptions that share THIS referrer so the anti-farming cap below is
    // exact: without the lock, N redeemers could all read the same pre-count under READ COMMITTED
    // and each pay the referrer, busting maxReferralsPaid (TOCTOU). The referrer row always exists.
    await q.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [referrerId]);

    // Attribution is recorded once regardless of whether a bonus is paid (race-safe via IS NULL).
    const set = await q.query<{ id: string }>(
      `UPDATE users SET referred_by=$1, referred_at=now() WHERE id=$2 AND referred_by IS NULL RETURNING id`,
      [referrerId, userId],
    );
    if (set.rows.length === 0) throw new HttpError(400, 'you have already redeemed a referral code');

    if (!credited) return;

    // The referrer is only paid for their first N referrals (anti-farming); the redeemer is always
    // a candidate. creditCapped clamps each leg to the per-account play-money cap and skips at the cap.
    const priorReferrals = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE referred_by=$1 AND id<>$2`, [referrerId, userId]);
    const payReferrer = Number(priorReferrals.rows[0].n) < config.maxReferralsPaid;
    const beneficiaries = payReferrer ? [userId, referrerId] : [userId];

    for (const beneficiary of beneficiaries) {
      const { credited: legCredit } = await creditCapped(q, beneficiary, bonus, 'REFERRAL_BONUS', { refType: 'user', refId: beneficiary });
      if (beneficiary === userId) creditedToRedeemer = legCredit;
    }
  });

  return { ok: true, bonusUsd: config.referralBonusUsd, credited: creditedToRedeemer > 0n };
}
