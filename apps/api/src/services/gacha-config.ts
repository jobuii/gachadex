import { liveKnob } from './live-knob.ts';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';

/**
 * Live-tunable Classic Gacha loyalty knob (docs/classic-gacha-cc-packs-spec.md §6b). Same settings-backed
 * mechanism as the fee / chat / drop knobs: the config value is the default; an operator override in `settings`
 * overlays it and is read synchronously on the open hot path. Surfaced (and edited) in the admin panel.
 *
 * `gacha_free_pack_threshold_usd` = the USD of pack spend that earns one free $25 pack. The per-open earn rate
 * derives from it ($1000 → 25 Tokens/$1 ≈ 2.5% rebate; $500 = more generous, $2000 = less).
 */
const MAX_USD = 1_000_000; // fat-finger ceiling

function usdValidator(label: string) {
  return (v: unknown): number => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > MAX_USD) throw new HttpError(400, `${label} must be 1–${MAX_USD} USD`);
    return n;
  };
}

const freePackThresholdUsd = liveKnob('gacha_free_pack_threshold_usd', config.gachaFreePackThresholdUsd, usdValidator('free-pack threshold'));

export const gachaConfig = { freePackThresholdUsd };

/** Load the gacha knob from `settings` into its in-memory cache at boot (mirrors loadChatConfig/loadDropConfig). */
export async function loadGachaConfig(db: Db): Promise<void> {
  await freePackThresholdUsd.load(db);
}

/** Admin set of the free-pack threshold (whole USD). Returns the re-loaded value. */
export async function setFreePackThresholdUsd(db: Db, value: unknown): Promise<number> {
  return freePackThresholdUsd.set(db, value);
}
