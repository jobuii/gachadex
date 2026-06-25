import { formatUsd } from '@pokex/pricing';

// Shared Classic Gacha view helpers — a single source so the rarity palette and money math don't drift
// across the reveal / summary / lobby components (changing e.g. the epic gold is now a one-line edit).

// red · green · violet · gold. Each component keeps its own tiny lookup wrapper (their fallbacks differ).
export const RARITY_COLORS = { common: '#ef4444', uncommon: '#22c55e', rare: '#a855f7', epic: '#ffc93c' };
// the four tiers in display order (common → epic), derived from the colour map so they can't drift.
export const RARITY_TIERS = Object.keys(RARITY_COLORS);

// micro-USD integer string → display string ('|| 0' guards '', null, undefined).
export const usd = (e6) => formatUsd(BigInt(e6 || 0));

// micro-USD a player nets after a basis-point cut (floor) — e.g. a sell-back fee.
export const netAfterCutE6 = (valueE6, cutBps) => (BigInt(valueE6 || 0) * (10_000n - BigInt(cutBps))) / 10_000n;
