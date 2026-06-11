import { config } from '../config.ts';
import type { Db } from '../db/client.ts';

/**
 * Live-editable trading-engine fees (basis points; 1 bps = 0.01%). Two knobs share one mechanism:
 *   - trading fee: commission charged on BOTH open and close (getFeeBps).
 *   - liquidation penalty: taken from a liquidated position's notional into the insurance fund (getLiqFeeBps).
 * Each is settings-backed but held in memory for SYNCHRONOUS reads (the engine reads them on the hot path),
 * and loaded in EITHER mode — trading and liquidations both happen in play money too. The config value is the
 * default; an operator override in `settings` overlays it. `current` starts at the default so reads are valid
 * pre-load.
 */
const MAX_FEE_BPS = 1000; // 10% ceiling — a fat-finger guard on a live money knob

/** Validate a bps value; throws on a bad one. Shared by every knob's admin write + DB-read backstop. */
export function validateFeeBps(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error('fee must be a non-negative integer (bps)');
  if (n > MAX_FEE_BPS) throw new Error(`fee must be <= ${MAX_FEE_BPS} bps (10%)`);
  return n;
}

/** One live-editable bps knob: a settings key + a config default, cached in memory for synchronous reads. */
function liveFeeKnob(settingKey: string, defaultBps: number) {
  let current = defaultBps;
  const load = async (db: Db): Promise<number> => {
    const r = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [settingKey]);
    // A stored value that somehow fails validation falls back to the default rather than poisoning fees.
    try {
      current = r.rows[0] ? validateFeeBps(r.rows[0].value) : defaultBps;
    } catch {
      current = defaultBps;
    }
    return current;
  };
  return {
    get: (): number => current,
    load,
    set: async (db: Db, bps: unknown): Promise<number> => {
      const v = validateFeeBps(bps);
      await db.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [settingKey, String(v)],
      );
      return load(db);
    },
    view: (): { bps: number; default: number } => ({ bps: current, default: defaultBps }),
  };
}

const tradingFee = liveFeeKnob('trading_fee_bps', config.feeBps);
const liqFee = liveFeeKnob('liq_fee_bps', config.liqFeeBps);

// Trading fee — charged on BOTH open and close (bps of notional). The engine reads getFeeBps() on the hot path.
export const getFeeBps = tradingFee.get;
export const loadFee = tradingFee.load;
export const setFee = tradingFee.set;
export const feeView = tradingFee.view;

// Liquidation penalty — taken from a liquidated position's notional (bps) into the insurance fund.
export const getLiqFeeBps = liqFee.get;
export const loadLiqFee = liqFee.load;
export const setLiqFee = liqFee.set;
export const liqFeeView = liqFee.view;
