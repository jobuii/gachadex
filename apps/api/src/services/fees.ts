import { config } from '../config.ts';
import type { Db } from '../db/client.ts';

/**
 * Live-editable trading fee (basis points of notional; 1 bps = 0.01%), charged on BOTH open and
 * close. Mirrors the custody-limits pattern (settings-backed, in-memory for SYNCHRONOUS reads since
 * the engine reads it on the hot path), but loaded in EITHER mode — trading, and therefore fees,
 * happen in play money too. The config value is the default; an operator override in `settings`
 * (key `trading_fee_bps`) overlays it. `current` starts at the default so reads are valid pre-load.
 */
const SETTING_KEY = 'trading_fee_bps';
const MAX_FEE_BPS = 1000; // 10% ceiling — a fat-finger guard on a live money knob

let current = config.feeBps;

/** The effective trading fee in bps right now (synchronous; safe before loadFee). */
export function getFeeBps(): number {
  return current;
}

/** Validate a fee value; throws on a bad one. Shared by the admin write + the DB-read backstop. */
export function validateFeeBps(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error('fee must be a non-negative integer (bps)');
  if (n > MAX_FEE_BPS) throw new Error(`fee must be <= ${MAX_FEE_BPS} bps (10%)`);
  return n;
}

/** Read the override from the DB and overlay it on the default; updates `current`. */
export async function loadFee(db: Db): Promise<number> {
  const r = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [SETTING_KEY]);
  // A stored value that somehow fails validation falls back to the default rather than poisoning fees.
  try {
    current = r.rows[0] ? validateFeeBps(r.rows[0].value) : config.feeBps;
  } catch {
    current = config.feeBps;
  }
  return current;
}

/** Validate + persist the fee override, then refresh `current`. */
export async function setFee(db: Db, bps: unknown): Promise<number> {
  const v = validateFeeBps(bps);
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SETTING_KEY, String(v)],
  );
  return loadFee(db);
}

/** Admin view: the effective fee plus the config default (so the panel can show both). */
export function feeView(): { bps: number; default: number } {
  return { bps: current, default: config.feeBps };
}
