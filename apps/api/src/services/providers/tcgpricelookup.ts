import { toE6 } from '@pokex/pricing';
import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import type { OracleCard } from '../oracle.ts';
import { ProviderLimiter, sleep, type ProviderPriority } from './limiter.ts';
import { formatDisplayName } from './display.ts';

/**
 * tcgpricelookup provider (Trader plan; spec in docs/data-providers.md). Two layers in this module:
 * the HTTP client (every request through the global ProviderLimiter — 1 req/s + daily budget enforced
 * via the DB across instances; retries 429/5xx/Cloudflare with backoff, each retry re-claims a slot),
 * and the OracleCard fetcher (P3) that re-prices the TRACKED market universe per pass.
 */

export interface TplCard {
  id: string;
  tcgplayer_id: number | string | null; // verified live: the API serializes this as a STRING ("284251")
  name: string;
  number: string | null;
  rarity: string | null;
  variant: string | null;
  image_url: string | null;
  updated_at: string | null;
  set: { slug: string; name: string } | null;
  game: { slug: string; name: string } | null;
  prices: {
    raw?: Record<string, { tcgplayer?: { market?: number; low?: number; mid?: number; high?: number }; ebay?: { avg_1d?: number; avg_7d?: number; avg_30d?: number } }>;
    graded?: Record<string, Record<string, { ebay?: { avg_1d?: number; avg_7d?: number; avg_30d?: number } }>>;
  } | null;
}

export interface TplPage {
  data: TplCard[];
  total: number;
  limit: number;
  offset: number;
}

export interface TplSearchParams {
  q?: string;
  game?: string; // 'pokemon' | 'mtg' | 'onepiece' | ...
  set?: string; // set slug
  ids?: string[]; // batch lookup, <= BATCH_SIZE per request (verified live)
  limit?: number;
  offset?: number;
}

/** One per-source price row inside a history point (verified live 2026-06-12): raw rows carry
 *  source='tcgplayer'|'ebay' + condition; graded rows carry grader+grade instead of condition. */
export interface TplHistoryRow {
  source: string | null;
  condition: string | null;
  grader: string | null;
  grade: string | null;
  price_market: number | null;
  price_low: number | null;
  price_mid: number | null;
  price_high: number | null;
  avg_1d: number | null;
  avg_7d: number | null;
  avg_30d: number | null;
}

export interface TplHistoryPoint {
  date: string; // 'YYYY-MM-DD'
  prices: TplHistoryRow[];
}

