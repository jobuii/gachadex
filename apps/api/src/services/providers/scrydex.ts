import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { ProviderLimiter, sleep, type ProviderPriority } from './limiter.ts';

/**
 * Scrydex provider (Growth plan; spec docs/scrydex-pricing-build-spec.md). Primary RAW price source
 * under ORACLE_PRIMARY=scrydex. Two layers live here: the HTTP client (auth via X-Api-Key + X-Team-ID,
 * paced by the global ProviderLimiter, retries 429/5xx with backoff) and the PARSE of Scrydex's
 * variants[]→prices[] shape into a TCGplayer raw quote, matched to OUR market by the TCGplayer
 * product_id. The price/confidence COMBINE (Scrydex price + tcgpl eBay cross-check) lives in the oracle
 * (P2 combinePrice); this module is the Scrydex data layer only — it does not decide the final mark.
 */

// --- API shapes (fields we read now, or match/filter on in later phases) ---
export interface ScrydexTrend {
  price_change?: number;
  percent_change?: number;
}
export interface ScrydexPrice {
  type?: string; // 'raw' | 'graded'
  condition?: string; // raw: 'NM' | 'LP' | 'MP' | 'HP' | 'DM'
  grade?: string; // graded
  company?: string; // graded: 'PSA' | 'BGS' | 'CGC' | …
  low?: number;
  mid?: number;
  high?: number;
  market?: number;
  currency?: string; // 'USD' | 'JPY'
  trends?: Record<string, ScrydexTrend>; // days_1, days_7, days_14, days_30, days_90, days_180
}
export interface ScrydexMarketplace {
  name?: string; // 'tcgplayer'
  product_id?: string | number; // the TCGplayer product id — our join key
}
export interface ScrydexVariant {
  name?: string; // 'holofoil' | 'normal' | …
  marketplaces?: ScrydexMarketplace[];
  prices?: ScrydexPrice[];
}
export interface ScrydexCard {
  id: string;
  name?: string;
  number?: string;
  printed_number?: string;
  language_code?: string; // 'EN' | 'JA' | …
  expansion?: { id?: string; name?: string } | null;
  variants?: ScrydexVariant[];
}
export interface ScrydexPage {
  data: ScrydexCard[];
  total_count: number;
  page: number;
  page_size: number;
}

/** Our game → Scrydex URL slug. Verified live: MTG is `magicthegathering` (NOT `mtg`/`magic`). */
const GAME_SLUG: Record<string, string> = { pokemon: 'pokemon', onepiece: 'onepiece', mtg: 'magicthegathering' };
export function scrydexSlug(game: string): string | null {
  return GAME_SLUG[game] ?? null;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class ScrydexClient {
  private limiter: ProviderLimiter;
  private fetchFn: typeof fetch;
  private retryBaseMs: number;
  private maxAttempts: number;

  constructor(
    db: Db,
    opts: { fetchFn?: typeof fetch; limiter?: ProviderLimiter; retryBaseMs?: number; maxAttempts?: number } = {},
  ) {
    this.limiter =
      opts.limiter ??
      new ProviderLimiter(db, 'scrydex', {
        minIntervalMs: config.scrydexMinIntervalMs,
        dailyCap: config.scrydexDailyCap,
      });
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.maxAttempts = opts.maxAttempts ?? 4;
  }

  /** GET /{slug}/v1/cards — paginated search (Lucene-ish `q`), prices included. ≤100 cards per credit. */
  async searchCards(
    slug: string,
    params: { q?: string; page?: number; pageSize?: number },
    priority: ProviderPriority,
  ): Promise<ScrydexPage> {
    const qs = new URLSearchParams({ include: 'prices' });
    if (params.q) qs.set('q', params.q);
    if (params.page != null) qs.set('page', String(params.page));
    if (params.pageSize != null) qs.set('pageSize', String(params.pageSize));
    const json = await this.request(`/${slug}/v1/cards?${qs}`, priority);
    return {
      data: Array.isArray(json?.data) ? json.data : [],
      total_count: Number(json?.total_count ?? 0),
      page: Number(json?.page ?? 1),
      page_size: Number(json?.page_size ?? 0),
    };
  }

  /** GET /{slug}/v1/cards/{id} — one card with prices. Envelope is `{ data }` or the bare card. */
  async getCard(slug: string, id: string, priority: ProviderPriority): Promise<ScrydexCard | null> {
    const json = await this.request(`/${slug}/v1/cards/${encodeURIComponent(id)}?include=prices`, priority);
    const card = json?.data ?? json;
    return card && typeof card === 'object' && 'id' in card ? (card as ScrydexCard) : null;
  }

  /** One paced+retried GET. Throws on non-retryable errors or when attempts are exhausted. */
  private async request(path: string, priority: ProviderPriority): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire(priority); // every attempt is a real request — pace them all
      let res: Response | null = null;
      let err: Error;
      try {
        res = await this.fetchFn(`${config.scrydexBase}${path}`, {
          headers: { 'X-Api-Key': config.scrydexApiKey, 'X-Team-ID': config.scrydexTeamId },
        });
        if (res.ok) return res.json();
        if (!RETRYABLE_STATUS.has(res.status)) throw new Error(`scrydex ${res.status} on ${path}`);
        err = new Error(`scrydex ${res.status} on ${path}`);
      } catch (e) {
        if (res != null) throw e; // the non-retryable throw above — propagate as-is
        err = e as Error; // network error — retryable
      }
      if (attempt + 1 >= this.maxAttempts) throw err; // exhausted: fail now, no pointless final sleep
      await this.backoff(attempt, res?.headers.get('retry-after') ?? null);
    }
  }

  /** Exponential backoff with jitter; a provider-sent retry-after always wins when longer. */
  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const fromHeader = retryAfter != null ? Number(retryAfter) * 1000 : 0;
    const ms = Math.max(Number.isFinite(fromHeader) ? fromHeader : 0, this.retryBaseMs * 2 ** attempt) + Math.random() * 250;
    await sleep(ms);
  }
}

