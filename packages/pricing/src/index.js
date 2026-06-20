/**
 * @pokex/pricing — the single source of truth for money/price math.
 *
 * Imported by BOTH the web app (order previews) and the api engine (authoritative
 * settlement). They MUST agree: a user who is shown a liquidation price of $X must be
 * liquidated at $X. That is why this lives in one shared package.
 *
 * UNITS (all exact, no floats in the money path):
 *   - Prices / index values: micro-USD as BigInt, scale 1e6.  $535.22 -> 535_220_000n
 *   - Money (USDC balances, margin, pnl, fees): micro-USDC BigInt. 1 USDC = 1_000_000n
 *   - Quantity (synthetic units of the underlying card/index): qtyE6 BigInt, scale 1e6.
 *   - Rates/fractions: scaled 1e6 (0.05 -> 50_000n).  Bps: integer (2.5% -> 250).
 *
 * Rounding rule: integer division floors. Where a rounding direction matters for
 * solvency, callers round AGAINST the user (see engine). These helpers are exact
 * arithmetic; the engine owns the rounding policy at the boundaries.
 */

export const SCALE = 1_000_000n; // 1e6 fixed-point scale for prices, qty, money, rates
export const MIN_NOTIONAL_UUSDC = SCALE; // $1 — smallest order notional (dust floor; engine-enforced, client-previewed)

// ---------------------------------------------------------------------------
// Card price extraction (dedups the getPrice copy-pasted across the SPA)
// ---------------------------------------------------------------------------

// The single source of truth for TCGplayer variant preference (price fallback order).
const VARIANT_ORDER = ['holofoil', 'normal', '1stEditionHolofoil', 'reverseHolofoil', 'unlimitedHolofoil'];

/**
 * Extract a card's market price AND the variant it came from, from a pokemontcg.io card object.
 * One ordered walk so the picked variant and the price can never drift apart.
 * @param {any} card
 * @returns {{ variant: string | null, price: number }}
 */
export function getCardPriceVariant(card) {
  const p = card?.tcgplayer?.prices;
  if (p) {
    for (const variant of VARIANT_ORDER) {
      const price = p[variant]?.market;
      if (price) return { variant, price };
    }
  }
  return { variant: null, price: 0 };
}

/**
 * Extract a single card's market price (float USD) from a pokemontcg.io card object.
 * Falls back across the common TCGplayer variants. Returns 0 when unavailable.
 * @param {any} card
 * @returns {number}
 */
export function getCardPrice(card) {
  return getCardPriceVariant(card).price;
}

// ---------------------------------------------------------------------------
// Unit conversions
// ---------------------------------------------------------------------------

/** float USD -> micro (BigInt, scale 1e6), rounded to nearest. */
export function toE6(usd) {
  if (typeof usd === 'bigint') return usd;
  return BigInt(Math.round((Number(usd) || 0) * 1_000_000));
}

/** micro (BigInt) -> float USD. */
export function fromE6(micro) {
  return Number(micro) / 1_000_000;
}

