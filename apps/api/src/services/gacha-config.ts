import { liveKnob } from './live-knob.ts';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';

/**
 * Live-tunable Classic Gacha knobs (docs/classic-gacha-cc-packs-spec.md §6/§6b/§12). Same settings-backed
 * mechanism as the fee / chat / drop knobs: the config value is the default; an operator override in `settings`
 * overlays it and is read synchronously on the open hot path. Surfaced (and edited) in the admin Gacha tab.
 *
 * - `gacha_free_pack_threshold_usd` — USD of pack spend that earns one free $25 pack (loyalty earn rate derives).
 * - `gacha_buyback_cut_bps` / `gacha_turbo_cut_bps` — GDEX's cut of a sell-back (5% manual / 10% instant).
 * - `gacha_markup_bps` — optional purchase markup over the CC price → FEE_REVENUE (default 0; the §6 "turn on if
 *   sell-back drops" lever).
 * - `gacha_disabled_machines` — operator-disabled machine codes (hidden from the lobby), on top of the always-off set.
 */
const MAX_USD = 1_000_000; // fat-finger ceiling
const MAX_CUT_BPS = 5_000; // 50% ceiling on any cut/markup
const MACHINE_CODE_RE = /^[a-z0-9_]{1,32}$/; // mirrors the route's machine-code guard

function usdValidator(label: string) {
  return (v: unknown): number => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > MAX_USD) throw new HttpError(400, `${label} must be 1–${MAX_USD} USD`);
    return n;
  };
}
function bpsValidator(label: string) {
  return (v: unknown): number => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > MAX_CUT_BPS) throw new HttpError(400, `${label} must be 0–${MAX_CUT_BPS} bps`);
    return n;
  };
}
function machineListValidator(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(',');
  const codes = arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  for (const c of codes) if (!MACHINE_CODE_RE.test(c)) throw new HttpError(400, `bad machine code: ${c}`);
  return [...new Set(codes)];
}

const bool = (v: unknown): boolean => v === true || v === 'true';
const freePackThresholdUsd = liveKnob('gacha_free_pack_threshold_usd', config.gachaFreePackThresholdUsd, usdValidator('free-pack threshold'));
const buybackCutBps = liveKnob('gacha_buyback_cut_bps', config.gachaBuybackCutBps, bpsValidator('buyback cut'));
const turboCutBps = liveKnob('gacha_turbo_cut_bps', config.gachaTurboCutBps, bpsValidator('turbo cut'));
const markupBps = liveKnob('gacha_markup_bps', config.gachaMarkupBps, bpsValidator('markup'));
const disabledMachines = liveKnob<string[]>('gacha_disabled_machines', [], machineListValidator, (a) => a.join(','));
// Loyalty Gold master switch — OFF hides Gold in the UI but earn keeps accruing silently (env GOLD_ENABLED is the
// default; the admin toggle overrides). payWithGold gates the "pay with Gold" option on machine purchases (default
// OFF) — when off, customers still earn/see Gold and can claim a free pack, just can't spend Gold on any machine.
const goldEnabled = liveKnob('gacha_gold_enabled', config.goldEnabled, bool);
const payWithGoldEnabled = liveKnob('gacha_pay_with_gold', false, bool);

export const gachaConfig = { freePackThresholdUsd, buybackCutBps, turboCutBps, markupBps, disabledMachines, goldEnabled, payWithGoldEnabled };

/** The GDEX markup amount (micro-USDC, floor) over a base CC price — one formula for the charge + the displayed
 *  price so they can never drift (a mismatch would trip the open's expected-price drift guard). */
export const gachaMarkupE6 = (priceE6: bigint | string, markupBps: number): bigint => (BigInt(priceE6) * BigInt(markupBps)) / 10_000n;

/** Load every gacha knob from `settings` into its in-memory cache at boot (mirrors loadChatConfig/loadDropConfig). */
export async function loadGachaConfig(db: Db): Promise<void> {
  await Promise.all([
    freePackThresholdUsd.load(db), buybackCutBps.load(db), turboCutBps.load(db), markupBps.load(db), disabledMachines.load(db),
    goldEnabled.load(db), payWithGoldEnabled.load(db),
  ]);
}

/** Current knob values (for the admin readout). */
export function gachaAdminConfig() {
  return {
    freePackThresholdUsd: freePackThresholdUsd.get(),
    buybackCutBps: buybackCutBps.get(),
    turboCutBps: turboCutBps.get(),
    markupBps: markupBps.get(),
    disabledMachines: disabledMachines.get(),
    goldEnabled: goldEnabled.get(),
    payWithGoldEnabled: payWithGoldEnabled.get(),
  };
}

/** Admin set of any subset of the gacha knobs (each validated by its own knob). Returns the new snapshot. */
export async function setGachaConfig(db: Db, patch: Record<string, unknown>): Promise<ReturnType<typeof gachaAdminConfig>> {
  const p = patch ?? {};
  if (p.freePackThresholdUsd !== undefined) await freePackThresholdUsd.set(db, p.freePackThresholdUsd);
  if (p.buybackCutBps !== undefined) await buybackCutBps.set(db, p.buybackCutBps);
  if (p.turboCutBps !== undefined) await turboCutBps.set(db, p.turboCutBps);
  if (p.markupBps !== undefined) await markupBps.set(db, p.markupBps);
  if (p.disabledMachines !== undefined) await disabledMachines.set(db, p.disabledMachines);
  if (p.goldEnabled !== undefined) await goldEnabled.set(db, p.goldEnabled);
  if (p.payWithGoldEnabled !== undefined) await payWithGoldEnabled.set(db, p.payWithGoldEnabled);
  return gachaAdminConfig();
}

/** Admin set of the free-pack threshold (whole USD). Kept for the existing P4 admin call. */
export async function setFreePackThresholdUsd(db: Db, value: unknown): Promise<number> {
  return freePackThresholdUsd.set(db, value);
}
