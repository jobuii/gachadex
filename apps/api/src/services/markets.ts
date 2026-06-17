import { randomUUID } from 'node:crypto';
import type { Db, Queryer } from '../db/client.ts';
import { usdc } from '../money.ts';
import { getFeeBps, getFundingFactorBps } from './fees.ts';
import { gradeLadder, type GradeRow } from './providers/tcgpricelookup.ts';

// Per-side open-interest caps (risk parameters). Indices are diversified -> deeper books.
const CARD_OI_CAP = usdc(50_000).toString();
const INDEX_OI_CAP = usdc(250_000).toString();

/** Market row with all BIGINT columns surfaced as decimal strings. */
export interface MarketRow {
  id: string;
  kind: 'card' | 'index';
  game: string;
  symbol: string;
  display_name: string;
  card_id: string | null;
  variant: string | null;
  index_slug: string | null;
  image_small: string | null;
  set_logo: string | null;
  status: string;
  tradeable: boolean;
  max_leverage_e2: number;
  init_margin_bps: number;
  maint_margin_bps: number;
  max_oi_long_uusdc: string;
  max_oi_short_uusdc: string;
  skew_k_e6: string;
  premium_cap_e6: string;
  max_dev_bps: number;
  min_qty_e6: string;
  qty_step_e6: string;
  price_tick_e6: string;
  price_pinned: boolean;
  low_confidence: boolean;
  mark_clamped: boolean; // mark guard engaged right now (§6a) — the prior-state input to recomputeMark's clamp
  featured: boolean;
}

const COLS = `id, kind, game, symbol, display_name, card_id, variant, index_slug, image_small, set_logo, status, tradeable,
  max_leverage_e2, init_margin_bps, maint_margin_bps,
  max_oi_long_uusdc::text AS max_oi_long_uusdc, max_oi_short_uusdc::text AS max_oi_short_uusdc,
  skew_k_e6::text AS skew_k_e6, premium_cap_e6::text AS premium_cap_e6, max_dev_bps,
  min_qty_e6::text AS min_qty_e6, qty_step_e6::text AS qty_step_e6, price_tick_e6::text AS price_tick_e6, price_pinned, low_confidence, mark_clamped, featured`;

