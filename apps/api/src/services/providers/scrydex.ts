import { createHmac, timingSafeEqual } from 'node:crypto';
import { toE6 } from '@pokex/pricing';
import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import type { OracleCard } from '../oracle.ts';
import { getJpyUsd } from './fx.ts';
import { ProviderLimiter, sleep, type ProviderPriority } from './limiter.ts';
import { formatDisplayName } from './display.ts';
import { fromTplCard, getDefaultClient, tplCrossCheck, sortGradeRows, type GradeRow, type TplCard, type TrackedMarket } from './tcgpricelookup.ts';

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
export interface ScrydexImage {
  type?: string; // 'front' | 'back'
  small?: string;
  medium?: string;
  large?: string;
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
  rarity?: string;
  language_code?: string; // 'EN' | 'JA' | …
  images?: ScrydexImage[]; // card-level art (used when tcgpl drops the card and Scrydex carries display)
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
export const SCRYDEX_BATCH_SIZE = 100; // max ids per request = pageSize max = 1 credit (spec §3a)

export class ScrydexClient {
  private limiter: ProviderLimiter;
  private fetchFn: typeof fetch;
  private retryBaseMs: number;
  private maxAttempts: number;
  private requestTimeoutMs: number;

  constructor(
    db: Db,
    opts: { fetchFn?: typeof fetch; limiter?: ProviderLimiter; retryBaseMs?: number; maxAttempts?: number; requestTimeoutMs?: number } = {},
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
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
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

  /** Batch card lookup by id — 1 credit per chunk of ≤SCRYDEX_BATCH_SIZE. The batch query is an id-OR
   *  (`id:a OR id:b OR …`); the field is REPEATED per id — the grouped form `id:(a OR b)` silently
   *  returns nothing (confirmed live 2026-06-17, spec §3a). Each id matches ≤1 card, so a ≤100-id chunk
   *  fits one `pageSize=100` page with no intra-chunk pagination. */
  async getCardsByIds(slug: string, ids: string[], priority: ProviderPriority): Promise<ScrydexCard[]> {
    const out: ScrydexCard[] = [];
    for (let i = 0; i < ids.length; i += SCRYDEX_BATCH_SIZE) {
      const chunk = ids.slice(i, i + SCRYDEX_BATCH_SIZE);
      const q = chunk.map((id) => `id:${id}`).join(' OR ');
      const page = await this.searchCards(slug, { q, pageSize: SCRYDEX_BATCH_SIZE }, priority);
      out.push(...page.data);
    }
    return out;
  }

  /** One paced+retried GET. Throws on non-retryable errors or when attempts are exhausted. */
  private async request(path: string, priority: ProviderPriority): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire(priority); // every attempt is a real request — pace them all
      let res: Response | null = null;
      let err: Error;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs); // a stalled socket must not hang forever
      try {
        res = await this.fetchFn(`${config.scrydexBase}${path}`, {
          headers: { 'X-Api-Key': config.scrydexApiKey, 'X-Team-ID': config.scrydexTeamId },
          signal: ac.signal,
        });
        if (res.ok) return await res.json(); // await so the timeout also covers the body read
        if (!RETRYABLE_STATUS.has(res.status)) throw new Error(`scrydex ${res.status} on ${path}`);
        err = new Error(`scrydex ${res.status} on ${path}`);
      } catch (e) {
        if (res != null && !ac.signal.aborted) throw e; // genuine non-retryable status throw — propagate as-is
        err = e as Error; // network error OR request timeout (abort) — retryable
      } finally {
        clearTimeout(timer);
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
/** The card variant whose TCGplayer marketplace matches OUR product id (the per-printing join key). */
function findVariantByProduct(card: ScrydexCard, tcgplayerId: number | null): ScrydexVariant | undefined {
  if (tcgplayerId == null) return undefined;
  const want = String(tcgplayerId);
  return (card.variants ?? []).find((v) =>
    (v.marketplaces ?? []).some((m) => m.product_id != null && String(m.product_id) === want),
  );
}

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
// Graded prices (PSA/BGS/CGC/… ladder) — Scrydex carries a full per-grade ladder with trends; richer
// + fresher than tcgpl's eBay graded, and free of the eBay-median garbage. tcgpl stays the fallback.
// ---------------------------------------------------------------------------

/** The full graded ladder off a Scrydex card, matched to OUR market by the TCGplayer product_id and
 *  FX'd to USD. Dedups duplicate company+grade (prefers a real low<high range over a single-sale
 *  outlier) and drops JPY rungs when no FX is available. Empty when the card has no graded data. */
export function scrydexGradedLadder(card: ScrydexCard, tcgplayerId: number | null, fxJpyUsd: number | null): GradeRow[] {
  const variant = findVariantByProduct(card, tcgplayerId);
  if (!variant) return [];
  const ranged = (p: ScrydexPrice) => typeof p.low === 'number' && typeof p.high === 'number' && p.low < p.high;
  const best = new Map<string, ScrydexPrice>();
  for (const p of variant.prices ?? []) {
    if (p.type !== 'graded' || !p.company || !p.grade || typeof p.market !== 'number' || p.market <= 0) continue;
    const g = Number(p.grade);
    if (!Number.isFinite(g) || g <= 0 || g > 10) continue; // guard mis-parsed grades
    const key = `${p.company}|${p.grade}`;
    const cur = best.get(key);
    if (!cur || (ranged(p) && !ranged(cur))) best.set(key, p); // prefer a real range over a one-sale outlier
  }
  const rows: GradeRow[] = [];
  for (const p of best.values()) {
    let usd = p.market as number;
    if (p.currency === 'JPY') {
      if (!fxJpyUsd || fxJpyUsd <= 0) continue; // can't price a JPY graded rung without FX — drop it
      usd *= fxJpyUsd;
    }
    rows.push({ grader: (p.company as string).toUpperCase(), grade: p.grade as string, priceE6: toE6(usd).toString() });
  }
  return sortGradeRows(rows);
}

/** PSA-10 (USD micro) off a Scrydex graded ladder — the graded-index anchor + stored graded price. */
export function scrydexPsa10E6(ladder: GradeRow[]): bigint | null {
  const row = ladder.find((r) => r.grader === 'PSA' && r.grade === '10');
  return row ? BigInt(row.priceE6) : null;
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
  // `cross != null` implies `sx != null` and (extractRaw guarantees a positive market) `price` is the
  // Scrydex anchor — so compare against `price`, the same rounded base the eBay band uses.
  const crossAgrees = cross != null && Math.abs(price / cross - 1) <= CROSSFEED_TOL;
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
  ebayCorroborated: boolean; // eBay (independent venue) agrees with the price → the mark guard adopts a move without clamping (§6a)
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
  const ebayCorroborated = x.ebay1d != null && x.ebay1d > 0 && priceUsd > 0 && ebayInBand(x.ebay1d, priceUsd);
  return { priceUsd, tier: scoreConfidence(priceUsd, sxUsd, x), ebayCorroborated };
}

let defaultClient: ScrydexClient | null = null;

/** Process-wide client (one ProviderLimiter, shared with the priority queue). */
export function getDefaultScrydexClient(db: Db): ScrydexClient {
  return (defaultClient ??= new ScrydexClient(db));
}

// ---------------------------------------------------------------------------
// OracleCard fetcher (P2b) — re-prices the tracked universe, Scrydex-primary
// ---------------------------------------------------------------------------

/** A tracked market re-priced by the Scrydex feed. Identity (game/symbol/card_id) and the join keys
 *  come from OUR market row, never the provider — Scrydex sets the price, tcgpl cross-checks. */
export interface ScrydexTracked {
  scrydex_card_id: string | null; // null for tcgpl-only markets (no Scrydex match) — they price off tcgpl fallback
  provider_card_id: string | null; // tcgpl id — present for the whole discovery-built universe
  symbol: string;
  card_id: string;
  game: string;
  tcgplayer_id: number | null; // the join key: Scrydex variant marketplace product_id == this
  featured: boolean;
}

const EMPTY_CROSS: CrossCheck = { tcgpMarket: null, ebay1d: null };

/** Display/identity OracleCard built from a SCRYDEX card — the fallback for when tcgpl has dropped the
 *  card but Scrydex still prices it (Scrydex-primary keeps it tradeable instead of letting it go stale).
 *  Identity stays from OUR market row. `rawE6`/`confident` are placeholders the fetcher overwrites with
 *  the combined price/tier. */
export function fromScrydexCard(c: ScrydexCard, t: ScrydexTracked): OracleCard {
  const front = (c.images ?? []).find((i) => i.type === 'front') ?? (c.images ?? [])[0];
  const variant = findVariantByProduct(c, t.tcgplayer_id);
  return {
    game: t.game,
    symbol: t.symbol,
    cardId: t.card_id,
    tcgplayerId: t.tcgplayer_id,
    providerCardId: t.provider_card_id,
    displayName: formatDisplayName(c.name ?? t.card_id, c.number ?? null),
    variant: variant?.name ?? null,
    imageSmall: front?.small ?? null,
    imageLarge: front?.large ?? front?.small ?? null,
    metadata: { setName: c.expansion?.name ?? null, setSlug: c.expansion?.id ?? null, rarity: c.rarity ?? null },
    rawE6: 0n, // overwritten by the fetcher (combinePrice)
    confident: false, // overwritten by the fetcher
    observedAt: null, // no per-card Scrydex price timestamp here → pass wall-clock (hybrid dedup re-stamps moves)
    featured: t.featured,
  };
}

/** Live fetcher behind ORACLE_PRIMARY=scrydex: Scrydex sets the TCGplayer price, tcgpl runs alongside for
 *  the eBay/cross-feed confidence check, joined per market by tcgplayer_id (spec §4). Identity/display
 *  prefer the tcgpl card (its mapping already exists) and fall back to the Scrydex card when tcgpl drops
 *  one. A card neither feed prices gets no print — the staleness halt covers it, same as the tcgpl path. */
export async function fetchScrydexTrackedCards(
  db: Db,
  sxClient?: ScrydexClient,
  tplClient?: ReturnType<typeof getDefaultClient>,
  fx: () => Promise<number | null> = getJpyUsd, // injectable so tests stay hermetic (no live FX call)
  expansionIds?: string[], // when set, scope to markets in these Scrydex expansions (the webhook re-price path, §8)
): Promise<OracleCard[]> {
  const sx = sxClient ?? getDefaultScrydexClient(db);
  const tpl = tplClient ?? getDefaultClient(db);
  const tracked = await db.query<ScrydexTracked>(
    // Full tracked universe: Scrydex-matched cards price off Scrydex; tcgpl-only cards (no scrydex_card_id —
    // e.g. most of One Piece) have no anchor but still price off the tcgpl TCGplayer market via combinePrice's
    // fallback. Without this OR, those markets get no print under scrydex-primary and go stale.
    `SELECT scrydex_card_id, provider_card_id, symbol, card_id, game, tcgplayer_id, featured FROM markets
      WHERE kind = 'card' AND (scrydex_card_id IS NOT NULL OR provider_card_id IS NOT NULL) AND status != 'delisted'
      ${expansionIds ? 'AND scrydex_expansion_id = ANY($1)' : ''}`,
    expansionIds ? [expansionIds] : [],
  );
  if (tracked.rows.length === 0) return [];

  // 1. Scrydex (the price anchor): batch by scrydex_card_id, per game slug (the endpoint is per-game).
  const sxIdsByGame = new Map<string, string[]>();
  for (const t of tracked.rows) {
    if (!t.scrydex_card_id) continue; // tcgpl-only market → no Scrydex anchor; the tcgpl fallback prices it
    const slug = scrydexSlug(t.game);
    if (!slug) continue; // a game Scrydex doesn't cover → no anchor; the tcgpl fallback still prices it
    const list = sxIdsByGame.get(slug) ?? [];
    list.push(t.scrydex_card_id);
    sxIdsByGame.set(slug, list);
  }
  const sxById = new Map<string, ScrydexCard>();
  for (const [slug, ids] of sxIdsByGame) {
    // Dedup: variant-markets of one card share a scrydex_card_id; a dup straddling a chunk burns a credit.
    for (const c of await sx.getCardsByIds(slug, [...new Set(ids)], 'refresh')) sxById.set(c.id, c);
  }

  // 2. tcgpl (the cross-check + the identity/display source): batch by provider_card_id.
  const tplIds = tracked.rows.map((t) => t.provider_card_id).filter((id): id is string => id != null);
  const tplById = new Map<string, TplCard>();
  for (const c of await tpl.getCardsByIds(tplIds, 'refresh')) tplById.set(c.id, c);

  // 3. FX once per pass — only JP (JPY) Scrydex prices use it (decision #3).
  const fxJpyUsd = await fx();

  return tracked.rows.flatMap((t) => {
    const sxCard = t.scrydex_card_id ? sxById.get(t.scrydex_card_id) : undefined;
    const tplCard = t.provider_card_id ? tplById.get(t.provider_card_id) : undefined;
    const sxRaw = sxCard ? extractRaw(sxCard, t.tcgplayer_id) : null;
    const cross = tplCard ? tplCrossCheck(tplCard) : EMPTY_CROSS;
    const combined = combinePrice(sxRaw, cross, fxJpyUsd);
    if (!(combined.priceUsd > 0)) return []; // neither feed priced it — no print, staleness halt covers it

    // Identity/display from the tcgpl card (existing mapping) or the Scrydex card if tcgpl dropped it.
    let base: OracleCard | null = null;
    if (tplCard) {
      const identity: TrackedMarket = { provider_card_id: t.provider_card_id ?? '', symbol: t.symbol, card_id: t.card_id, game: t.game, featured: t.featured };
      base = fromTplCard(tplCard, identity);
    } else if (sxCard) {
      base = fromScrydexCard(sxCard, t);
    }
    if (!base) return []; // priced but nothing to describe it — skip rather than upsert a null display

    // Graded: Scrydex full ladder first (richer + free of the tcgpl eBay-median garbage); tcgpl's eBay
    // PSA-10 (carried on `base` when it came from fromTplCard) is the fallback for the index anchor.
    const sxGradedLadder = sxCard ? scrydexGradedLadder(sxCard, t.tcgplayer_id, fxJpyUsd) : [];
    const gradedE6 = scrydexPsa10E6(sxGradedLadder) ?? base.gradedE6;

    return [
      {
        ...base,
        rawE6: toE6(combined.priceUsd),
        gradedE6,
        confident: combined.tier === 'tradeable',
        markCorroborated: combined.ebayCorroborated, // engages the §6a mark guard (eBay-only corroboration)
        payload: {
          scrydex: {
            id: sxCard?.id ?? null,
            market: sxRaw?.market ?? null,
            currency: sxRaw?.currency ?? null,
            condition: sxRaw?.condition ?? null,
            day1Pct: sxRaw?.day1Pct ?? null,
            tier: combined.tier,
            fxJpyUsd,
            graded: sxGradedLadder.length ? sxGradedLadder : null, // full ladder for the detail panel
          },
          tcgpricelookup: { cross, prices: tplCard?.prices ?? null },
        },
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Webhooks (P4) — prices.raw_updated is the primary update path (spec §8)
// ---------------------------------------------------------------------------

/** A Scrydex price webhook event: `{ id, name, data: { expansion_ids } }`. The payload names the
 *  EXPANSIONS that re-priced (not the cards) — we map them to our tracked markets and re-price. */
export interface ScrydexWebhookEvent {
  id?: string;
  name?: string; // '<game>.expansions.prices.raw_updated' | '*.graded_updated' | '*.pop_reports.updated'
  data?: { expansion_ids?: string[] };
}

const WEBHOOK_REPLAY_WINDOW_SEC = 5 * 60; // §8: reject events whose timestamp is outside a 5-minute window

/** Verify a Scrydex webhook signature (Stripe-style; confirmed live against scrydex.com/docs 2026-06-17).
 *  The `X-Scrydex-Signature` header is `t=<unix>,v1=<hmac-hex>`; the signed string is `${t}.${rawBody}`
 *  HMAC-SHA256'd with the `whsec_` secret, hex. Returns true only when v1 matches (constant-time) AND t
 *  is within the replay window. `rawBody` MUST be the exact received bytes — a re-stringified JSON
 *  (different spacing/key order) will not match (Scrydex sends minified UTF-8). */
export function verifyScrydexSignature(rawBody: string, header: string | undefined, secret: string, nowSec?: number): boolean {
  if (!secret || !header) return false;
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (k === 't') t = val;
    else if (k === 'v1') v1 = val;
  }
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_REPLAY_WINDOW_SEC) return false; // stale / replay
  // Decode v1 from hex and compare the raw 32-byte digests: a malformed v1 (odd length / non-hex)
  // decodes to the wrong length and is rejected by the length guard before the constant-time compare.
  const got = Buffer.from(v1, 'hex');
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return got.length === expected.length && timingSafeEqual(got, expected); // timingSafeEqual throws on length mismatch
}

// ---------------------------------------------------------------------------
// Backfill (P4) — match each tracked market to its Scrydex card id, one time
// ---------------------------------------------------------------------------

// Lucene/Scrydex query specials. We can't safely embed these in a `name:"…"` term — Scrydex 400s on
// some even inside quotes (e.g. `[Finalist]`) — so we strip them rather than escape.
const LUCENE_SPECIALS = /[+\-!(){}[\]^"~*?:\\/]/g;

/** The card name to search Scrydex by, derived from our display name. Strips the trailing "#number"
 *  suffix and the parenthetical/bracketed PRINTING qualifiers ("(Serial Numbered)", "[Finalist]") that
 *  aren't part of the Scrydex card name, then drops the remaining Lucene specials so the query can't be
 *  malformed (a 400) or break out of the quoted term. The product_id match disambiguates the printing,
 *  so an approximate name is fine; returns '' when nothing usable remains (caller skips → unmatched). */
function searchNameOf(displayName: string): string {
  return displayName
    .replace(/\s*#.*$/, '') // trailing "#87/160" display suffix
    .replace(/\([^)]*\)/g, ' ') // "(Serial Numbered)", "(CS 2023 Top Players Pack)"
    .replace(/\[[^\]]*\]/g, ' ') // "[Finalist]"
    .replace(LUCENE_SPECIALS, ' ') // any remaining specials (embedded quotes, hyphens, …)
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BackfillResult {
  total: number; // markets considered this run
  matched: number; // markets we found a Scrydex card for
  applied: number; // rows actually written (0 unless apply=true)
  failures: number; // per-card search ERRORS (a Scrydex 400/outage) — a subset of unmatched; lets a caller
  // tell an outage (high failures) apart from genuine zero-coverage (high unmatched, zero failures)
  matches: { id: string; name: string; scrydexCardId: string; scrydexExpansionId: string | null }[]; // proposed/written
  unmatched: { id: string; name: string }[]; // no match — stays null → tcgpl fallback
}

/** One-time (slow-cadence) reconcile: for each tracked market with a tcgplayer_id but no
 *  scrydex_card_id, search Scrydex by name and match the card+variant whose marketplace product_id ==
 *  our tcgplayer_id, then persist scrydex_card_id + scrydex_expansion_id. Scrydex has no by-product_id
 *  filter (verified live), so this is name-search + exact product_id match. Bounded by `limit` (markets)
 *  and `maxPages` (pages scanned per card) to cap credits; unmatched markets stay null and fall back to
 *  tcgpl. **Dry-run by default** (reports the proposed matches, writes nothing) — pass `apply: true` to
 *  persist. Idempotent under apply — re-running only revisits still-unmatched markets. */
export async function backfillScrydexIds(
  db: Db,
  opts: { limit?: number; maxPages?: number; client?: ScrydexClient; apply?: boolean; log?: (msg: string) => void } = {},
): Promise<BackfillResult> {
  const limit = opts.limit ?? 200;
  const maxPages = opts.maxPages ?? 5;
  const apply = opts.apply ?? false;
  const log = opts.log ?? (() => {});
  const sx = opts.client ?? getDefaultScrydexClient(db);
  const todo = await db.query<{ id: string; display_name: string; game: string; tcgplayer_id: number }>(
    `SELECT id, display_name, game, tcgplayer_id FROM markets
      WHERE kind = 'card' AND tcgplayer_id IS NOT NULL AND scrydex_card_id IS NULL AND status != 'delisted'
      ORDER BY featured DESC, display_name
      LIMIT $1`,
    [limit],
  );

  const result: BackfillResult = { total: todo.rows.length, matched: 0, applied: 0, failures: 0, matches: [], unmatched: [] };
  for (const m of todo.rows) {
    const slug = scrydexSlug(m.game);
    if (!slug) {
      result.unmatched.push({ id: m.id, name: m.display_name });
      continue;
    }
    const want = String(m.tcgplayer_id);
    const name = searchNameOf(m.display_name);
    let found: ScrydexCard | undefined;
    if (name) {
      // Tolerate a per-card search failure (a Scrydex 400 on an odd name, a transient error): mark the
      // card unmatched and keep going — one bad name must never abort the whole reconcile.
      try {
        const q = `name:"${name}"`;
        for (let page = 1; page <= maxPages && !found; page++) {
          const res = await sx.searchCards(slug, { q, page, pageSize: SCRYDEX_BATCH_SIZE }, 'discovery');
          found = res.data.find((c) =>
            (c.variants ?? []).some((v) => (v.marketplaces ?? []).some((mk) => mk.product_id != null && String(mk.product_id) === want)),
          );
          if (res.data.length === 0 || page * SCRYDEX_BATCH_SIZE >= res.total_count) break; // no more pages
        }
      } catch (e) {
        result.failures++;
        log(`search failed  ${m.display_name}: ${(e as Error).message}`);
      }
    }
    if (!found) {
      result.unmatched.push({ id: m.id, name: m.display_name });
      continue;
    }
    const expId = found.expansion?.id ?? null;
    result.matched++;
    result.matches.push({ id: m.id, name: m.display_name, scrydexCardId: found.id, scrydexExpansionId: expId });
    log(`${apply ? 'write' : 'would write'}  ${m.display_name}  ->  ${found.id} (${expId ?? '?'})`);
    if (!apply) continue;
    await db.query(`UPDATE markets SET scrydex_card_id = $1, scrydex_expansion_id = $2 WHERE id = $3`, [found.id, expId, m.id]);
    result.applied++;
  }
  return result;
}
