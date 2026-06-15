import { config } from '../config.ts';
import { liveKnob } from './live-knob.ts';
import { getOrCreateSystemAccount, getBalance } from './ledger.ts';
import type { Db } from '../db/client.ts';

/**
 * Live-tunable DROP (timed giveaway) config, persisted in `settings` and overlaid on the config defaults —
 * same mechanism as the fee + chat-threshold knobs. Surfaced (and edited) in the admin CHAT view.
 *
 * Phase 1 only PERSISTS these knobs and reads the DROP_POOL pot balance; the round worker that consumes
 * the interval/floor/tiers + the on-chain GDEX eligibility check land in Phase 2 (docs/chat-social-spec.md).
 */

// The $GDEX SPL mint that grants DROP eligibility when held in qty >= the GDEX_MIN knob. A fixed
// chain constant (not operator-tunable) — shown read-only in the admin panel.
export const GDEX_MINT = '3FdoksSvontxzSg42mfBccFp8zmH4KdgbS8bsoMgpump';

const MAX_USD = 10_000_000; // fat-finger ceiling for USD knobs
const MAX_INTERVAL_MIN = 43_200; // 30 days — the longest sane cadence
const MAX_TIER_COUNT = 12;

/** Bounded positive-integer validator (1..max); throws on a bad one. */
function intValidator(label: string, min: number, max: number) {
  return (value: unknown): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw new Error(`${label} must be an integer >= ${min}`);
    if (n > max) throw new Error(`${label} must be <= ${max}`);
    return n;
  };
}

/**
 * Pack-tier validator: accepts a number[] or a comma-separated string and normalizes to a sorted, unique
 * list of positive-integer USD amounts. Stored via liveKnob's String() as "250,500,1000" and re-parsed by
 * this same validator on load, so the round trip is stable.
 */
function tiersValidator(value: unknown): number[] {
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const tiers = [...new Set(parts.map((p) => Number(String(p).trim())))].sort((a, b) => a - b);
  if (tiers.length === 0 || tiers.length > MAX_TIER_COUNT) throw new Error(`pack tiers must list 1..${MAX_TIER_COUNT} amounts`);
  for (const t of tiers) {
    if (!Number.isInteger(t) || t <= 0) throw new Error('pack tiers must be positive integers (USD)');
    if (t > MAX_USD) throw new Error(`pack tier must be <= ${MAX_USD}`);
  }
  return tiers;
}

const DEFAULT_PACK_TIERS = [250, 500, 1000];

const interval = liveKnob('drop_interval_min', config.dropIntervalMin, intValidator('drop interval (min)', 1, MAX_INTERVAL_MIN));
const houseFloor = liveKnob('drop_house_floor_usd', config.dropHouseFloorUsd, intValidator('house floor (USD)', 0, MAX_USD));
const packTiers = liveKnob<number[]>('drop_pack_tiers', DEFAULT_PACK_TIERS, tiersValidator);
const gdexMin = liveKnob('drop_gdex_min', config.dropGdexMin, intValidator('GDEX minimum', 0, Number.MAX_SAFE_INTEGER));

/** The current DROP config + defaults + the read-only eligibility mint — for the admin CHAT view. */
export interface DropConfigView {
  intervalMin: number;
  houseFloorUsd: number;
  packTiers: number[];
  gdexMin: number;
  gdexMint: string;
  defaults: { intervalMin: number; houseFloorUsd: number; packTiers: number[]; gdexMin: number };
}
export const dropConfigView = (): DropConfigView => ({
  intervalMin: interval.get(),
  houseFloorUsd: houseFloor.get(),
  packTiers: packTiers.get(),
  gdexMin: gdexMin.get(),
  gdexMint: GDEX_MINT,
  defaults: {
    intervalMin: interval.default,
    houseFloorUsd: houseFloor.default,
    packTiers: packTiers.default,
    gdexMin: gdexMin.default,
  },
});

/** Apply only the provided knobs (a partial update; blank fields in the panel are left unchanged). */
export async function setDropConfig(
  db: Db,
  patch: { intervalMin?: number; houseFloorUsd?: number; packTiers?: number[]; gdexMin?: number },
): Promise<DropConfigView> {
  if (patch.intervalMin !== undefined) await interval.set(db, patch.intervalMin);
  if (patch.houseFloorUsd !== undefined) await houseFloor.set(db, patch.houseFloorUsd);
  if (patch.packTiers !== undefined) await packTiers.set(db, patch.packTiers);
  if (patch.gdexMin !== undefined) await gdexMin.set(db, patch.gdexMin);
  return dropConfigView();
}

/** Load every DROP knob from settings (boot + periodic refresh, for multi-instance convergence). */
export async function loadDropConfig(db: Db): Promise<void> {
  await Promise.all([interval.load(db), houseFloor.load(db), packTiers.load(db), gdexMin.load(db)]);
}

/**
 * The DROP pot bucket + recent rounds for the admin panel. Phase 1: the pot is the DROP_POOL ledger
 * system-account balance (0 until Phase 2 funds it) and `recentRounds` is empty (the drop_rounds table +
 * round worker are Phase 2).
 */
export async function getDropView(db: Db): Promise<{ bucketE6: string; recentRounds: never[] }> {
  const acct = await getOrCreateSystemAccount(db, 'DROP_POOL');
  return { bucketE6: (await getBalance(db, acct)).toString(), recentRounds: [] };
}