export const TPL_BATCH_SIZE = 20; // documented max ids per search request

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class TcgPriceLookupClient {
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
      new ProviderLimiter(db, 'tcgpricelookup', {
        minIntervalMs: config.tcgpricelookupMinIntervalMs,
        dailyCap: config.tcgpricelookupDailyCap,
      });
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.maxAttempts = opts.maxAttempts ?? 4;
  }

  /** GET /cards/search — by query/game/set, or by ids (batch). Returns the paginated envelope. */
  async searchCards(params: TplSearchParams, priority: ProviderPriority): Promise<TplPage> {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.game) qs.set('game', params.game);
    if (params.set) qs.set('set', params.set);
    if (params.ids?.length) qs.set('ids', params.ids.join(','));
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    const json = await this.request(`/cards/search?${qs}`, priority);
    return {
      data: Array.isArray(json?.data) ? json.data : [],
      total: Number(json?.total ?? 0),
      limit: Number(json?.limit ?? 0),
      offset: Number(json?.offset ?? 0),
    };
  }

  /** Batch card lookup — chunks ids by the provider's per-request max; the limiter paces the chunks. */
  async getCardsByIds(ids: string[], priority: ProviderPriority): Promise<TplCard[]> {
    const out: TplCard[] = [];
    for (let i = 0; i < ids.length; i += TPL_BATCH_SIZE) {
      const page = await this.searchCards({ ids: ids.slice(i, i + TPL_BATCH_SIZE) }, priority);
      out.push(...page.data);
    }
    return out;
  }

  /** GET /cards/:id — full card details. */
  async getCard(id: string, priority: ProviderPriority): Promise<TplCard | null> {
    const json = await this.request(`/cards/${encodeURIComponent(id)}`, priority);
    return json && typeof json === 'object' && 'id' in json ? (json as TplCard) : null;
  }

  /** GET /cards/:id/history — daily price series (Trader-gated). Sparse: only days with data. */
  async getCardHistory(id: string, period: '7d' | '30d' | '90d' | '1y', priority: ProviderPriority): Promise<TplHistoryPoint[]> {
    const json = await this.request(`/cards/${encodeURIComponent(id)}/history?period=${period}`, priority);
    return Array.isArray(json?.data) ? json.data : [];
  }

  /** One paced+retried GET. Throws on non-retryable errors or when attempts are exhausted. */
  private async request(path: string, priority: ProviderPriority): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire(priority); // every attempt is a real provider request — pace them all
      let res: Response | null = null;
      let err: Error;
      try {
        res = await this.fetchFn(`${config.tcgpricelookupBase}${path}`, {
          headers: { 'X-API-Key': config.tcgpricelookupApiKey },
        });
        const isHtml = (res.headers.get('content-type') ?? '').includes('text/html'); // Cloudflare challenge page
        if (res.ok && !isHtml) return res.json();
        if (!RETRYABLE_STATUS.has(res.status) && !isHtml) {
          throw new Error(`tcgpricelookup ${res.status} on ${path}`);
        }
        err = new Error(`tcgpricelookup ${res.status}${isHtml ? ' (challenge page)' : ''} on ${path}`);
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
// OracleCard fetcher (P3) — re-prices the tracked market universe
// ---------------------------------------------------------------------------

/** Below this raw NM market price a card is "thin": one relisting can move the TCGplayer spot, so the
 *  oracle uses the smoothed eBay 7-day average instead (operator decision, plan "Decisions & defaults"). */
export const LIQUID_THRESHOLD_USD = 25;

// Condition preference for the raw price (plan section E fallback chain).
const CONDITION_ORDER = ['near_mint', 'lightly_played'];

/** Creatability gate (P6 search-and-bet, plan "Decisions & defaults"): NM TCGplayer market >= $10
 *  AND the eBay 7d average agrees within ~25% — a liquidity/agreement proxy that rejects
 *  null/sealed/one-sided cards. Lives beside rawPriceUsd because the two are coupled: for a card in
 *  the [$10, $25) band rawPriceUsd prices the print from the eBay average, and it is exactly this
 *  gate's agreement check that makes that smoothed price trustworthy at listing time. */
export const MIN_LIST_PRICE_USD = 10;
const PRICE_AGREEMENT_TOLERANCE = 0.25;

export function isListable(c: TplCard): boolean {
  const nm = c.prices?.raw?.near_mint;
  const spot = nm?.tcgplayer?.market ?? 0;
  const smooth = nm?.ebay?.avg_7d ?? 0;
  return spot >= MIN_LIST_PRICE_USD && smooth > 0 && Math.abs(smooth / spot - 1) <= PRICE_AGREEMENT_TOLERANCE;
}

/** The raw spot in USD per the plan's fallback chain + thin-market smoothing. 0 = ineligible.
 *  Takes just the prices envelope so the history seeder can price past days through the SAME chain. */
export function rawPriceUsd(card: Pick<TplCard, 'prices'>): number {
  for (const cond of CONDITION_ORDER) {
    const c = card.prices?.raw?.[cond];
    if (!c) continue;
    const spot = c.tcgplayer?.market ?? 0;
    const smooth = c.ebay?.avg_7d ?? 0;
    if (spot >= LIQUID_THRESHOLD_USD) return spot; // liquid: the TCGplayer market price
    if (smooth > 0) return smooth; // thin: a 7d average a single relisting can't move
    if (spot > 0) return spot; // thin with no eBay data: take the spot
  }
  return 0;
}

/** The provider serializes tcgplayer_id as a STRING (verified live) — normalize in ONE place. */
export function tplTcgplayerId(c: TplCard): number | null {
  return c.tcgplayer_id != null && c.tcgplayer_id !== '' ? Number(c.tcgplayer_id) : null;
}

/** The one graded-price chain: ebay avg_7d (stable) -> avg_1d -> avg_30d -> null. */
function ebayAvgUsd(e: { avg_1d?: number; avg_7d?: number; avg_30d?: number } | undefined): number | null {
  const v = e?.avg_7d ?? e?.avg_1d ?? e?.avg_30d;
  return v != null && v > 0 ? v : null;
}

/** PSA-10 in USD (drives the Graded index + the markets.graded_psa10_e6 column). */
export function gradedPsa10Usd(card: TplCard): number | null {
  return ebayAvgUsd(card.prices?.graded?.psa?.['10']?.ebay);
}

/** One rung of the graded-price ladder (PSA 10 / BGS 9.5 / …) for the market-details panel. */
export interface GradeRow {
  grader: string; // 'PSA' | 'BGS' | 'CGC' | …
  grade: string; // '10', '9.5', …
  priceE6: string;
}

const GRADER_ORDER: Record<string, number> = { PSA: 0, BGS: 1, CGC: 2 };

/** The full grade ladder out of this provider's graded prices object ({ psa: { '10': { ebay: … }}, …}),
 *  each rung priced through the same chain as the PSA-10 oracle price. Sorted PSA/BGS/CGC (other
 *  graders after, alphabetical), grade desc. Grade keys are VALIDATED to (0, 10]: the live data
 *  contains mis-parsed listings (a verified 'psa.104' — the card's collector number read as a grade). */
export function gradeLadder(graded: unknown): GradeRow[] {
  if (!graded || typeof graded !== 'object') return [];
  const rows: GradeRow[] = [];
  for (const [grader, grades] of Object.entries(graded as NonNullable<NonNullable<TplCard['prices']>['graded']>)) {
    if (!grades || typeof grades !== 'object') continue;
    for (const [grade, src] of Object.entries(grades)) {
      const g = Number(grade);
      if (!Number.isFinite(g) || g <= 0 || g > 10) continue;
      const v = ebayAvgUsd(src?.ebay);
      if (v != null) rows.push({ grader: grader.toUpperCase(), grade, priceE6: toE6(v).toString() });
    }
  }
  return rows.sort(
    (a, b) =>
      (GRADER_ORDER[a.grader] ?? 9) - (GRADER_ORDER[b.grader] ?? 9) ||
      a.grader.localeCompare(b.grader) ||
      Number(b.grade) - Number(a.grade),
  );
}

/** The tracked market row a provider card re-prices. Identity (game/symbol/card_id) comes from OUR
 *  market row — never from the provider — so backfilled legacy markets are re-priced IN PLACE. */
export interface TrackedMarket {
  provider_card_id: string;
  symbol: string;
  card_id: string;
  game: string;
  featured: boolean; // index-constituent eligibility — owned by the discovery job, read-only here
}

/** Join one provider card onto its tracked market identity and emit the OracleCard. */
export function fromTplCard(c: TplCard, t: TrackedMarket): OracleCard {
  const graded = gradedPsa10Usd(c);
  return {
    game: t.game,
    symbol: t.symbol,
    cardId: t.card_id,
    tcgplayerId: tplTcgplayerId(c),
    providerCardId: c.id,
    displayName: formatDisplayName(c.name, c.number),
    variant: c.variant,
    imageSmall: c.image_url,
    imageLarge: c.image_url, // the provider serves one asset; both slots point at it
    metadata: { setName: c.set?.name ?? null, setSlug: c.set?.slug ?? null, rarity: c.rarity ?? null }, // setSlug keys the release-year cache
    rawE6: toE6(rawPriceUsd(c)),
    gradedE6: graded != null ? toE6(graded) : null,
    observedAt: c.updated_at ? new Date(c.updated_at) : null, // provider freshness -> print dedup + staleness gate
    payload: { tcgpricelookup: { prices: c.prices ?? null, updated_at: c.updated_at ?? null } },
    featured: t.featured,
  };
}

let defaultClient: TcgPriceLookupClient | null = null;

/** The process-wide client (one ProviderLimiter, so search/refresh/discovery priority preemption
 *  actually works across loops — separate instances would only share the DB pacing, not the queue). */
export function getDefaultClient(db: Db): TcgPriceLookupClient {
  return (defaultClient ??= new TcgPriceLookupClient(db));
}

/** Live fetcher behind ORACLE_PRIMARY=tcgpricelookup: batch-fetch every tracked market's provider card
 *  and emit OracleCards keyed by the markets' OWN identity. Cards the provider no longer returns are
 *  simply absent (no print -> the staleness halt covers them). */
export async function fetchTrackedCards(db: Db, client?: TcgPriceLookupClient): Promise<OracleCard[]> {
  const tpl = client ?? getDefaultClient(db);
  const tracked = await db.query<TrackedMarket>(
    `SELECT provider_card_id, symbol, card_id, game, featured FROM markets
      WHERE kind = 'card' AND provider_card_id IS NOT NULL AND status != 'delisted'`,
  );
  if (tracked.rows.length === 0) return [];
  const byId = new Map(tracked.rows.map((t) => [t.provider_card_id, t]));
  const cards = await tpl.getCardsByIds([...byId.keys()], 'refresh');
  // Surface tracked cards the provider stopped returning — they get no print and will hit the
  // staleness halt; without this they vanish silently until that fires (P5 monitoring).
  if (cards.length < byId.size) {
    const returned = new Set(cards.map((c) => c.id));
    const absent = [...byId.keys()].filter((id) => !returned.has(id));
    console.warn(
      `tcgpricelookup: ${absent.length}/${byId.size} tracked cards absent from the response ` +
        `(no print; staleness halt covers them): ${absent.slice(0, 5).join(', ')}${absent.length > 5 ? '…' : ''}`,
    );
  }
  return cards.flatMap((c) => {
    const t = byId.get(c.id);
    return t ? [fromTplCard(c, t)] : []; // unknown id in the response — ignore, never invent identity
  });
}
