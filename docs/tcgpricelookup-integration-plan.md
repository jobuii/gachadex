# tcgpricelookup integration plan

Replace the pokemontcg.io (raw) + JustTCG (graded) feeds with **tcgpricelookup** (Trader plan) as the
primary price source, across **Pokémon + One Piece + MTG**, and add a **search-and-bet** feature so
users can trade any card, not just the featured top-250. Provider spec: `docs/data-providers.md`.

## Constraints that shape the design (verified live 2026-06-11)

- **No price sort.** `search` filters by `q` / `game` / `set` only and returns results
  **alphabetically**; no-`q` browse returns the *whole* catalog (46,543 Pokémon cards, many null-priced).
  So we can't fetch "top-250 by price" in one call — the tracked universe must be a set **we maintain**.
- **Rate limit 1 req/s** (burst 1, `retry-after: 1`), Cloudflare-fronted; 10,000 requests/day (Trader).
- **Raw + graded come back together** in one card object — no separate graded round-trip needed.
- All USD. Card fields confirmed live: `id`, `tcgplayer_id`, `name`, `number`, `rarity`, `image_url`,
  `set.name`, `game.slug`, `prices.raw.<cond>.tcgplayer.{market,low,mid,high}`,
  `prices.raw.<cond>.ebay.{avg_1d,7d,30d}`, `prices.graded.<psa|bgs|cgc>.<grade>.ebay.{avg_1d,7d,30d}`.

## Architecture

1. **Normalize the oracle.** `ingest` (`oracle.ts:114`) is hard-wired to the pokemontcg shape
   (`getCardPrice`, `pickVariant`, `extractMetadata`, `game:'pokemon'` at line 132). Introduce a
   provider-agnostic type and have each fetcher emit it:
   ```ts
   interface OracleCard {
     game: 'pokemon' | 'onepiece' | 'mtg';
     cardId: string;            // provider id (stable market symbol)
     tcgplayerId?: number | null;
     displayName: string; number: string | null; rarity: string | null; setName: string | null;
     imageSmall: string | null; imageLarge: string | null;
     rawE6: bigint;             // raw NM market price (the tradeable spot)
     gradedE6: bigint | null;   // PSA-10 (ebay avg_7d), inline — no separate fetch
   }
   ```
   `ingest` consumes `OracleCard[]`; provider-specific extraction moves into each fetcher. Existing
   injectable-fetcher tests stay green.

2. **Provider fetchers** (all return `OracleCard[]`):
   - `tcgpricelookupFetcher(game)` — **primary**. Maps `raw.near_mint.tcgplayer.market → rawE6`,
     `graded.psa.10.ebay.avg_7d → gradedE6`.
   - `pokemontcgFetcher` (today's `fetchTopCards`) — Pokémon raw fallback.
   - JustTCG graded — fallback (kept).

3. **Tracked universe = the card markets.** Stable and **append-only** (a perps market must not vanish
   when a card's price rank drops). Two jobs:
   - **Refresh loop (frequent, ~daily):** fetch current prices for all tracked `card_id`s (batch
     ≤20/request if supported, else per-card), update raw + graded, recompute the Top-100/250 indices
     (top-N by price *of the tracked set*).
   - **Discovery job (periodic, ~weekly):** enumerate a game (no-`q`, paginate 100/page), filter to
     high-value (raw NM ≥ threshold), take the top ~250, **add** new cards as markets. Never removes.

## Feature 1 — Tracked universe: top-250 by price per game

- **Seed (one-time):** run discovery per game — crawl the catalog, keep priced cards, sort client-side,
  take the top 250. ~20 min one-time crawl across the 3 games at 1 req/s (background job, not the hot
  loop). Pokémon set gets re-derived on price (similar to today's pokemontcg top-250).
- The Top-100 / Top-250 indices are the existing divisor-based baskets (`buildIndex`), now computed
  from the tracked set per game.

## Feature 2 — Search & bet (on-demand markets)

Let users trade **any** card, not just the featured 250.

- **Search:** `GET /cards/search?q=&game=` (backend) → proxies tcgpricelookup search, **cached** by
  `(q, game)` for ~1h, **paced** at 1 req/s. Returns name, image, set, current raw price (+ graded).
- **Bet:** user picks a result → `POST /markets/ensure` (authed) with the provider card id → backend:
  if no market exists for that card, build one from the search result (it already carries the price),
  `upsertCardMarket`, mark it **tracked**, record the first oracle print + mark → returns the market id.
  Now tradeable; it joins the refresh loop and is priced daily thereafter.
- The universe grows organically with whatever users want to trade (the long tail).

## Phases

- **P1 — client + key + pacer.** tcgpricelookup HTTP client, `config.tcgpricelookupApiKey`
  (env `TCGPRICELOOKUP_API_KEY`, Railway only), a shared 1 req/s pacer + a small response cache.
  Confirm the batch-by-IDs format. Read-only, no behavior change.
- **P2 — normalize.** `OracleCard` type; refactor `ingest` to consume it; move pokemontcg extraction
  into `pokemontcgFetcher`. Tests stay green.
- **P3 — tcgpricelookup fetcher** (raw + graded inline), per game, with pacing + fallbacks kept.
- **P4 — discovery job** (enumerate + filter + add markets) for One Piece + MTG, plus Pokémon top-up.
- **P5 — cutover + monitor.** Switch the oracle loop to tcgpricelookup; pokemontcg/JustTCG stay fallback.
- **P6 — search & bet:** the search proxy (cached/paced) + `markets/ensure` on-demand creation + the
  frontend search-and-trade flow.

## Rate limits, caching, budget

- **Refresh:** ~750 tracked cards (250 × 3) via batch-of-20 ≈ 38 req (~40s/day). Per-card fallback ≈ 12
  min/day. Both far under 10,000/day.
- **Discovery:** ~1,400 pages full crawl (~23 min) — weekly background job.
- **Search (user-facing):** **must be cached** — cache `(q, game)` results (TTL ~1h) so repeat searches
  don't hit the API; the 1 req/s pacer serializes uncached calls. At self-test traffic this is fine; at
  scale, cache aggressively and/or move to the Business tier (100k/day, 3 req/s).

## Risk notes (long-tail markets)

On-demand cards can be low-value / illiquid. The existing risk machinery applies (adaptive depth, NAV
OI caps, pool-health gates). Consider a **market tier**: featured top-250 get normal leverage; on-demand
long-tail cards get tighter caps (lower max leverage / higher initial margin) until they prove volume.
Decide during P6.

## Config & secrets

- `TCGPRICELOOKUP_API_KEY` — Railway env only, **never** committed. `X-API-Key` header.
- `TCGPRICELOOKUP_BASE` = `https://api.tcgpricelookup.com/v1`.
- Reuse `gradedConstituents` for the graded index size; add a discovery price threshold + tracked-count
  per game.

## Testing

Keep the injectable-fetcher pattern: unit-test `ingest` with a fake `OracleCard[]` (no network); test the
tcgpricelookup mapper against a captured JSON fixture; test `markets/ensure` idempotency (same card →
same market, no double-create); test the search cache (second call doesn't hit the API).
