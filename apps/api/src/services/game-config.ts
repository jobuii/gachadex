import { liveKnob } from './live-knob.ts';
import { getOrCreateSystemAccount, getBalance } from './ledger.ts';
import type { Db } from '../db/client.ts';

/**
 * Live-tunable Games config, persisted in `settings` and overlaid on the defaults — the same mechanism
 * as the fee + DROP knobs (live-knob.ts). Surfaced + edited in the admin Games view. Phase 1 ships
 * Pack Rip; later games add their own block here.
 *
 * House edge is `price − E[card value]·(1 − buybackSpread)` — it depends on BOTH the buyback spread AND
 * how the live featured pool falls into each tier's value bands, so the bands DO encode the edge (a tier
 * whose common bands are empty against the live pool can be house-NEGATIVE). The buyback spread is one
 * lever (the Collector Crypt model, docs/games-spec.md); the bands are the other. `packRipEv` (games.ts)
 * computes the realised per-tier edge against the current pool — check it in the admin Games view before
 * enabling a tier. The config is stored as ONE JSON settings row (it nests a per-tier band table), so the
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
  buybackSpreadBps: number; // sell-back pays mark·(1 − bps/10000); one house-edge lever (see packRipEv)
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

/** Coerce + bound a weighted value-band table (shared by Pack Rip tiers and Set Poker's deal). */
function validateBands(bandsIn: unknown): PackBand[] {
  const arr = Array.isArray(bandsIn) ? bandsIn : [];
  if (arr.length < 1 || arr.length > 12) throw new Error('needs 1..12 value bands');
  const bands: PackBand[] = arr.map((b) => {
    const minUsd = num(b?.minUsd, 'band minUsd', 0, MAX_USD);
    const maxUsd = num(b?.maxUsd, 'band maxUsd', 0, MAX_USD);
    const weight = num(b?.weight, 'band weight', 0, 1_000_000_000);
    if (maxUsd < minUsd) throw new Error('band maxUsd must be >= minUsd');
    return { minUsd, maxUsd, weight };
  });
  if (bands.reduce((a, b) => a + b.weight, 0) <= 0) throw new Error('needs at least one positive band weight');
  return bands;
}

/** Coerce + bound an arbitrary stored/posted value into a valid PackRipConfig (throws on a bad shape). */
function validatePackRip(value: unknown): PackRipConfig {
  const v = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<PackRipConfig>;
  if (!v || typeof v !== 'object') throw new Error('pack-rip config must be an object');
  const tiersIn = Array.isArray(v.tiers) ? v.tiers : [];
  if (tiersIn.length < 1 || tiersIn.length > 12) throw new Error('pack-rip needs 1..12 tiers');
  const tiers: PackTier[] = tiersIn.map((t) => ({
    price: num(t?.price, 'tier price (USD)', 1, MAX_USD),
    bands: validateBands(t?.bands),
  }));
  return {
    enabled: Boolean(v.enabled),
    buybackSpreadBps: num(v.buybackSpreadBps, 'buyback spread (bps)', 0, 9000),
    maxPrizeUsd: num(v.maxPrizeUsd, 'max prize (USD)', 1, MAX_USD),
    bigWinUsd: num(v.bigWinUsd, 'big-win threshold (USD)', 0, MAX_USD),
    tiers,
  };
}

// --- Set Poker (docs/games-spec.md). Pay an ante to be dealt 5 cards (vs a face-up 5-card house hand),
// pay per swap to redraw cards, then settle: the SUM of your five cards' live oracle value must STRICTLY
// beat the house's to win — ties go to the house (a house-edge lever). On a win you claim your single
// highest card as a held prize, sellable for USDC at mark·(1 − spread). Both hands are dealt from the same
// value bands, so the deal is bounded; the realised edge (ante + swap fees vs win-rate × prize) is hard to
// derive analytically, so `setPokerEv` (games-setpoker.ts) reports a Monte-Carlo estimate in the admin view.
export interface SetPokerConfig {
  enabled: boolean;
  anteUsd: number; // pay to be dealt a hand (the base wager)
  swapFeeUsd: number; // pay to redraw one card
  maxSwaps: number; // cap on total swaps per hand
  buybackSpreadBps: number; // won card sells back at mark·(1 − bps/10000)
  maxPrizeUsd: number; // per-prize sell-back cap
  bigWinUsd: number; // a won card worth >= this fires a chat BIG WIN
  bands: PackBand[]; // the value bands every dealt/swapped card is drawn from
}

