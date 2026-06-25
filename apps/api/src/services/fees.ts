import { config } from '../config.ts';
import { liveKnob } from './live-knob.ts';

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

/** One live-editable bps knob over the shared liveKnob mechanism (settings-backed, cached for sync reads).
 *  `validate` bounds it (fees vs funding have different ceilings). */
function liveBpsKnob(settingKey: string, defaultBps: number, validate: (v: unknown) => number) {
  const k = liveKnob(settingKey, defaultBps, validate);
  return { get: k.get, load: k.load, set: k.set, view: (): { bps: number; default: number } => ({ bps: k.get(), default: k.default }) };
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

/** Whole-percent (0–100) share validator — for splitting a fee/funding/penalty between the LP pool and the
 *  house revenue account. Throws on a bad one. */
function pctValidator(label: string) {
  return (value: unknown): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`${label} must be an integer 0–100`);
    return n;
  };
}

/** One live-editable whole-percent share knob (settings-backed, cached for sync reads on the hot path). */
function livePctKnob(settingKey: string, defaultPct: number, label: string) {
  const k = liveKnob(settingKey, defaultPct, pctValidator(label));
  return { get: k.get, load: k.load, set: k.set, view: (): { pct: number; default: number } => ({ pct: k.get(), default: k.default }) };
}

// LP revenue shares — the % of each source routed to the LP pool; the house FEE_REVENUE account keeps the
// rest. These drive the LIVE split mechanics (the engine reads them synchronously when settling each fee /
// funding / liquidation). The pool page shows a SEPARATELY-published snapshot (admin "Refresh pool
// numbers"), so tuning a share here never flickers the public page until the operator republishes.
const lpTradingShare = livePctKnob('lp_trading_fee_pct', config.feeLpSharePct, 'LP trading-fee share');
const lpFundingShare = livePctKnob('lp_funding_pct', config.lpFundingSharePct, 'LP funding share');
const lpLiquidationShare = livePctKnob('lp_liquidation_pct', config.lpLiquidationSharePct, 'LP liquidation share');

export const getLpTradingPct = lpTradingShare.get;
export const loadLpTradingPct = lpTradingShare.load;
export const setLpTradingPct = lpTradingShare.set;
export const lpTradingPctView = lpTradingShare.view;

export const getLpFundingPct = lpFundingShare.get;
export const loadLpFundingPct = lpFundingShare.load;
export const setLpFundingPct = lpFundingShare.set;
export const lpFundingPctView = lpFundingShare.view;

export const getLpLiquidationPct = lpLiquidationShare.get;
export const loadLpLiquidationPct = lpLiquidationShare.load;
export const setLpLiquidationPct = lpLiquidationShare.set;
export const lpLiquidationPctView = lpLiquidationShare.view;