export async function getMarketById(q: Queryer, id: string): Promise<MarketRow | null> {
  const r = await q.query<MarketRow>(`SELECT ${COLS} FROM markets WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export interface CardUpsert {
  game?: string; // 'pokemon' | 'onepiece' | 'mtg' (defaults to pokemon)
  symbol: string;
  cardId: string;
  displayName: string;
  variant: string | null;
  imageSmall: string | null;
  imageLarge?: string | null;
  setLogo?: string | null;
  metadata?: unknown;
  // Stable cross-provider identity (see schema). Optional: the legacy pokemontcg feed doesn't know
  // them; tcgpricelookup supplies both. Never erased on re-upsert (COALESCE keeps the stored value).
  tcgplayerId?: number | null;
  providerCardId?: string | null;
  // Index-constituent eligibility (the discovery top-250). Omit to keep the stored value.
  featured?: boolean | null;
  // Creation-only: minimum order size (P6 dollar-min-notional for long-tail listings). Never
  // touched on re-upsert — the operator may retune a live market's min.
  minQtyE6?: bigint | null;
}

/** Symbol for a provider-created card market: game-namespaced so provider ids can never collide across
 *  games or with the `INDEX:` namespace. Legacy pokemontcg markets keep their bare `c.id` symbols (the
 *  upsert key for the live feed) — cutover joins them via tcgplayer_id/provider_card_id, not symbol. */
export function cardSymbol(game: string, providerCardId: string): string {
  return `${game}:${providerCardId}`;
}

export async function upsertCardMarket(q: Queryer, opts: CardUpsert): Promise<string> {
  const id = randomUUID();
  const meta = opts.metadata != null ? JSON.stringify(opts.metadata) : null;
  await q.query(
    `INSERT INTO markets(id, kind, game, symbol, display_name, card_id, variant, image_small, image_large, set_logo, metadata, tradeable,
       max_oi_long_uusdc, max_oi_short_uusdc, tcgplayer_id, provider_card_id, featured, min_qty_e6)
     VALUES($1, 'card', $11, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $10, $12, $13, COALESCE($14, false), COALESCE($15, 10000))
     ON CONFLICT(symbol) DO UPDATE
       SET display_name = EXCLUDED.display_name, image_small = EXCLUDED.image_small, image_large = EXCLUDED.image_large,
           set_logo = EXCLUDED.set_logo, metadata = EXCLUDED.metadata, variant = EXCLUDED.variant,
           tcgplayer_id = COALESCE(EXCLUDED.tcgplayer_id, markets.tcgplayer_id),
           provider_card_id = COALESCE(EXCLUDED.provider_card_id, markets.provider_card_id),
           featured = COALESCE($14, markets.featured)`,
    [
      id, opts.symbol, opts.displayName, opts.cardId, opts.variant, opts.imageSmall, opts.imageLarge ?? null,
      opts.setLogo ?? null, meta, CARD_OI_CAP, opts.game ?? 'pokemon', opts.tcgplayerId ?? null, opts.providerCardId ?? null,
      opts.featured ?? null, opts.minQtyE6?.toString() ?? null,
    ],
  );
  const r = await q.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [opts.symbol]);
  return r.rows[0].id;
}

export async function upsertIndexMarket(
  q: Queryer,
  opts: { game: string; slug: string; name: string; tradeable: boolean },
): Promise<string> {
  const id = randomUUID();
  // Pokémon keeps its original un-namespaced symbol (back-compat, preserves history); other games are
  // namespaced so e.g. One Piece 'top-100' can't collide with Pokémon's.
  const symbol = opts.game === 'pokemon' ? `INDEX:${opts.slug}` : `INDEX:${opts.game}:${opts.slug}`;
  const oi = INDEX_OI_CAP;
  await q.query(
    `INSERT INTO markets(id, kind, game, symbol, display_name, index_slug, tradeable,
       max_oi_long_uusdc, max_oi_short_uusdc, max_dev_bps)
     VALUES($1, 'index', $7, $2, $3, $4, $5, $6, $6, 1000)
     ON CONFLICT(symbol) DO UPDATE
       SET display_name = EXCLUDED.display_name, tradeable = EXCLUDED.tradeable`,
    [id, symbol, opts.name, opts.slug, opts.tradeable, oi, opts.game],
  );
  const r = await q.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [symbol]);
  return r.rows[0].id;
}

/** Markets list for the API: latest mark + index + 24h change (off the marks series). */
export interface MarketView {
  id: string;
  kind: 'card' | 'index';
  game: string;
  symbol: string;
  displayName: string;
  cardId: string | null;
  indexSlug: string | null;
  imageSmall: string | null;
  setLogo: string | null;
  status: string;
  tradeable: boolean;
  maxLeverage: number;
  maintMarginBps: number;
  feeBps: number;
  fundingFactorBps: number; // operator-set max hourly funding rate at full skew; client scales by live skew
  qtyStepE6: string;
  minQtyE6: string;
  markE6: string | null;
  indexE6: string | null;
  change24hPct: number;
  pricePinned: boolean;
  restricted: boolean; // low price confidence -> reduce-only (no new positions); see priceCard
  markStabilizing: boolean; // §6a mark guard engaged: the mark is creeping toward an uncorroborated jump (price stabilizing)
  featured: boolean; // top-250-by-price member (the sidebar's default card list)
}

/** Per-market details (card metadata + graded prices) for the detail panel. */
export interface MarketDetails {
  imageLarge: string | null;
  setLogo: string | null;
  variant: string | null; // printing ('Standard', 'Holofoil', …) — the market row's own column
  metadata: unknown; // { setName, setSlug, rarity }
  gradedPsa10E6: string | null;
  grades: GradeRow[]; // full ladder from the latest provider print; [] until one carries graded data
  releaseYear: number | null; // the card's set release year (from the tcg_sets cache); null if unknown
}

export async function getMarketDetails(db: Db, id: string): Promise<MarketDetails | null> {
  // The latest accepted print's archived payload carries the provider's whole graded object (PSA/BGS/
  // CGC × grade); markets columns only persist the PSA-10 the graded index needs. Project just the
  // graded subtree — the full payload is the entire provider print. release_year joins the cached set
  // metadata by slug first (precise), falling back to game+name so already-listed markets resolve too.
  const [r, p] = await Promise.all([
    db.query<{ image_large: string | null; set_logo: string | null; variant: string | null; metadata: unknown; graded: string | null; release_year: number | null }>(
      `SELECT m.image_large, m.set_logo, m.variant, m.metadata, m.graded_psa10_e6::text AS graded,
              COALESCE(
                (SELECT release_year FROM tcg_sets WHERE game = m.game AND slug = m.metadata->>'setSlug'),
                (SELECT release_year FROM tcg_sets WHERE game = m.game AND name = m.metadata->>'setName' ORDER BY slug LIMIT 1)
              ) AS release_year
         FROM markets m WHERE m.id = $1`,
      [id],
    ),
    db.query<{ graded: unknown }>(
      // Latest accepted print THAT CARRIES a graded object — a manual admin print or a legacy
      // pokemontcg print on top must not blank the ladder until the next provider print.
      `SELECT raw_payload #> '{tcgpricelookup,prices,graded}' AS graded
         FROM oracle_prices WHERE market_id = $1 AND is_accepted
          AND raw_payload #> '{tcgpricelookup,prices,graded}' IS NOT NULL
        ORDER BY source_observed_at DESC LIMIT 1`,
      [id],
    ),
  ]);
  const row = r.rows[0];
  if (!row) return null;
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? null);
  const graded = p.rows[0]?.graded;
  const grades = gradeLadder(typeof graded === 'string' ? JSON.parse(graded) : graded);
  return {
    imageLarge: row.image_large, setLogo: row.set_logo, variant: row.variant, metadata,
    gradedPsa10E6: row.graded, grades, releaseYear: row.release_year ?? null,
  };
}

export async function listMarketsWithData(db: Db): Promise<MarketView[]> {
  const markets = await db.query<MarketRow>(`SELECT ${COLS} FROM markets ORDER BY kind DESC, display_name`);

  const latest = await db.query<{ market_id: string; mark_e6: string; index_e6: string }>(
    `SELECT DISTINCT ON (market_id) market_id, mark_price_e6::text AS mark_e6, index_price_e6::text AS index_e6
     FROM marks ORDER BY market_id, computed_at DESC`,
  );
  const latestMap = new Map(latest.rows.map((r) => [r.market_id, r]));

  // 24h change, computed from the SAME mark series the chart + displayed price use (`marks` by
  // computed_at) — NOT oracle_prices by source_observed_at. The provider's source_observed_at can be
  // static/backdated, so that ordering disagreed with the marks the user actually sees and reported
  // 0% for cards whose chart had clearly moved. Reference = the last mark at/before now-24h.
  const ref = await db.query<{ market_id: string; ref: string }>(
    `SELECT DISTINCT ON (market_id) market_id, mark_price_e6::text AS ref
     FROM marks WHERE computed_at <= now() - interval '24 hours'
     ORDER BY market_id, computed_at DESC`,
  );
  const changeMap = new Map<string, number>();
  for (const r of ref.rows) {
    const cur = latestMap.get(r.market_id)?.mark_e6;
    if (cur && BigInt(r.ref) !== 0n) {
      const change = (Number(BigInt(cur) - BigInt(r.ref)) / Number(BigInt(r.ref))) * 100;
      changeMap.set(r.market_id, Math.round(change * 100) / 100);
    }
  }

  return markets.rows.map((m) => {
    const l = latestMap.get(m.id);
    return {
      id: m.id,
      kind: m.kind,
      game: m.game,
      symbol: m.symbol,
      displayName: m.display_name,
      cardId: m.card_id,
      indexSlug: m.index_slug,
      imageSmall: m.image_small,
      setLogo: m.set_logo,
      status: m.status,
      tradeable: m.tradeable,
      maxLeverage: Math.round(m.max_leverage_e2 / 100),
      maintMarginBps: m.maint_margin_bps,
      feeBps: getFeeBps(), // live trading fee (same global knob for every market); lets clients preview the real fee
      fundingFactorBps: getFundingFactorBps(), // live funding factor; the client estimates the rate from live OI skew
      qtyStepE6: m.qty_step_e6,
      minQtyE6: m.min_qty_e6,
      markE6: l?.mark_e6 ?? null,
      indexE6: l?.index_e6 ?? null,
      change24hPct: changeMap.get(m.id) ?? 0,
      pricePinned: m.price_pinned,
      restricted: m.low_confidence,
      markStabilizing: m.mark_clamped, // §6a mark guard engaged — show the "price stabilizing" badge
      featured: m.featured,
    };
  });
}

export interface Candle {
  time: number; // UTC unix seconds (bucket start)
  value: number; // = close (back-compat: line/area/baseline read this)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // traded notional (USD) in the bucket; 0 when nothing traded
}

/**
 * Real price history for the chart, from the `marks` series. Buckets are intraday (hourly) for short
 * windows and daily for longer ones; each bucket's value is its last mark (the close). NO synthetic /
 * fabricated data — the only non-mark series is the provider-seeded PRE-listing history (chart_seed),
 * which renders strictly before the market's first real mark; marks always win from then on.
 */
export async function getCandles(db: Db, marketId: string, days: number): Promise<Candle[]> {
  const bucket = days <= 7 ? 'hour' : 'day'; // intraday for 1D/1W, daily for 1M+
  // Seeded days are capped at the day BEFORE the first mark, so the two series can never collide on
  // a bucket (lightweight-charts requires strictly ascending times). Every date cast is pinned to
  // UTC like the mark buckets are — a non-UTC session TimeZone must not shift the cutoff day.
  // price_e6 > 0 drops the "provider had no history" sentinel rows.
  const r = await db.query<{ t: string; o: string; h: string; l: string; c: string }>(
    `SELECT t::text AS t, o::text AS o, h::text AS h, l::text AS l, c::text AS c FROM (
       SELECT extract(epoch FROM date_trunc($3, computed_at AT TIME ZONE 'UTC'))::bigint AS t,
              (array_agg(mark_price_e6 ORDER BY computed_at ASC))[1] AS o,  -- open  = first mark in the bucket
              max(mark_price_e6) AS h,                                       -- high
              min(mark_price_e6) AS l,                                       -- low
              (array_agg(mark_price_e6 ORDER BY computed_at DESC))[1] AS c   -- close = last mark
         FROM marks WHERE market_id = $1 AND computed_at > now() - ($2 || ' days')::interval
        GROUP BY 1
       UNION ALL
       -- seeded pre-listing days are a single daily price → flat OHLC
       SELECT extract(epoch FROM day::timestamp)::bigint, price_e6, price_e6, price_e6, price_e6
         FROM chart_seed
        WHERE market_id = $1 AND price_e6 > 0
          AND day > ((now() AT TIME ZONE 'UTC') - ($2 || ' days')::interval)::date
          AND day < COALESCE(
                (SELECT (min(computed_at) AT TIME ZONE 'UTC')::date FROM marks WHERE market_id = $1),
                'infinity'::date)
     ) series ORDER BY t`,
    [marketId, String(days), bucket],
  );
  // Traded volume (USD notional) per bucket, from fills — same UTC bucketing as the candles.
  const vol = await db.query<{ t: string; usd: string }>(
    `SELECT extract(epoch FROM date_trunc($3, created_at AT TIME ZONE 'UTC'))::bigint::text AS t,
            (sum(qty_e6::numeric * exec_price_e6::numeric) / 1000000000000)::text AS usd
       FROM fills WHERE market_id = $1 AND created_at > now() - ($2 || ' days')::interval
      GROUP BY 1`,
    [marketId, String(days), bucket],
  );
  const volByT = new Map(vol.rows.map((v) => [v.t, Number(v.usd)]));
  return r.rows.map((row) => {
    const e6 = (s: string) => Number(s) / 1_000_000;
    return {
      time: Number(row.t),
      value: e6(row.c),
      open: e6(row.o),
      high: e6(row.h),
      low: e6(row.l),
      close: e6(row.c),
      volume: volByT.get(row.t) ?? 0,
    };
  });
}
