import type { Db } from '../db/client.ts';
import { liveKnob } from './live-knob.ts';

/**
 * Live-tunable knobs for the bonus-credits program (docs/bonus-credits-spec.md). Two sources — a flat-$ signup
 * bonus and a %-of-first-deposit bonus — on ONE shared protection layer. Same settings-backed `liveKnob`
 * mechanism as the fee + chat thresholds.
 *
 * DARK by default: both `*_bonus_enabled` toggles are false AND both amounts default to 0, so nothing is issued
 * until an operator both enables a source and sets a non-zero figure (belt-and-braces).
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
  if (!Number.isInteger(n) || n <= 0 || n > 3650) throw new Error(`${label} must be a positive integer <= 3650`);
  return n;
};
const posCount = (label: string) => (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 1_000_000) throw new Error(`${label} must be a positive integer <= 1000000`);
  return n;
};
const pct = (label: string) => (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${label} must be a number 0..100`);
  return n;
};

// --- Shared protections (both sources inherit these) ---
const wagerDepositUsd = liveKnob('bonus_wager_deposit_usd', 50, nonNegUsd('bonus_wager_deposit_usd'));
const wagerVolumeUsd = liveKnob('bonus_wager_volume_usd', 1000, nonNegUsd('bonus_wager_volume_usd'));
const expiryDays = liveKnob('bonus_expiry_days', 7, posInt('bonus_expiry_days')); // dormancy window
const dailyAccountCap = liveKnob('bonus_daily_account_cap', 50, posCount('bonus_daily_account_cap')); // velocity threshold
const velocityTripped = liveKnob('bonus_velocity_tripped', false, bool); // internal edge-trigger latch (§4); NOT an operator control

// --- Signup source (flat $ at account creation) ---
const signupEnabled = liveKnob('signup_bonus_enabled', false, bool);
const signupUsd = liveKnob('signup_bonus_usd', 0, nonNegUsd('signup_bonus_usd')); // 0 ⇒ issues nothing even if enabled

// --- Deposit source (% of the first deposit, $-capped) ---
const depositEnabled = liveKnob('deposit_bonus_enabled', false, bool);
const depositPct = liveKnob('deposit_bonus_pct', 0, pct('deposit_bonus_pct')); // 0 ⇒ issues nothing even if enabled
const depositMaxUsd = liveKnob('deposit_bonus_max_usd', 0, nonNegUsd('deposit_bonus_max_usd')); // $ cap per grant; 0 ⇒ no bonus (must set a cap to issue)

export const bonusConfig = {
  wagerDepositUsd, wagerVolumeUsd, expiryDays, dailyAccountCap, velocityTripped,
  signupEnabled, signupUsd,
  depositEnabled, depositPct, depositMaxUsd,
};

/** Load all knobs from `settings` (call once on boot, like the other config modules). */
export async function loadBonusConfig(db: Db): Promise<void> {
  await Promise.all([
    wagerDepositUsd.load(db), wagerVolumeUsd.load(db), expiryDays.load(db), dailyAccountCap.load(db), velocityTripped.load(db),
    signupEnabled.load(db), signupUsd.load(db),
    depositEnabled.load(db), depositPct.load(db), depositMaxUsd.load(db),
  ]);
}

export interface BonusConfigView {
  wagerDepositUsd: number;
  wagerVolumeUsd: number;
  expiryDays: number;
  dailyAccountCap: number;
  velocityTripped: boolean;
  signupEnabled: boolean;
  signupUsd: number;
  depositEnabled: boolean;
  depositPct: number;
  depositMaxUsd: number;
}

export function bonusConfigView(): BonusConfigView {
  return {
    wagerDepositUsd: wagerDepositUsd.get(),
    wagerVolumeUsd: wagerVolumeUsd.get(),
    expiryDays: expiryDays.get(),
    dailyAccountCap: dailyAccountCap.get(),
    velocityTripped: velocityTripped.get(),
    signupEnabled: signupEnabled.get(),
    signupUsd: signupUsd.get(),
    depositEnabled: depositEnabled.get(),
    depositPct: depositPct.get(),
    depositMaxUsd: depositMaxUsd.get(),
  };
}

/**
 * Operator update (admin Perks page). Only provided fields change; each value is validated by its knob. The
 * enable toggles double as the velocity re-enable control (§4). `velocityTripped` is engine-managed and NOT
 * settable here.
 */
export async function setBonusConfig(db: Db, patch: Record<string, unknown>): Promise<BonusConfigView> {
  if (patch.wagerDepositUsd !== undefined) await wagerDepositUsd.set(db, patch.wagerDepositUsd);
  if (patch.wagerVolumeUsd !== undefined) await wagerVolumeUsd.set(db, patch.wagerVolumeUsd);
  if (patch.expiryDays !== undefined) await expiryDays.set(db, patch.expiryDays);
  if (patch.dailyAccountCap !== undefined) await dailyAccountCap.set(db, patch.dailyAccountCap);
  if (patch.signupEnabled !== undefined) await signupEnabled.set(db, patch.signupEnabled);
  if (patch.signupUsd !== undefined) await signupUsd.set(db, patch.signupUsd);
  if (patch.depositEnabled !== undefined) await depositEnabled.set(db, patch.depositEnabled);
  if (patch.depositPct !== undefined) await depositPct.set(db, patch.depositPct);
  if (patch.depositMaxUsd !== undefined) await depositMaxUsd.set(db, patch.depositMaxUsd);
  return bonusConfigView();
}
