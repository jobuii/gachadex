import { config } from '../config.ts';
import { liveKnob } from './live-knob.ts';
import type { Db } from '../db/client.ts';

/**
 * Live-tunable chat action-bar thresholds, in whole USD. Same mechanism as the fee knobs (settings-backed
 * + cached for SYNCHRONOUS reads — the engine checks them on the trade hot path). The config value is the
 * default; an operator override in `settings` overlays it. Exposed as admin knobs in the CHAT admin view.
 */
const MAX_THRESHOLD_USD = 10_000_000; // sanity ceiling — a fat-finger guard on a live knob

/** Bounded non-negative-integer USD validator; throws on a bad one. */
function usdValidator(label: string) {
  return (value: unknown): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer (USD)`);
    if (n > MAX_THRESHOLD_USD) throw new Error(`${label} must be <= ${MAX_THRESHOLD_USD}`);
    return n;
  };
}

const bigBet = liveKnob('chat_big_bet_usd', config.chatBigBetUsd, usdValidator('big-bet threshold'));
const bigWin = liveKnob('chat_big_win_usd', config.chatBigWinUsd, usdValidator('big-win threshold'));

// BIG BET threshold — an open's notional at/above this (USD) broadcasts a gold action bar.
export const getBigBetUsd = bigBet.get;
export const setBigBetUsd = bigBet.set;

// BIG WIN threshold — a close's realized profit at/above this (USD) broadcasts a green action bar.
export const getBigWinUsd = bigWin.get;
export const setBigWinUsd = bigWin.set;

/** Both thresholds + their defaults — for the admin CHAT view. */
export const chatConfigView = (): { bigBetUsd: number; bigWinUsd: number; bigBetDefault: number; bigWinDefault: number } => ({
  bigBetUsd: bigBet.get(),
  bigWinUsd: bigWin.get(),
  bigBetDefault: bigBet.default,
  bigWinDefault: bigWin.default,
});

/** Apply a partial threshold update (only the provided keys change) and return the new view — mirrors
 *  drop-config's setDropConfig so the admin routes are symmetric. */
export async function setChatThresholds(db: Db, patch: { bigBetUsd?: number; bigWinUsd?: number }) {
  if (patch.bigBetUsd !== undefined) await setBigBetUsd(db, patch.bigBetUsd);
  if (patch.bigWinUsd !== undefined) await setBigWinUsd(db, patch.bigWinUsd);
  return chatConfigView();
}

/** Load both thresholds from settings (boot + periodic refresh, for multi-instance convergence). */
export async function loadChatConfig(db: Db): Promise<void> {
  await Promise.all([bigBet.load(db), bigWin.load(db)]);
}
