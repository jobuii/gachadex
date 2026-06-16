# Build spec — Scrydex-primary pricing (Option B)

Implementation plan for the pricing redesign decided in `docs/price_discovery.md` ("Next approach —
Scrydex-primary pricing"). Evaluation + data: `docs/scrydex-evaluation.md`. **Status: spec only, no code
yet.**

## 1. Goal & scope

Replace the median-of-three (which lets tcgpl's eBay outvote the correct TCGplayer price) with a
**TCGplayer-anchored price from Scrydex (primary) + tcgpricelookup (secondary)**, plus a **trust-score
confidence gate** that keeps every existing safety layer and adds a real cross-venue check.

**In scope:** raw card pricing + confidence; the Scrydex adapter; provider orchestration (Scrydex primary,
tcgpl secondary); fallbacks; tests; flag-gated rollout.
**Out of scope (follow-on phases, noted §11):** graded via Scrydex ladder + pop reports; sealed products;
webhooks (replace the cron); Vision. The mark engine, hybrid dedup, staleness breaker, manual pin, and
engine gap controls are unchanged.

## 2. Architecture / data flow

Today one provider feeds `priceCard`. Option B needs BOTH feeds per card per pass — Scrydex for the price,
tcgpl for the eBay cross-check — joined by `tcgplayer_id`:

```
per tracked card:
  Scrydex (by scrydex_card_id)  ─┐
  tcgpl   (by provider_card_id) ─┴─▶ combinePrice() ─▶ { priceUsd, confidence{score,tier}, components }
                                       ├─ price  = Scrydex TCGplayer market (NM→LP→MP) ?? tcgpl TCGplayer ?? pin
                                       └─ tier   = trust score → tradeable | reduce_only | halted
                                              │
                                              ▼  (unchanged downstream)
                                     recordOracle (hybrid dedup) ─▶ recomputeMark ─▶ mark ─▶ chart/24h
                                     applyConfidence (low_confidence ⇔ tier != tradeable)
```

## 3. Scrydex adapter (`apps/api/src/services/providers/scrydex.ts`, new)

- **Auth/env:** headers `X-Api-Key: SCRYDEX_API_KEY`, `X-Team-ID: SCRYDEX_TEAM_ID`. Base
  `https://api.scrydex.com`.
- **Game slugs:** `pokemon`, `onepiece`, **`magicthegathering`** (verified; NOT `mtg`/`magic`). Map our
  `game` (`pokemon|onepiece|mtg`) → slug.
- **Endpoints:** search `GET /{slug}/v1/cards?q=&include=prices&page=&pageSize=` (envelope
  `{data,page,page_size,count,total_count}`); single `GET /{slug}/v1/cards/{id}?include=prices`.
- **Parse:** prices live under `variants[]` → match the variant whose `marketplaces[].product_id ==
  tcgplayer_id`; in that variant's `prices[]`, take `type=raw`, condition NM→LP→MP, fields
  `market/low/mid/high`, `currency`, `trends.days_1.percent_change`.
- **Rate/credits:** confirm the $99 plan's credit cost per request + daily/rate budget (docs: "API
  Credits", "Rate Limits") and size the refresh to it. Retry on 429 with backoff (mirror the tcgpl
  client).

### 3a. The fetch-by-our-ids problem (key decision)

Scrydex search is by name/Lucene DSL, not by our `tcgplayer_id`. Two ways to fetch prices for our ~751
specific cards efficiently:
- **Recommended: one-time match → store `scrydex_card_id`.** A backfill (like the chart-history seeder)
  searches each tracked card by name, matches the variant `product_id == tcgplayer_id`, and stores
  `markets.scrydex_card_id`. Steady-state refresh then fetches by that id. Unmatched cards → NULL → fall
  back to tcgpl.
- **Verify first:** does the Scrydex DSL support a tcgplayer/external-id filter (e.g. `q=tcgplayer:<id>`
  or a batch ids param)? If yes, skip the stored-id step and batch-fetch by our ids. (DSL is known to
  support `language:`, `types:`, `subtypes:` — confirm an id filter.)

## 4. Provider orchestration

- New config flag `PRICE_PRIMARY = scrydex | tcgpricelookup` (default `scrydex` once live). When
  `scrydex`: each refresh fetches Scrydex by `scrydex_card_id` for the price + tcgpl (existing fetcher)
  for the eBay/TCGplayer cross-check, joins by `tcgplayer_id`, calls `combinePrice`.
- tcgpl "secondary if available": if tcgpl returns nothing for a card, confidence simply loses the eBay
  + cross-feed inputs (degrades, doesn't fail). If **Scrydex** returns nothing, price falls back to
  tcgpl TCGplayer market.

## 5. Price computation (`combinePrice`)

`priceUsd` = first non-null of: Scrydex TCGplayer `market` (NM→LP→MP) → tcgpl TCGplayer `market` (same
condition order) → operator manual pin → keep-last (and flag stale) / unpriced→halt. **eBay is never a
price input.** Round to the $0.01 tick (`cents`). Currency: use USD entries; a JP-only printing →
FX (Frankfurter JPY→USD) if enabled, else flag low-confidence and prefer tcgpl USD.

## 6. Confidence rubric (Option B) — `scoreConfidence`

Each check contributes; **starting thresholds, tunable.** Inputs: `price` (chosen), `sxMarket`,
`tcgpMarket`, `ebay1d`, Scrydex `low`/`high`, `trends.days_1`.

| # | Check | Condition | Points |
|---|---|---|---|
| C1 | Cross-feed stability | both Scrydex & tcgpl TCGplayer present and within ±15% | +2 |
| C2 | Cross-venue (eBay) | eBay `avg_1d` present and within **0.5×–1.3×** of price | +2 |
| C3 | Spread tightness | Scrydex `(high−low)/market` ≤ 0.5 | +1 |
| C4 | Trend sanity | `|days_1| ≤ 40%`, OR a corroborator moved with it | +1 |
| C5 | Freshness | priced from a live fetch this pass | +1 |

**Override:** an **uncorroborated day-1 spike** (`|days_1| > 40%` and neither eBay nor cross-feed moved
similarly) → force **reduce_only** regardless of score (the manipulation gate).

**Tier mapping:** score **≥ 4 → tradeable**; **2–3 → reduce_only**; **< 2 or no usable price → halted**.

**No-corroborator default** (only TCGplayer present — ~30% of cards have no eBay): C1/C2 unavailable, so
lean on C3 (spread tight) + C5 → tradeable if the spread is tight, else reduce_only. *(Decision: confirm
this lean-permissive default vs lean-conservative.)*

Map to existing state: `tradeable ⇒ low_confidence=false`; `reduce_only/halted ⇒ low_confidence=true`
(reuse `applyConfidence`, which already logs flips to `market_restriction_events`). The staleness breaker
still owns the `reduce_only` status for feed-down separately.

## 7. Fallbacks & coverage

- **Scrydex misses the card** (unmatched product_id / promo / serialized): price from tcgpl TCGplayer;
  confidence loses the Scrydex-specific inputs (C3/C4) but keeps C1-via-tcgpl + C2.
- **Both miss / no price:** keep-last + halt (the Mew★δ case), or manual pin.
- **Vintage (no NM):** condition fallback NM→LP→MP (Scrydex prices lower grades; e.g. Black Lotus
  Unlimited has price only at DM). Define the per-condition order once.
- **JP-only:** FX or flag (see §5).

## 8. Freshness / dedup / staleness

Scrydex exposes no per-price provider timestamp (only `trends`). So for the Scrydex path use the **ingest
wall-clock** as `observedAt`; the **hybrid dedup** (record on new timestamp OR changed value) then writes
a print whenever the Scrydex value moves — unchanged code. The **36h staleness breaker** keys on "did a
print land" as today; a card Scrydex stops returning (and tcgpl can't cover) ages into reduce_only
correctly. The chart 24h-change can additionally surface Scrydex `trends.days_1` directly.

## 9. Schema changes (`apps/api/src/db/schema.sql`, idempotent)

- `ALTER TABLE markets ADD COLUMN IF NOT EXISTS scrydex_card_id TEXT;` — the matched Scrydex id (for
  fetch-by-id). Index if we query by it.
- Optional: persist the confidence components on the oracle print's `raw_payload` (audit) — no column
  needed.

## 10. Config & flags (`apps/api/src/config.ts`)

`SCRYDEX_API_KEY`, `SCRYDEX_TEAM_ID`, `SCRYDEX_BASE` (default the live base), `PRICE_PRIMARY`
(`scrydex`|`tcgpricelookup`, default current until cutover), FX config (reuse the speced Frankfurter),
and the rubric thresholds as live-tunable knobs (`liveKnob`) so confidence can be tuned without a deploy.

## 11. Tests (`apps/api/src/services/providers/scrydex.test.ts` + pricing tests)

- Adapter: parse the `variants[]→prices[]` shape; match by product_id; currency; NM→LP→MP fallback; 429
  retry; the 3 game slugs.
- `combinePrice`: price source order (Scrydex→tcgpl→pin); eBay never sets price.
- `scoreConfidence`: the four worked cards — Pikachu (all agree → tradeable), Sheoldred (eBay low,
  TCGplayer self-consistent → tradeable at $1,247), Apprentice (eBay high → tradeable at $1), spike
  (uncorroborated day-1 → reduce_only); plus no-eBay default and no-price→halt.
- Fallback: Scrydex miss → tcgpl price; both miss → halt.

## 12. Rollout & reversibility

1. Land behind `PRICE_PRIMARY=tcgpricelookup` (no behaviour change) + run the one-time `scrydex_card_id`
   match backfill; log match rate + unmatched list.
2. Flip `PRICE_PRIMARY=scrydex` in a non-prod/observe window; diff new vs current marks across the
   universe (expect the §12 corrections — Sheoldred, Apprentice, etc.).
3. Cut over prod; the hybrid dedup re-prices the universe on the first pass. Reversible by flipping the
   flag back to `tcgpricelookup`.

## 13. Open decisions (carry from the evaluation)

1. Corroboration band width (C2 `0.5×–1.3×`) — tighter = safer, more reduce_only.
2. No-corroborator default (§6) — lean permissive (spread-tight ⇒ tradeable) vs conservative.
3. JP-only printings — FX to USD vs flag + prefer tcgpl.
4. Coverage misses — tcgpl fallback (default) vs manual pin vs halt.
5. Fetch strategy (§3a) — stored `scrydex_card_id` vs a DSL id-filter batch (verify the API first).
6. Single-source raw (TCGplayer only): accept, with C1/C2/C4 as the manipulation guard + engine gap
   controls; revisit if a second venue (Cardmarket) becomes available from Scrydex.

## 14. Follow-on phases (after raw pricing is live)

- Graded via Scrydex PSA/BGS/CGC ladder + population reports (replace JustTCG).
- Sealed products (opens the gated sealed index).
- Webhooks (push price/pop updates → retire the 6h cron, fix staleness structurally).