/** Clamp a BigInt to [lo, hi]. */
export function clampBig(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// ---------------------------------------------------------------------------
// Perp math — all BigInt, all exact
// ---------------------------------------------------------------------------

/**
 * Notional value (micro-USDC) of a position.
 * notional = qty * price  (qtyE6/1e6 units) * (priceE6/1e6 USD) * 1e6 uusdc
 * @param {bigint} qtyE6
 * @param {bigint} priceE6
 * @returns {bigint} micro-USDC
 */
export function notional(qtyE6, priceE6) {
  return (qtyE6 * priceE6) / SCALE;
}

/**
 * Initial margin (micro-USDC) required to open `notional` at a given leverage.
 * @param {bigint} notionalUusdc
 * @param {number} leverageE2  leverage * 100 (20x -> 2000)
 * @returns {bigint}
 */
export function initialMargin(notionalUusdc, leverageE2) {
  return (notionalUusdc * 100n) / BigInt(leverageE2);
}

/**
 * Maintenance margin (micro-USDC).
 * @param {bigint} notionalUusdc
 * @param {number} maintMarginBps  (2.5% -> 250)
 * @returns {bigint}
 */
export function maintenanceMargin(notionalUusdc, maintMarginBps) {
  return (notionalUusdc * BigInt(maintMarginBps)) / 10_000n;
}

/**
 * Open/close fee (micro-USDC).
 * @param {bigint} notionalUusdc
 * @param {number} feeBps
 * @returns {bigint}
 */
export function fee(notionalUusdc, feeBps) {
  return (notionalUusdc * BigInt(feeBps)) / 10_000n;
}

/**
 * Unrealized PnL (micro-USDC) of a position marked to `markE6`.
 * @param {'long'|'short'} side
 * @param {bigint} qtyE6
 * @param {bigint} entryE6
 * @param {bigint} markE6
 * @returns {bigint} signed micro-USDC
 */
export function unrealizedPnl(side, qtyE6, entryE6, markE6) {
  const diff = side === 'long' ? markE6 - entryE6 : entryE6 - markE6;
  return (qtyE6 * diff) / SCALE;
}

/**
 * Liquidation price (micro-USD, BigInt) for an isolated-margin position.
 * Simplified (ignores accrued funding/fees, which the engine layers on):
 *   long  liq = entry * (1 - 1/lev + maintRate)
 *   short liq = entry * (1 + 1/lev - maintRate)
 * @param {{ side:'long'|'short', entryE6:bigint, leverageE2:number, maintMarginBps:number }} p
 * @returns {bigint} micro-USD
 */
export function liquidationPrice({ side, entryE6, leverageE2, maintMarginBps }) {
  const imrE6 = (SCALE * 100n) / BigInt(leverageE2); // initial margin rate, scale 1e6
  const mmrE6 = (SCALE * BigInt(maintMarginBps)) / 10_000n; // maint margin rate, scale 1e6
  const factorE6 =
    side === 'long' ? SCALE - imrE6 + mmrE6 : SCALE + imrE6 - mmrE6;
  const liq = (entryE6 * factorE6) / SCALE;
  return liq < 0n ? 0n : liq;
}

/**
 * Account equity (micro-USDC) for an isolated position.
 * equity = margin + uPnL - accruedFunding - accruedBorrowFee
 */
export function equity({ marginUusdc, uPnlUusdc, accruedFundingUusdc = 0n, accruedBorrowUusdc = 0n }) {
  return marginUusdc + uPnlUusdc - accruedFundingUusdc - accruedBorrowUusdc;
}

/**
 * Synthetic continuous mark price (Option 1):
 *   premium = clamp(k * skew/depth, ±premiumCap)
 *   mark    = clamp(index * (1 + premium), index*(1-maxDev), index*(1+maxDev))
 * All fractions scaled 1e6; kE6 is the skew->premium coefficient (scale 1e6).
 * @param {{ indexE6:bigint, skewUusdc:bigint, depthUusdc:bigint, kE6:bigint,
 *           premiumCapE6:bigint, maxDevBps:number }} p
 * @returns {{ markE6:bigint, premiumE6:bigint }}
 */
export function syntheticMark({ indexE6, skewUusdc, depthUusdc, kE6, premiumCapE6, maxDevBps }) {
  const depth = depthUusdc > 0n ? depthUusdc : 1n;
  const normSkewE6 = (skewUusdc * SCALE) / depth; // skew/depth as fraction, scale 1e6
  let premiumE6 = (kE6 * normSkewE6) / SCALE; // premium as fraction, scale 1e6
  premiumE6 = clampBig(premiumE6, -premiumCapE6, premiumCapE6);

  let mark = (indexE6 * (SCALE + premiumE6)) / SCALE;
  const lo = (indexE6 * (10_000n - BigInt(maxDevBps))) / 10_000n;
  const hi = (indexE6 * (10_000n + BigInt(maxDevBps))) / 10_000n;
  mark = clampBig(mark, lo, hi);
  return { markE6: mark, premiumE6 };
}

// ---------------------------------------------------------------------------
// Display helpers (UI only — never used in the money path)
// ---------------------------------------------------------------------------

/**
 * Format a USD amount for display. Accepts a float USD or a BigInt micro-USD.
 * @param {number|bigint} value
 * @param {{ decimals?:number, compact?:boolean }} [opts]
 */
export function formatUsd(value, opts = {}) {
  const n = typeof value === 'bigint' ? fromE6(value) : Number(value) || 0;
  const { decimals = 2, compact = false } = opts;
  if (compact && Math.abs(n) >= 1000) {
    return '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  }
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Format a signed percentage with a leading + / -. */
export function formatPct(pct, decimals = 2) {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(decimals)}%`;
}

/** Shorten a Solana pubkey (or any long id) for display: "ABCD…WXYZ". '' for empty. */
export function shortenPubkey(pk) {
  if (!pk) return '';
  return pk.length > 9 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

/**
 * Signed USD from a micro-USD bigint (or decimal string): "+$1.23" / "-$5.00".
 * The single home for the +/- abs(value) pattern used across PnL/amount displays.
 * @param {bigint|string|number} value micro-USD
 * @param {{ decimals?:number, compact?:boolean }} [opts]
 */
export function formatSignedUsd(value, opts = {}) {
  const v = typeof value === 'bigint' ? value : BigInt(value ?? 0);
  return (v >= 0n ? '+' : '-') + formatUsd(v < 0n ? -v : v, opts);
}