const DEFAULT_SET_POKER: SetPokerConfig = {
  enabled: false, // off by default — flip per the regulatory gating in docs/games-spec.md
  anteUsd: 25,
  swapFeeUsd: 5,
  maxSwaps: 5,
  buybackSpreadBps: 1200,
  maxPrizeUsd: 5000,
  bigWinUsd: 250,
  bands: [
    { minUsd: 0, maxUsd: 10, weight: 50 },
    { minUsd: 10, maxUsd: 30, weight: 35 },
    { minUsd: 30, maxUsd: 80, weight: 13 },
    { minUsd: 80, maxUsd: 250, weight: 2 },
  ],
};

/** Coerce + bound an arbitrary stored/posted value into a valid SetPokerConfig. */
function validateSetPoker(value: unknown): SetPokerConfig {
  const v = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<SetPokerConfig>;
  if (!v || typeof v !== 'object') throw new Error('set-poker config must be an object');
  return {
    enabled: Boolean(v.enabled),
    anteUsd: num(v.anteUsd, 'ante (USD)', 1, MAX_USD),
    swapFeeUsd: num(v.swapFeeUsd, 'swap fee (USD)', 0, MAX_USD),
    maxSwaps: num(v.maxSwaps, 'max swaps', 0, 25),
    buybackSpreadBps: num(v.buybackSpreadBps, 'buyback spread (bps)', 0, 9000),
    maxPrizeUsd: num(v.maxPrizeUsd, 'max prize (USD)', 1, MAX_USD),
    bigWinUsd: num(v.bigWinUsd, 'big-win threshold (USD)', 0, MAX_USD),
    bands: validateBands(v.bands),
  };
}

const packRip = liveKnob<PackRipConfig>('game_pack_rip', DEFAULT_PACK_RIP, validatePackRip, JSON.stringify);
const setPoker = liveKnob<SetPokerConfig>('game_set_poker', DEFAULT_SET_POKER, validateSetPoker, JSON.stringify);

/** Current Pack Rip config (sync read on the play hot path). */
export const packRipConfig = (): PackRipConfig => packRip.get();
/** Current Set Poker config (sync read on the play hot path). */
export const setPokerConfig = (): SetPokerConfig => setPoker.get();

/** Load every games knob from settings (boot + periodic refresh, for multi-instance convergence). */
export async function loadGameConfig(db: Db): Promise<void> {
  await Promise.all([packRip.load(db), setPoker.load(db)]);
}

/** The full config + defaults + the GAME_POOL bankroll balance — for the admin Games view. */
export async function gamesAdminView(db: Db): Promise<{
  packRip: PackRipConfig;
  setPoker: SetPokerConfig;
  defaults: { packRip: PackRipConfig; setPoker: SetPokerConfig };
  poolE6: string;
}> {
  const acct = await getOrCreateSystemAccount(db, 'GAME_POOL');
  return {
    packRip: packRip.get(),
    setPoker: setPoker.get(),
    defaults: { packRip: packRip.default, setPoker: setPoker.default },
    poolE6: (await getBalance(db, acct)).toString(),
  };
}

/** Apply a partial Pack Rip patch (blank fields in the panel are left unchanged), then re-load. */
export async function setPackRipConfig(db: Db, patch: Partial<PackRipConfig>): Promise<PackRipConfig> {
  const merged = { ...packRip.get(), ...patch };
  await packRip.set(db, merged);
  return packRip.get();
}

/** Apply a partial Set Poker patch, then re-load. */
export async function setSetPokerConfig(db: Db, patch: Partial<SetPokerConfig>): Promise<SetPokerConfig> {
  const merged = { ...setPoker.get(), ...patch };
  await setPoker.set(db, merged);
  return setPoker.get();
}
