# Build spec — Scrydex-primary pricing (Option B)

Implementation plan for the pricing redesign decided in `docs/price_discovery.md` ("Next approach —
Scrydex-primary pricing"). Evaluation + data: `docs/scrydex-evaluation.md`. **Status: spec only, no code
yet.**

## 1. Goal & scope

Replace the median-of-three (which lets tcgpl's eBay outvote the correct TCGplayer price) with a
**TCGplayer-anchored price from Scrydex (primary) + tcgpricelookup (secondary)**, plus a **trust-score
confidence gate** that keeps every existing safety layer and adds a real cross-venue check.

**In scope:** raw card pricing + confidence; the Scrydex adapter; provider orchestration (Scrydex primary,
tcgpl secondary); **webhooks as the primary update path** (see §1a, §8); fallbacks; tests; flag-gated rollout.
**Out of scope (follow-on phases, §14):** graded via Scrydex ladder + pop reports; sealed products; Vision.
The mark engine, hybrid dedup, staleness breaker, manual pin, and engine gap controls are unchanged.

## 1a. QA + best-practice validation (2026-06-17)

QA of this spec + a best-practice review (sources below) before build. **Verdict: the design is sound and
defensible — not a naive spot oracle.** Why: TCGplayer "Market Price" is itself a ~7-day, outlier-excluded
aggregate of *sold* listings, so our price is already smoothed/sales-based; layered with corroboration
(eBay-sold, cross-feed, spread, spike) + engine gap controls it matches IOSCO's illiquid-benchmark guidance
and single-source DeFi practice. It is **not** a Mango-style naive last-trade oracle.

**Scrydex facts verified (vs the spec's assumptions):**
- Rate limit **100 req/s, all plans**; credits: **$99 "Growth" = 50,000/month**, 1 credit per `/cards`
  request (price-history 3, Vision 5), overage $0.002/cr; monitor via `GET /account/v1/usage`.
- A list/search returns **up to 100 cards per 1 credit**; a card-by-id fetch is 1 credit each.
- **Webhooks exist**, HMAC-SHA256 signed (`whsec_…`, `X-Scrydex-Signature`), retried 4×:
  `<game>.expansions.prices.raw_updated` / `graded_updated` / `pop_reports.updated`.
- Currency: Japanese cards' raw prices are **all JPY** (USD for US market; EUR "coming").
- Scrydex `market` is documented as "average across various sources" but **matched tcgpl's TCGplayer
  number exactly** on our sample — treat as TCGplayer-equivalent (single-venue framing holds); confirm.

**Clear corrections folded into this spec (this revision):**
1. **Fetch in BATCHES of 100, not by-id.** By-id ≈ 751 cr/pass × ~4 passes/day ≈ **90k/mo > the 50k plan**;
   batch ≈ ~1k/mo. Still store `scrydex_card_id` for matching. (Revises §3a / decision #5.)
2. **Webhooks are the primary update path** — push = near-zero credits, real-time, and structurally fixes
   the freshness/dedup gap (§8). Batch-poll is the backfill/reconcile.
3. **Confidence rubric reworked into an explicit decision tree** (§6) — the old point-sum couldn't make a
   no-eBay/no-cross-feed card "tradeable" (maxed at 3 < the ≥4 bar), contradicting the lean-permissive
   decision.

**Decisions this round:** liquidity-tiered leverage/OI = **leave as-is** (decision #8); the mark guard =
**single guarded mark, 25% corroboration-clamp** (decision #7, resolved — the review's one real gap; §6a).

**Sources:** Deribit Index (capped median), Binance mark (median-of-3, ±5% clamp), Uniswap v3 / Cube TWAP,
IOSCO Principles for Financial Benchmarks, TCGplayer Market Price help, Mango Markets post-mortem.

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
                                              ▼  (downstream)
                                     recordOracle (hybrid dedup) ─▶ recomputeMark ─▶ MARK GUARD (§6a clamp) ─▶ mark ─▶ chart/24h
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
- **Rate/credits (verified §1a):** 100 req/s; $99 Growth = 50,000 credits/mo, 1 credit per `/cards`
  request. **Batch-fetch (≤100 cards/request) → ~1k credits/mo**; by-id would be ~90k/mo (over budget).
  Monitor via `/account/v1/usage`. Retry on 429 with backoff (mirror the tcgpl client).

### 3a. Fetch strategy — BATCH-fetch (decision #5, revised §1a)

Scrydex search is by name/Lucene DSL, not by our `tcgplayer_id`. We still **persist the match** — a
one-time backfill stores `markets.scrydex_card_id` **alongside** `tcgplayer_id` / `provider_card_id`
(store BOTH, so a card is matchable from either feed). But the steady-state refresh **fetches in batches
of ≤100 cards per request** (1 credit each), NOT one-by-one (by-id ≈ 90k credits/mo, over the 50k plan).
Batch via the list/search endpoint (per expansion, or a multi-id query if the DSL supports one — confirm
an id/ids filter; the DSL is known to support `language:`/`types:`/`subtypes:`). Unmatched cards → NULL →
tcgpl fallback. **With webhooks (§8) as the primary update path, this batch poll is the backfill/reconcile,
not the hot loop.**

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
price input.** Round to the $0.01 tick (`cents`). Currency: use USD entries; a JP-only printing is
**converted to USD via FX (Frankfurter JPY→USD)** — decision #3.

## 6. Confidence tier — `scoreConfidence` (decision tree)

Inputs: `price` (chosen), `sxMarket`, `tcgpMarket`, `ebay1d`, Scrydex `low`/`high`, `trends.days_1`. The
checks (tunable thresholds):
- **C1 cross-feed agree** — Scrydex & tcgpl TCGplayer both present and within ±15%. *(A freshness /
  one-feed-glitch check — NOT an independent venue: both are TCGplayer.)*
- **C2 eBay corroborates** — eBay `avg_1d` present and within **0.5×–1.5×** of price (decision #1).
  *(The only genuinely independent venue.)*
- **C3 spread tight** — Scrydex `(high − low) / market` ≤ 0.5.
- **C4 no uncorroborated spike** — `|trends.days_1| ≤ 40%`, OR a corroborator moved with it.
- **C5 fresh** — priced from a live fetch/webhook this cycle.

Evaluate in order, first match wins:
1. No usable price → **HALTED**.
2. **C4 fails** (uncorroborated day-1 spike) → **REDUCE_ONLY** (manipulation gate; overrides the rest).
3. **C2 passes OR C1 passes** (a corroborator confirms the price) → **TRADEABLE**.
4. A corroborator is present but **disagrees** (C1 or C2 available and failing) → **REDUCE_ONLY** (a
   thin/exotic price nothing else confirms).
5. **No corroborator available** (no eBay AND no cross-feed) → **LEAN PERMISSIVE** (decision #2):
   **TRADEABLE if C3 (spread tight) + C5 (fresh)**, else REDUCE_ONLY.

This replaces an additive point-sum that could not lift a no-eBay/no-cross-feed card to "tradeable" (it
maxed at 3, below the ≥4 bar) — which contradicted decision #2. Keep a numeric score only as an optional
tuning aid; the tree is authoritative. Worked cards: Pikachu (C2 passes → tradeable), Sheoldred (C2 fails
but C1 passes → tradeable $1,247), Apprentice (C1 passes → tradeable $1), spike (C4 fails → reduce_only),
no-eBay single feed (step 5 → tradeable iff spread tight).

Map to existing state: `TRADEABLE ⇒ low_confidence=false`; `REDUCE_ONLY/HALTED ⇒ low_confidence=true`
(reuse `applyConfidence`, which logs flips to `market_restriction_events`). The 36h staleness breaker
still owns the feed-down `reduce_only` separately.

## 6a. Mark guard — single guarded mark (decision #7, resolved 2026-06-17)

Protects EXISTING positions from a wrongful liquidation on a single bad/uncorroborated print — the gap
the best-practice review found (the §6 confidence gate governs OPENS, not the mark that *liquidates*).
We use **ONE mark, no hidden second price**: displayed = traded = liquidation mark, guarded by a
corroboration-clamp. Engine-side, in the mark recompute / liquidation path.

Mechanism (per update):
- Compute the candidate mark from the new index as usual (`index × (1 + premium)`).
- **Corroborated move** — eBay `avg_1d` OR the cross-feed TCGplayer moved the same direction by a
  comparable amount → **adopt the candidate immediately.**
- **Uncorroborated jump > X = 25%** vs the last mark → the mark moves **at most 25% toward** the
  candidate this update (clamped creep). A one-print glitch reverts next update (no wrongful
  liquidation); a persistent real move fully adopts over ~3 updates. X is tunable — tighter than §6's
  40% spike-gate because this protects money, not just opens; raise toward pool-protection, lower toward
  user-protection.

**Trade-off (accepted):** the single displayed price **creeps** on a genuine *uncorroborated* >25% move
(a few updates to fully reflect it) rather than jumping; corroborated moves jump immediately. In
exchange there is no hidden value — what's on the chart is exactly what liquidates you.

**Visibility (REQUIRED — never a silent guard):**
- Persist `markets.mark_clamped` (+ clamp %, `clamped_since`, candidate-vs-adopted) each update.
- A **"price stabilizing"** badge on the market while clamped (admin + customer).
- Admin **"mark guards" panel** (beside the restrictions/transitions panel): every currently-clamped
  market — candidate vs adopted mark, gap %, duration, trigger.
- **Clamp events log** (mirror `market_restriction_events`): engage/disengage history.
- Liquidation records note the mark was guarded at the time.

## 7. Fallbacks & coverage

- **Scrydex misses the card** (unmatched product_id / promo / serialized): price from tcgpl TCGplayer;
  confidence loses the Scrydex-specific inputs (C3/C4) but keeps C1-via-tcgpl + C2.
- **Both miss / no price:** keep-last + halt (the Mew★δ case), or manual pin.
- **Vintage (no NM):** condition fallback NM→LP→MP (Scrydex prices lower grades; e.g. Black Lotus
  Unlimited has price only at DM). Define the per-condition order once.
- **JP-only:** convert to USD via FX (Frankfurter JPY→USD) — decision #3 (see §5).

## 8. Freshness / dedup / staleness — WEBHOOKS primary (§1a)

Scrydex exposes no per-price provider timestamp, so polling-with-wall-clock would record a flat print
every pass (clutter) or need value-dedup (which broke the staleness breaker before). **Webhooks resolve
this:** subscribe to `<game>.expansions.prices.raw_updated` — Scrydex POSTs (HMAC-SHA256 signed; verify
the `X-Scrydex-Signature` against the `whsec_…` secret) exactly when a card's raw price changes. A print
then lands precisely on a real move → no clutter, no staleness ambiguity, near-zero credits. The receiver
must ack in < 2s (Scrydex times out at 10s, retries 4× with backoff).
- **Dedup:** a webhook event IS the "value changed" signal → record the print. The hybrid dedup still
  applies on the batch-poll path.
- **Staleness breaker (36h):** keep it, but feed it a **"last successfully refreshed"** signal (last
  webhook OR last batch-poll that returned the card), NOT just "last print" — a flat-but-live card must
  not age into reduce_only.
- **Backfill:** the batch poll (§3a) runs on a slow cadence to catch missed webhooks + new cards — the
  reconcile, not the hot loop.
- **24h change:** surface Scrydex `trends.days_1` directly.

## 9. Schema changes (`apps/api/src/db/schema.sql`, idempotent)

- `ALTER TABLE markets ADD COLUMN IF NOT EXISTS scrydex_card_id TEXT;` — the matched Scrydex id (for
  matching + the batch poll). Index if we query by it.
- **Mark guard (§6a):** `ALTER TABLE markets ADD COLUMN IF NOT EXISTS mark_clamped BOOLEAN NOT NULL
  DEFAULT false` (+ `clamped_since TIMESTAMPTZ`); a `mark_clamp_events` table mirroring
  `market_restriction_events` for the engage/disengage log.
- Optional: persist the confidence components on the oracle print's `raw_payload` (audit) — no column
  needed.

## 10. Config & flags (`apps/api/src/config.ts`)

`SCRYDEX_API_KEY`, `SCRYDEX_TEAM_ID`, `SCRYDEX_BASE` (default the live base), `PRICE_PRIMARY`
(`scrydex`|`tcgpricelookup`, default current until cutover), FX config (reuse the speced Frankfurter),
and the rubric thresholds as live-tunable knobs (`liveKnob`) so confidence can be tuned without a deploy.

## 11. Tests (`apps/api/src/services/providers/scrydex.test.ts` + pricing tests)

- Adapter: parse the `variants[]→prices[]` shape; match by product_id; currency; NM→LP→MP fallback; 429
  retry; the 3 game slugs; **batch (≤100) list parse; webhook payload HMAC-SHA256 signature verification.**
- `combinePrice`: price source order (Scrydex→tcgpl→pin); eBay never sets price.
- `scoreConfidence`: the four worked cards — Pikachu (all agree → tradeable), Sheoldred (eBay low,
  TCGplayer self-consistent → tradeable at $1,247), Apprentice (eBay high → tradeable at $1), spike
  (uncorroborated day-1 → reduce_only); plus no-eBay default and no-price→halt.
- Fallback: Scrydex miss → tcgpl price; both miss → halt.
- **Mark guard (§6a):** an uncorroborated >25% jump clamps to a ≤25% step + sets `mark_clamped` (and a
  glitch reverts next update → no liquidation); a corroborated jump adopts immediately; clamp engage/
  disengage is logged.

## 12. Rollout & reversibility

1. Land behind `PRICE_PRIMARY=tcgpricelookup` (no behaviour change) + run the one-time `scrydex_card_id`
   match backfill (log match rate + unmatched list) + register the `raw_updated` webhook (§8) and the
   batch-poll backfill (§3a).
2. Flip `PRICE_PRIMARY=scrydex` in a non-prod/observe window; diff new vs current marks across the
   universe (expect the §12 corrections — Sheoldred, Apprentice, etc.).
3. Cut over prod; the hybrid dedup re-prices the universe on the first pass. Reversible by flipping the
   flag back to `tcgpricelookup`.

## 13. Decisions (resolved 2026-06-17)

1. ✅ **Corroboration band (C2): `0.5×–1.5×`.** eBay within 0.5–1.5× of the price corroborates.
2. ✅ **No-corroborator default: LEAN PERMISSIVE.** Only-TCGplayer cards are tradeable when the spread
   (C3) is tight + fresh (C5); reduce_only otherwise.
3. ✅ **JP-only printings: convert to USD via FX** (Frankfurter JPY→USD).
4. ✅ **Coverage misses: tcgpl fallback** (price from tcgpl TCGplayer; manual pin / halt only when both
   feeds miss).
5. ✅ **Fetch strategy: store `scrydex_card_id` for matching; fetch in BATCHES of ≤100 (NOT by-id).**
   Stored alongside `tcgplayer_id` / `provider_card_id` (both ids). By-id ≈ 90k credits/mo > the 50k
   plan; batch ≈ ~1k/mo. **Webhooks (§8) are the primary update path; the batch poll is backfill.**
   (Revised 2026-06-17 after the credit check — §1a.)
6. ✅ **Single-source raw (TCGplayer only): ACCEPTED.** Price stays TCGplayer-only; eBay / cross-feed /
   spread / trend are the confidence/manipulation guards and the engine gap controls (leverage, ADL,
   insurance, OI caps) are the backstop. Revisit only if Scrydex exposes a second venue (Cardmarket).
7. ✅ **Mark guard: SINGLE guarded mark, 25% corroboration-clamp** (resolved 2026-06-17; full design §6a).
   The best-practice review's one real gap — the gate protects *opens*, not the mark that *liquidates*.
   Decision: one visible mark (no hidden liquidation price); an uncorroborated >25% jump clamps to ≤25%
   per update (corroborated moves jump immediately), with a "price stabilizing" badge + admin "mark
   guards" panel + clamp events log. Engine-side. Trade-off accepted: the displayed price creeps on an
   uncorroborated big move.
8. ✅ **Liquidity-tiered leverage / OI caps: LEAVE AS-IS.** The review flagged that "20x everywhere" is
   aggressive for thin cards; operator chose to keep the current flat risk config for now.

## 14. Follow-on phases (after raw pricing is live)

- Graded via Scrydex PSA/BGS/CGC ladder + population reports (replace JustTCG).
- Sealed products (opens the gated sealed index).
- (Webhooks moved to core — §8.) Revisit single-venue (decision #6) if Scrydex exposes Cardmarket / EUR.
- If approved, the §13 #7 mark-persistence guard (engine-side liquidation protection).
