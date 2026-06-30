import type { Db } from '../db/client.ts';
import { liveKnob } from './live-knob.ts';

/**
 * Live-tunable knobs for the free signup-credit program (docs/signup-credit-spec.md). Same settings-backed
 * `liveKnob` mechanism as the fee + chat thresholds. v1 enforces exactly these five; the spec's other knobs
 * (max-cashout cap, bonus-active leverage/position caps, velocity alarm) belong to later phases and are added
 * when those features ship — no dead knobs here.
 *
 * DARK by default: `signup_credit_enabled` is false, so nothing is granted until an operator flips it on.
 */
const MAX_USD = 1_000_000; // fat-finger ceiling for the live USD knobs (matches gacha-config's bound)
const bool = (v: unknown): boolean => v === true || v === 'true';
const nonNegUsd = (label: string) => (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_USD) throw new Error(`${label} must be a number 0..${MAX_USD}`);
  return Math.floor(n);
};
const posInt = (label: string) => (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 3650) throw new Error(`${label} must be a positive integer <= 3650`); // <= ~10y
  return n;
};

const enabled = liveKnob('signup_credit_enabled', false, bool);                                   // master switch (dark by default)
const grantUsd = liveKnob('signup_credit_usd', 25, nonNegUsd('signup_credit_usd'));               // grant amount per user (whole USD)
const wagerDepositUsd = liveKnob('signup_credit_wager_deposit_usd', 50, nonNegUsd('signup_credit_wager_deposit_usd'));
const wagerVolumeUsd = liveKnob('signup_credit_wager_volume_usd', 1000, nonNegUsd('signup_credit_wager_volume_usd'));
const expiryDays = liveKnob('signup_credit_expiry_days', 7, posInt('signup_credit_expiry_days')); // HARD expiry from grant

export const signupCreditConfig = { enabled, grantUsd, wagerDepositUsd, wagerVolumeUsd, expiryDays };

/** Load all knobs from `settings` (call once on boot, like the other config modules). */
export async function loadSignupCreditConfig(db: Db): Promise<void> {
  await Promise.all([enabled.load(db), grantUsd.load(db), wagerDepositUsd.load(db), wagerVolumeUsd.load(db), expiryDays.load(db)]);
}

export interface SignupCreditConfigView {
  enabled: boolean;
  grantUsd: number;
  wagerDepositUsd: number;
  wagerVolumeUsd: number;
  expiryDays: number;
}

export function signupCreditConfigView(): SignupCreditConfigView {
  return {
    enabled: enabled.get(),
    grantUsd: grantUsd.get(),
    wagerDepositUsd: wagerDepositUsd.get(),
    wagerVolumeUsd: wagerVolumeUsd.get(),
    expiryDays: expiryDays.get(),
  };
}

/** Operator update (admin Perks page). Only provided fields change; each value is validated by its knob. */
export async function setSignupCreditConfig(db: Db, patch: Record<string, unknown>): Promise<SignupCreditConfigView> {
  if (patch.enabled !== undefined) await enabled.set(db, patch.enabled);
  if (patch.grantUsd !== undefined) await grantUsd.set(db, patch.grantUsd);
  if (patch.wagerDepositUsd !== undefined) await wagerDepositUsd.set(db, patch.wagerDepositUsd);
  if (patch.wagerVolumeUsd !== undefined) await wagerVolumeUsd.set(db, patch.wagerVolumeUsd);
  if (patch.expiryDays !== undefined) await expiryDays.set(db, patch.expiryDays);
  return signupCreditConfigView();
}