// ---------------------------------------------------------------------------
// Parse — Scrydex card → our raw TCGplayer quote (matched by product_id)
// ---------------------------------------------------------------------------

// Raw condition preference: near-mint first; vintage cards may only carry a price in lower grades.
const RAW_CONDITION_ORDER = ['NM', 'LP', 'MP'];

/** The TCGplayer raw quote we read off a Scrydex card. `market` is the price anchor (USD or JPY — JP-only
 *  printings report JPY; the oracle's combinePrice converts via FX). `day1Pct` is the 1-day % move, used
 *  by the confidence spike-gate + the mark guard. */
export interface ScrydexRaw {
  market: number;
  low: number | null;
  high: number | null;
  currency: string; // 'USD' | 'JPY'
  day1Pct: number | null; // trends.days_1.percent_change
  condition: string; // which condition supplied the price (NM/LP/MP)
  variant: string | null;
}

/** Extract OUR card's raw TCGplayer quote from a Scrydex card: find the variant whose marketplace
 *  `product_id` equals our `tcgplayer_id`, then its raw price for the best available condition
 *  (NM→LP→MP) that actually carries a positive market value. Returns null if unmatched/unpriced. */
export function extractRaw(card: ScrydexCard, tcgplayerId: number | null): ScrydexRaw | null {
  if (tcgplayerId == null) return null;
  const want = String(tcgplayerId);
  for (const v of card.variants ?? []) {
    if (!(v.marketplaces ?? []).some((m) => m.product_id != null && String(m.product_id) === want)) continue;
    for (const cond of RAW_CONDITION_ORDER) {
      const p = (v.prices ?? []).find(
        (x) => x.type === 'raw' && x.condition === cond && typeof x.market === 'number' && x.market > 0,
      );
      if (p) {
        return {
          market: p.market as number,
          low: typeof p.low === 'number' ? p.low : null,
          high: typeof p.high === 'number' ? p.high : null,
          currency: p.currency ?? 'USD',
          day1Pct: p.trends?.days_1?.percent_change ?? null,
          condition: cond,
          variant: v.name ?? null,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Price + confidence combine (Scrydex anchor + tcgpl cross-checks) — build spec §5/§6
// ---------------------------------------------------------------------------

const cents = (x: number): number => Math.round(x * 100) / 100; // prices live on a $0.01 tick

/** tcgpricelookup cross-check signals for one card (NOT a price source — confidence only). */
export interface CrossCheck {
  tcgpMarket: number | null; // tcgpl's TCGplayer market — the cross-FEED (same venue: a freshness check, not independent)
  ebay1d: number | null; // tcgpl's eBay avg_1d — the only genuinely independent VENUE
}

export type Tier = 'tradeable' | 'reduce_only' | 'halted';

// Confidence thresholds (tunable; build spec §6/§13 — candidates for liveKnob).
export const EBAY_BAND_LO = 0.5; // C2 eBay corroboration band (decision #1: 0.5×–1.5×)
export const EBAY_BAND_HI = 1.5;
const CROSSFEED_TOL = 0.15; // C1 cross-feed agreement (±15%)
const SPREAD_MAX = 0.5; // C3 (high − low) / market
const SPIKE_PCT = 40; // C4 day-1 spike threshold (%)

const ebayInBand = (v: number, price: number) => v >= EBAY_BAND_LO * price && v <= EBAY_BAND_HI * price;

/** Confidence tier — the §6 decision tree, first match wins. `sx` is the Scrydex raw ALREADY converted
 *  to USD; `x` carries the tcgpl cross-checks. A SPIKE is corroborated ONLY by eBay (the independent
 *  venue) — cross-feed agreement (both TCGplayer) cannot un-gate a move (§6 C4, the tightened rule). */
export function scoreConfidence(price: number, sx: ScrydexRaw | null, x: CrossCheck): Tier {
  if (!(price > 0)) return 'halted'; // 1. no usable price
  const ebay = x.ebay1d != null && x.ebay1d > 0 ? x.ebay1d : null;
  const cross = sx != null && x.tcgpMarket != null && x.tcgpMarket > 0 ? x.tcgpMarket : null;
  const ebayAgrees = ebay != null && ebayInBand(ebay, price);
  const crossAgrees = cross != null && sx != null && Math.abs(sx.market / cross - 1) <= CROSSFEED_TOL;
  const day1 = sx?.day1Pct ?? null;
  // 2. uncorroborated day-1 spike → reduce_only (manipulation gate; only eBay corroborates a move).
  if (day1 != null && Math.abs(day1) > SPIKE_PCT && !ebayAgrees) return 'reduce_only';
  // 3. a corroborator (eBay OR cross-feed) confirms the price → tradeable.
  if (ebayAgrees || crossAgrees) return 'tradeable';
  // 4. a corroborator is present but disagrees → reduce_only.
  if (ebay != null || cross != null) return 'reduce_only';
  // 5. no corroborator available → lean permissive: tradeable iff the Scrydex spread is tight.
  const spreadTight =
    sx != null && sx.low != null && sx.high != null && sx.market > 0 && (sx.high - sx.low) / sx.market <= SPREAD_MAX;
  return spreadTight ? 'tradeable' : 'reduce_only';
}

export interface Combined {
  priceUsd: number; // 0 = halted (no usable price)
  tier: Tier;
}

/** FX a Scrydex raw to USD (JP printings report JPY — decision #3). Returns null when it's JPY and no
 *  rate is available (we can't price it in USD — better halt than mis-price a yen number as dollars). */
export function toUsd(sx: ScrydexRaw, fxJpyUsd: number | null): ScrydexRaw | null {
  if (sx.currency !== 'JPY') return sx;
  if (!fxJpyUsd || fxJpyUsd <= 0) return null;
  return {
    ...sx,
    market: sx.market * fxJpyUsd,
    low: sx.low != null ? sx.low * fxJpyUsd : null,
    high: sx.high != null ? sx.high * fxJpyUsd : null,
    currency: 'USD',
  };
}

/** Combine the Scrydex price (anchor) with the tcgpl cross-checks into a final USD price + tier. Price
 *  source order: Scrydex TCGplayer market (FX'd) → tcgpl TCGplayer market → 0 (halt; manual-pin +
 *  keep-last live in ingestCard). **eBay never sets the price.** */
export function combinePrice(sx: ScrydexRaw | null, x: CrossCheck, fxJpyUsd: number | null): Combined {
  const sxUsd = sx ? toUsd(sx, fxJpyUsd) : null;
  let priceUsd = sxUsd && sxUsd.market > 0 ? sxUsd.market : 0;
  if (!(priceUsd > 0) && x.tcgpMarket != null && x.tcgpMarket > 0) priceUsd = x.tcgpMarket; // fallback to tcgpl TCGplayer
  priceUsd = cents(priceUsd);
  return { priceUsd, tier: scoreConfidence(priceUsd, sxUsd, x) };
}

let defaultClient: ScrydexClient | null = null;

/** Process-wide client (one ProviderLimiter, shared with the priority queue). */
export function getDefaultScrydexClient(db: Db): ScrydexClient {
  return (defaultClient ??= new ScrydexClient(db));
}
