import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';

/**
 * Operator-tunable custody limits. Defaults come from config (env); overrides live in the `settings`
 * table (key `custody_limit:<name>`) and are editable live from the admin panel — no redeploy.
 *
 * Held in memory for SYNCHRONOUS reads, because the call sites include non-DB-aware chain adapters
 * (solana.ts, jupiter.ts). `current` starts at the config defaults, so reads are always valid even
 * before loadLimits() runs. Loaded on boot, refreshed periodically (multi-instance convergence), and
 * updated immediately on an admin write. USD fields keep config's plain-number semantics (the call
 * sites convert with usdc()); swapSlippageBps is integer bps.
 */
export interface CustodyLimits {
  minDepositUsd: number;
  minSweepUsd: number;
  minWithdrawalUsd: number;
  withdrawalDailyCapUsd: number;
  hotWalletMaxUsd: number;
  hotWalletFloorPct: number; // % of the hot cap to leave in hot when draining to cold
  withdrawalAutoApproveMaxUsd: number;
  swapSlippageBps: number;
}

const DEFAULTS: CustodyLimits = {
  minDepositUsd: config.minDepositUsd,
  minSweepUsd: config.minSweepUsd,
  minWithdrawalUsd: config.minWithdrawalUsd,
  withdrawalDailyCapUsd: config.withdrawalDailyCapUsd,
  hotWalletMaxUsd: config.hotWalletMaxUsd,
  hotWalletFloorPct: config.hotWalletFloorPct,
  withdrawalAutoApproveMaxUsd: config.withdrawalAutoApproveMaxUsd,
  swapSlippageBps: config.swapSlippageBps,
};

export const LIMIT_KEYS = Object.keys(DEFAULTS) as (keyof CustodyLimits)[];
const PREFIX = 'custody_limit:';

let current: CustodyLimits = { ...DEFAULTS };

/** The effective limits right now (synchronous; safe before loadLimits). */
export function getLimits(): CustodyLimits {
  return current;
}

/** Validate one limit; throws on a bad value. Shared by the admin write + the DB-read backstop.
 *  Bounds mirror CustodyLimitsRequest in @pokex/shared-types (the API-boundary check) — keep in sync. */
export function validateLimit(key: keyof CustodyLimits, value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  if (key === 'swapSlippageBps') {
    if (!Number.isInteger(n) || n > 1000) throw new Error('swapSlippageBps must be an integer 0-1000 (<= 10%)');
  } else if (key === 'hotWalletFloorPct') {
    if (!Number.isInteger(n) || n > 100) throw new Error('hotWalletFloorPct must be an integer 0-100 (% of the hot cap)');
  } else if (n > 1_000_000_000) {
    throw new Error(`${key} is implausibly large`);
  }
  return n;
}

/** Read overrides from the DB and overlay them on the defaults; updates `current`. */
export async function loadLimits(db: Db): Promise<CustodyLimits> {
  const rows = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [LIMIT_KEYS.map((k) => PREFIX + k)],
  );
  const next: CustodyLimits = { ...DEFAULTS };
  for (const r of rows.rows) {
    const key = r.key.slice(PREFIX.length) as keyof CustodyLimits;
    if (!(key in DEFAULTS)) continue;
    // Defensive: a stored value that somehow fails validation falls back to the default rather
    // than poisoning a live money limit.
    try {
      next[key] = validateLimit(key, r.value);
    } catch {
      /* keep the default for this key */
    }
  }
  current = next;
  return current;
}

/** Validate + persist a partial set of overrides, then refresh `current`. */
export async function setLimits(db: Db, partial: Partial<Record<keyof CustodyLimits, unknown>>): Promise<CustodyLimits> {
  const updates: Array<[keyof CustodyLimits, number]> = [];
  for (const key of LIMIT_KEYS) {
    const v = partial[key];
    if (v === undefined || v === null || v === '') continue;
    updates.push([key, validateLimit(key, v)]);
  }
  if (updates.length === 0) throw new Error('no custody limits provided');
  for (const [key, value] of updates) {
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [PREFIX + key, String(value)],
    );
  }
  return loadLimits(db);
}

/** Admin view: the effective values plus the config defaults (so the panel can show both). */
export function limitsView(): { current: CustodyLimits; defaults: CustodyLimits } {
  return { current, defaults: { ...DEFAULTS } };
}
