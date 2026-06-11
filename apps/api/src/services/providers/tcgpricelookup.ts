import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { ProviderLimiter, sleep, type ProviderPriority } from './limiter.ts';

/**
 * tcgpricelookup HTTP client (Trader plan; spec in docs/data-providers.md). HTTP layer only — the
 * OracleCard fetcher that maps these responses lands in P3. Every request flows through the global
 * ProviderLimiter (1 req/s + daily budget, enforced via the DB across instances) and retries
 * transient failures (429 honoring retry-after, 5xx, Cloudflare challenges) with exponential
 * backoff + jitter. Each retry re-claims a limiter slot — retries are real requests too.
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
