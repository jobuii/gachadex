import { config } from '../config.ts';
import type { Db } from '../db/client.ts';

/**
 * Live-editable trading-engine knobs (basis points; 1 bps = 0.01%). Three knobs share one mechanism:
 *   - trading fee: commission charged on BOTH open and close (getFeeBps).
 *   - liquidation penalty: taken from a liquidated position's notional into the insurance fund (getLiqFeeBps).
 *   - funding factor: the MAX hourly funding rate at full skew, scaled by the book's skew (getFundingFactorBps).
 * Each is settings-backed but held in memory for SYNCHRONOUS reads (the engine reads them on the hot path),
 * and loaded in EITHER mode — trading, liquidations and funding all happen in play money too. The config value
 * is the default; an operator override in `settings` overlays it. `current` starts at the default so reads are
 * valid pre-load.
 */
const MAX_FEE_BPS = 1000; // 10% ceiling — a fat-finger guard on a live money knob
const MAX_FUNDING_FACTOR_BPS = 100; // 1%/hour ceiling at full skew — guard on the funding knob

/** Bounded non-negative-integer bps validator. `max`/`label` differ per knob; throws on a bad one. */
function bpsValidator(max: number, label: string) {
  return (value: unknown): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer (bps)`);
    if (n > max) throw new Error(`${label} must be <= ${max} bps`);
    return n;
  };
}

/** Validate a fee bps value; throws on a bad one. Shared by every fee knob's admin write + DB-read backstop. */
export const validateFeeBps = bpsValidator(MAX_FEE_BPS, 'fee');
export const validateFundingFactorBps = bpsValidator(MAX_FUNDING_FACTOR_BPS, 'funding factor');

/** One live-editable bps knob: a settings key + a config default, cached in memory for synchronous reads.
 *  `validate` bounds it (fees vs funding have different ceilings). */
function liveBpsKnob(settingKey: string, defaultBps: number, validate: (v: unknown) => number) {
  let current = defaultBps;
  const load = async (db: Db): Promise<number> => {
    const r = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [settingKey]);
    // A stored value that somehow fails validation falls back to the default rather than poisoning the knob.
    try {
      current = r.rows[0] ? validate(r.rows[0].value) : defaultBps;
    } catch {
      current = defaultBps;
    }
    return current;
  };
  return {
    get: (): number => current,
    load,
    set: async (db: Db, bps: unknown): Promise<number> => {
      const v = validate(bps);
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

const tradingFee = liveBpsKnob('trading_fee_bps', config.feeBps, validateFeeBps);
const liqFee = liveBpsKnob('liq_fee_bps', config.liqFeeBps, validateFeeBps);
const fundingFactor = liveBpsKnob('funding_factor_bps', config.fundingSkewFactorBps, validateFundingFactorBps);

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

// Funding factor — the max hourly funding rate (bps) at full skew; accrueFunding scales it by skewRatio.
export const getFundingFactorBps = fundingFactor.get;
export const loadFundingFactor = fundingFactor.load;
export const setFundingFactor = fundingFactor.set;
export const fundingFactorView = fundingFactor.view;
