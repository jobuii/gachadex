import { liveKnob } from './live-knob.ts';
import { getOrCreateSystemAccount, getBalance } from './ledger.ts';
import type { Db } from '../db/client.ts';

/**
 * Live-tunable Games config, persisted in `settings` and overlaid on the defaults — the same mechanism
 * as the fee + DROP knobs (live-knob.ts). Surfaced + edited in the admin Games view. Phase 1 ships
 * Pack Rip; later games add their own block here.
 *
 * House edge is the BUYBACK SPREAD (a won card sells back at mark·(1 − spread)), matching the
 * Collector Crypt model in docs/games-spec.md — the band weights are tuned for feel, NOT to encode the
 * edge. The Pack Rip config is stored as ONE JSON settings row (it nests a per-tier band table), so the
 * knob serializes with JSON.stringify and the validator JSON.parses + normalizes on load.
 */

// A value band: cards whose live oracle mark falls in [minUsd, maxUsd] are eligible; `weight` is its
// relative draw chance within the tier (weights are relative — they need not sum to anything).
export interface PackBand {
  minUsd: number;
  maxUsd: number;
  weight: number;
}
// A pack tier: its price (whole USD, also the wager) and the weighted bands it can reveal.
export interface PackTier {
  price: number;
  bands: PackBand[];
}
export interface PackRipConfig {
  enabled: boolean;
  buybackSpreadBps: number; // sell-back pays mark·(1 − bps/10000); the house edge
  maxPrizeUsd: number; // per-prize sell-back cap (tail-risk bound, like an OI cap)
  bigWinUsd: number; // a pull worth >= this fires a chat BIG WIN + headlines the live feed
  tiers: PackTier[];
}

const MAX_USD = 10_000_000;

const DEFAULT_PACK_RIP: PackRipConfig = {
  enabled: false, // off by default — flip per docs/games-spec.md regulatory gating
  buybackSpreadBps: 1200, // 12% spread (Collector Crypt's 10–15% range)
  maxPrizeUsd: 5000,
  bigWinUsd: 250,
  tiers: [
    { price: 5, bands: [
      { minUsd: 0, maxUsd: 5, weight: 70 },
      { minUsd: 5, maxUsd: 15, weight: 25 },
      { minUsd: 15, maxUsd: 50, weight: 5 },
    ] },
    { price: 25, bands: [
      { minUsd: 0, maxUsd: 15, weight: 55 },
      { minUsd: 15, maxUsd: 50, weight: 32 },
      { minUsd: 50, maxUsd: 150, weight: 11 },
      { minUsd: 150, maxUsd: 500, weight: 2 },
    ] },
    { price: 100, bands: [
      { minUsd: 0, maxUsd: 50, weight: 50 },
      { minUsd: 50, maxUsd: 150, weight: 33 },
      { minUsd: 150, maxUsd: 500, weight: 14 },
      { minUsd: 500, maxUsd: 5000, weight: 3 },
    ] },
  ],
};

const num = (v: unknown, label: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be a number in [${min}, ${max}]`);
  return Math.floor(n);
};

/** Coerce + bound an arbitrary stored/posted value into a valid PackRipConfig (throws on a bad shape). */
function validatePackRip(value: unknown): PackRipConfig {
  const v = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<PackRipConfig>;
  if (!v || typeof v !== 'object') throw new Error('pack-rip config must be an object');
  const tiersIn = Array.isArray(v.tiers) ? v.tiers : [];
  if (tiersIn.length < 1 || tiersIn.length > 12) throw new Error('pack-rip needs 1..12 tiers');
  const tiers: PackTier[] = tiersIn.map((t) => {
    const price = num(t?.price, 'tier price (USD)', 1, MAX_USD);
    const bandsIn = Array.isArray(t?.bands) ? t.bands : [];
    if (bandsIn.length < 1 || bandsIn.length > 12) throw new Error('each tier needs 1..12 bands');
    const bands: PackBand[] = bandsIn.map((b) => {
      const minUsd = num(b?.minUsd, 'band minUsd', 0, MAX_USD);
      const maxUsd = num(b?.maxUsd, 'band maxUsd', 0, MAX_USD);
      const weight = num(b?.weight, 'band weight', 0, 1_000_000_000);
      if (maxUsd < minUsd) throw new Error('band maxUsd must be >= minUsd');
      return { minUsd, maxUsd, weight };
    });
    if (bands.reduce((a, b) => a + b.weight, 0) <= 0) throw new Error('a tier needs at least one positive band weight');
    return { price, bands };
  });
  return {
    enabled: Boolean(v.enabled),
    buybackSpreadBps: num(v.buybackSpreadBps, 'buyback spread (bps)', 0, 9000),
    maxPrizeUsd: num(v.maxPrizeUsd, 'max prize (USD)', 1, MAX_USD),
    bigWinUsd: num(v.bigWinUsd, 'big-win threshold (USD)', 0, MAX_USD),
    tiers,
  };
}

const packRip = liveKnob<PackRipConfig>('game_pack_rip', DEFAULT_PACK_RIP, validatePackRip, JSON.stringify);

/** Current Pack Rip config (sync read on the play hot path). */
export const packRipConfig = (): PackRipConfig => packRip.get();

/** Load every games knob from settings (boot + periodic refresh, for multi-instance convergence). */
export async function loadGameConfig(db: Db): Promise<void> {
  await Promise.all([packRip.load(db)]);
}

/** The full config + defaults + the GAME_POOL bankroll balance — for the admin Games view. */
export async function gamesAdminView(db: Db): Promise<{
  packRip: PackRipConfig;
  defaults: { packRip: PackRipConfig };
  poolE6: string;
}> {
  const acct = await getOrCreateSystemAccount(db, 'GAME_POOL');
  return {
    packRip: packRip.get(),
    defaults: { packRip: packRip.default },
    poolE6: (await getBalance(db, acct)).toString(),
  };
}

/** Apply a partial Pack Rip patch (blank fields in the panel are left unchanged), then re-load. */
export async function setPackRipConfig(db: Db, patch: Partial<PackRipConfig>): Promise<PackRipConfig> {
  const merged = { ...packRip.get(), ...patch };
  await packRip.set(db, merged);
  return packRip.get();
}
