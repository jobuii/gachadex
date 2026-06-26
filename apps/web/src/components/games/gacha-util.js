import { formatUsd } from '@pokex/pricing';
import * as api from '../../lib/api.js';

// Shared Classic Gacha view helpers — a single source so the rarity palette and money math don't drift
// across the reveal / summary / lobby components (changing e.g. the epic gold is now a one-line edit).

// red · green · violet · gold. Each component keeps its own tiny lookup wrapper (their fallbacks differ).
export const RARITY_COLORS = { common: '#ef4444', uncommon: '#22c55e', rare: '#a855f7', epic: '#ffc93c' };
// the four tiers in display order (common → epic), derived from the colour map so they can't drift.
export const RARITY_TIERS = Object.keys(RARITY_COLORS);

// micro-USD integer string → display string ('|| 0' guards '', null, undefined).
export const usd = (e6) => formatUsd(BigInt(e6 || 0));
// whole-dollar format, no cents (e.g. $4,475) — for compact lobby card values where the coin sits inline.
export const usdWhole = (e6) => `$${Math.round(Number(e6 || 0) / 1e6).toLocaleString('en-US')}`;

// micro-USD a player nets after a basis-point cut (floor) — e.g. a sell-back fee.
export const netAfterCutE6 = (valueE6, cutBps) => (BigInt(valueE6 || 0) * (10_000n - BigInt(cutBps))) / 10_000n;

// Poll a freshly-charged open until CC's reveal lands (≤12×2s). The POST already charged, so a mid-poll network
// error must NOT bubble — a re-click would mint a NEW idempotency key → a SECOND charge. Swallow it and keep the
// last-known 'paid' open; the reconciler + a later getGachaOpen finish it. Returns the most resolved result seen.
export async function pollGachaOpen(r) {
  try {
    for (let i = 0; i < 20 && r.status === 'paid'; i++) {
      await new Promise((res) => setTimeout(res, 1000)); // 1s polls (was 2s) → the reveal appears sooner once it lands
      r = await api.getGachaOpen(r.openId);
    }
  } catch { /* keep r at its last-known (paid) state */ }
  return r;
}
