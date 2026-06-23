# Price discovery — ① original tcgpricelookup approach (historical, 2026-06-15)

> **Reading this doc (updated 2026-06-23).** It is a chronological record of three pricing approaches,
> oldest to newest. **The live production system today is the third — ③ Scrydex-primary**
> (`ORACLE_PRIMARY=scrydex`, live since 2026-06-20). This first section (①) and ② median-of-three are
> kept as **history**. A **proposed enhancement** to the live approach — two new sanity checks
> (broken-rung + cross-feed outlier guards) — is the **final section** (④).

How a card's tradeable price **was** produced under the original tcgpricelookup feed, end to end: from raw
provider signals → a fair-value USD number → an accepted oracle print → the synthetic **mark** that
positions trade and liquidate against. **This section is historical** — it was the live mechanism through
mid-June 2026, since replaced (see ② and ③ below).

Provider feed was selected by `ORACLE_PRIMARY` (`tcgpricelookup` at the time; **now `scrydex`**); base
`https://api.tcgpricelookup.com/v1`. Oracle re-pulls every `ORACLE_REFRESH_MS` (default **6h**;
source updates ~daily).

---

## Data flow

```
provider signals ─▶ priceCard() ─▶ recordOracle() ─▶ applyConfidence() ─▶ recomputeMark() ─▶ mark
(tcgplayer mkt,     (one fair-value  (accept/reject    (low_confidence      (index × (1+premium))   │
 eBay 1d/7d/30d)     USD number)      the print)        ⇒ reduce-only)                               ▼
                                                                                          chart + 24h change
```

- **index price** = `priceCard` output (cards) or basket NAV (indices). The oracle's fair value.
- **mark** = the index nudged by open-interest skew; **the number the UI shows and the engine
  liquidates against.** With zero open interest, mark = index.
- chart + 24h change are computed off the **marks** series.

---

## 0. Source signals (`providers/tcgpricelookup.ts:fetchTrackedCards`)

Per tracked card, per condition, the provider returns four numbers:

- **TCGplayer market price** — `spot`
- **eBay average — 1-day / 7-day / 30-day** — `a1` / `a7` / `a30`

`observedAt` for the print = `last_price_update ?? updated_at` (the price-freshness timestamp).

## 1. `priceCard()` — raw signals → one fair-value USD number (`providers/tcgpricelookup.ts`)

Five steps, in order:

1. **Condition fallback** — `CONDITION_ORDER = [near_mint, lightly_played]`. Use near-mint; if it has
   no usable data, fall back to lightly-played; if neither, the card is **unpriced ($0)** and the
   oracle skips it.
2. **Anchor = `median(TCGplayer, eBay-7d, eBay-30d)`** — the trusted fair value (the eBay **1-day** is
   deliberately excluded). The median makes it outlier-resistant; because 7d/30d are slow averages,
   the anchor **lags** fast moves.
3. **Agreement gate** — `agree = (≥2 anchor signals) AND (max ≤ 3× min)` (`AGREEMENT_MAX_RATIO = 3`).
   If it fails, return the **bare anchor** and mark the card **low-confidence** (→ reduce-only).
4. **Live signal = eBay-1d** (or the anchor if there is no 1-day) — the input meant to move daily.
5. **±25% clamp** — `price = clamp(eBay-1d, anchor×0.75, anchor×1.25)` (`PRICE_BAND = 0.25`). The live
   price can never sit more than ±25% from the anchor. This is the main anti-manipulation **and**
   single-print gap limiter — and, because the anchor lags, also the main dampener of real moves.

Output: a USD price (rounded to $0.01) + a `confident` flag. `usd = 0` ⇒ unpriced.

## 2. `recordOracle()` — accept or reject the print (`oracle.ts`)

- **60% outlier reject** — reject a candidate **>60% from the last accepted price**
  (`OUTLIER_THRESHOLD = 0.6`). Rarely fires, because step 1.5 already capped the move to ±25%.
- **Persistence hatch** — a rejected >60% move is **force-accepted once the previous print already
  showed that level**, so a genuine large move can't be rejected forever.
- **Dedup** — `ON CONFLICT(market_id, source_observed_at) DO NOTHING`: one print per provider
  snapshot timestamp (`source_observed_at = last_price_update`).

## 3. `applyConfidence()` — restriction (`oracle.ts`)

`confident = false` ⇒ `markets.low_confidence = true` ⇒ the engine **blocks new positions
(reduce-only)**; a `market_restriction_events` row is logged on each flip. The price still displays.

## 4. `recomputeMark()` → `syntheticMark()` — index becomes the tradeable mark (`marks.ts`)

```
mark = clamp(index × (1 + premium), ±max_dev_bps),   premium = clamp(k × skew/depth, ±premium_cap)
```

`skew` = signed long−short open interest. Longs heavy ⇒ premium > 0 ⇒ mark > index. With no open
interest, **mark = index**. `depth` falls back to `config.depthFloorUusdc` when 0. The engine
recomputes this on every trade, so order flow moves the mark intraday.

## 5. Chart + 24h change (`markets.ts`)

Both off the **marks** series. 24h change = latest mark vs the last mark recorded **≤ 24h ago**;
**defaults to 0%** when there is no qualifying reference (or when the latest mark equals it).

## 6. Manual operator override / pin (`admin-pricing.ts`)

An operator sets a price by hand → it writes an accepted print + recomputes the mark and **pins** the
market (`price_pinned`). The auto-oracle **skips pinned markets** until unpinned. The human fallback
for a wrong/stale feed.

---

## Side channels

- **Index markets** (`oracle.ts:buildIndex`): per-game, featured-only baskets.
  `value = Σ(constituent prices) × SCALE / divisor`; the divisor is anchored so the index starts at
  1000 (`BASE_VALUE_E6 = 1e9`) and is re-based on a constituent-set change (continuity), with a
  wrong-scale self-heal (`REANCHOR_JUMP_FACTOR = 4`).
- **Graded (PSA-10)**: `gradedPsa10Usd` = eBay `avg_7d ?? avg_1d ?? avg_30d` of `graded.psa['10']`,
  supplied inline by the provider; **JustTCG fallback** (`oracle.ts:fetchGradedPrice`, requires
  `JUSTTCG_API_KEY`) when the raw provider has none. Feeds the Graded index + the per-card graded
  panel — **not** the raw mark.
- **Market-creation gate** (P6 search-and-bet, `tcgpricelookup.ts:isListable`): a card is only
  listable if NM TCGplayer market ≥ `$10` (`MIN_LIST_PRICE_USD`) and the eBay 7d agrees within ~25%
  (`PRICE_AGREEMENT_TOLERANCE`). Distinct from ongoing pricing.

---

## Constants

| Constant | Value | Where | Role |
|---|---|---|---|
| `CONDITION_ORDER` | near_mint → lightly_played | priceCard | grade fallback |
| `AGREEMENT_MAX_RATIO` | 3× | priceCard | confidence gate |
| `PRICE_BAND` | 0.25 (±25%) | priceCard | clamp live to anchor |
| `OUTLIER_THRESHOLD` | 0.60 (60%) | recordOracle | reject wild jumps |
| `ORACLE_REFRESH_MS` | 6h | config | re-pull cadence |
| `BASE_VALUE_E6` | 1000.0 | buildIndex | index base value |
| graded chain | eBay 7d→1d→30d | gradedPsa10Usd | PSA-10 price |

## The four price-control mechanisms

| Mechanism | Lives in | Protects against | Cost / side effect |
|---|---|---|---|
| Anchor = median(TCGP, 7d, 30d) | priceCard | a single bad/manipulated source | lags real moves (2 of 3 are slow averages) |
| ±25% clamp | priceCard | manipulation **and** single-print gap | **dampens legitimate fast moves** |
| Agreement gate (3×) | priceCard | trading a price we can't cross-check | thin/illiquid cards go reduce-only |
| 60% reject + persistence | recordOracle | a wild single-print jump | rarely fires (clamp pre-empts); 1-cycle delay on big moves |

Gap risk is **also** handled independently by the engine (liquidations, ADL, insurance fund, OI
caps) — so the ±25% clamp is a redundant, second gap limiter layered on top.

---

## Worked example (one card, calm day, some open interest)

TCGplayer $10.50, eBay 1d $10.00 / 7d $10.20 / 30d $9.80:

1. Anchor = median(10.50, 10.20, 9.80) = **$10.20**
2. Agreement: 10.50 / 9.80 = 1.07× ≤ 3 ⇒ **confident** (tradeable)
3. Live = eBay-1d = $10.00
4. Clamp to [$7.65, $12.75] ⇒ $10 is inside ⇒ **index = $10.00**
5. Oracle: <60% from prior ⇒ accepted
6. Mark: longs slightly heavy, premium +1% ⇒ **mark = $10.10** (the displayed/traded price)
7. Chart records $10.10; 24h change measured vs yesterday's mark.

---

## Known limitations (observed 2026-06-15)

- **Real moves are dampened.** Because the anchor is a median that includes the slow 7d/30d
  averages, and the live price is clamped to ±25% of it, a genuine fast move can't be reflected until
  the slow averages catch up (days). The clamp does double duty (manipulation guard + gap limiter),
  which is why it over-suppresses.
- **Flat feed ⇒ 0% / 24h across the board.** Live DB check (2026-06-15): the provider advances
  `last_price_update` every pull but the underlying values were unchanged for days (e.g. a card's
  eBay 1d/7d/30d byte-identical across 4 days; the live API returned the same numbers). Ingestion is
  correct — the upstream values simply aren't moving — so marks are flat and 24h change reads 0%.
- **Only one independent cross-check.** Of the inputs, eBay 1d/7d/30d are all eBay-derived; only
  TCGplayer market is an independent venue. A sustained single-venue (eBay) move/manipulation is only
  weakly cross-checked.

## File reference

- `apps/api/src/services/providers/tcgpricelookup.ts` — `priceCard`, anchor/agreement/clamp, graded,
  `fetchTrackedCards`, `fromTplCard`, `isListable`
- `apps/api/src/services/oracle.ts` — `recordOracle` (accept/reject + persistence + dedup), `ingest`,
  `ingestCard`, `applyConfidence`, `buildIndex`, `primaryFetcher`
- `apps/api/src/services/marks.ts` — `recomputeMark` → `@pokex/pricing.syntheticMark`
- `apps/api/src/services/markets.ts` — markets list + 24h change off the marks series
- `apps/api/src/services/admin-pricing.ts` — manual price override + pin

---

# ② Median-of-three (historical — live 2026-06-15, superseded by Scrydex-primary 2026-06-20)

**Status:** **Superseded** (was live on master, merge 6ebf925, from 2026-06-15 → replaced by ③
Scrydex-primary on 2026-06-20; the median's 2-parts-eBay blend let one eBay value outvote the correct
TCGplayer price — see ③ "Why the median-of-three is being replaced"). Kept here as historical record.
Replaced the ±25%-clamp approach above. Risk gates (per-card
max-leverage, ADL, insurance fund, OI caps) are assumed **ON in production**, so gap risk is handled by
the **engine** — the price feed's only job is to report the true price. NOTE: dedup is **hybrid** — a
print lands on a new provider timestamp OR a changed value (see the Dedup section below; superseded the
timestamp-only dedup after a frozen-timestamp blind spot was found on the top Pokémon cards).

**One sentence:** instead of "take the live eBay price and clamp it to a slow average," take the
**middle of three price sources** — the middle automatically ignores any single source that's lying,
and moves the instant two sources agree.

## The flow, step by step

0. **Read three prices** (per card, per condition): eBay 1-day avg, TCGplayer market, eBay 7-day avg.
   (30-day is still fetched but no longer feeds the price.)
1. **Pick the grade** — near-mint, else lightly-played, else unpriced. *(kept, unchanged)*
2. **Price = the middle (median) of the three.** A spike or a wrong source is the highest or lowest,
   so the middle skips it; the price moves only when **≥2 sources agree**. The median *is* the
   manipulation filter — no clamp, no agreement gate.
3. **Confidence flag (spread check):** if the three are wildly far apart (highest > ~2× the lowest, or
   fewer than two usable sources), flag the card **low-confidence**. This does **not** change the
   price; it only raises a flag.
4. **Reduce-only when flagged:** a low-confidence flag puts the market in **reduce-only** (close
   positions yes, open new ones no), so nobody bets against a price we can't cross-check. Clears
   automatically once the sources agree again. *(existing plumbing; trigger is now the spread flag)*
5. **Hybrid dedup:** write a print when EITHER the provider hands back a new `last_price_update` (a
   re-price — even at an identical value, since a flat-but-live feed is real) OR the computed value
   moved since the last print (a move the provider didn't timestamp, or the new median taking effect on
   a frozen card). Skip only when the timestamp AND the value are both unchanged. *(see "Dedup" below)*
6. **Mark:** the median is fair value; the tradeable **mark** = fair value nudged by long/short skew.
   No open interest ⇒ mark = fair value. *(kept, unchanged)*
7. **Chart + 24h, manual pin** — *(kept, unchanged)*

## Kept / changed / dropped vs the current flow

| Stage (current) | Decision | Notes |
|---|---|---|
| 0. Fetch signals (TCGP, eBay 1d/7d/30d) | ✅ KEEP | price uses **1d, TCGP, 7d**; 30d no longer feeds the price. |
| 1a. Condition fallback NM→LP | ✅ KEEP | unchanged. |
| 1b. Anchor = median(TCGP, 7d, 30d) | 🔄 CHANGE | → `price = median(eBay-1d, TCGP, eBay-7d)`, used **directly** as the price. |
| 1c. Agreement gate (3×) | ❌ DROP | replaced by the median + the light **spread flag** below. |
| 1d. Live = eBay-1d | ✅ KEEP | now one of the three median inputs. |
| 1e. ±25% clamp | ❌ DROP | the dampener. |
| 2a. 60% outlier reject | ❌ DROP | gap risk → the engine (gates on in prod). |
| 2b. Persistence hatch | ❌ DROP | (was only there to pair with the guard). |
| 2c. Dedup (on `source_observed_at`) | 🔄 CHANGE | **hybrid**: write on a new timestamp OR a changed value — see "Dedup" below. |
| 3. Reduce-only mechanism | ✅ KEEP, 🔄 rewire trigger | same `low_confidence → reduce-only` plumbing, now fired by the **spread flag** instead of the agreement gate. |
| 4. Mark = index × (1+premium) (skew) | ✅ KEEP | unchanged. |
| 5. 24h change + chart | ✅ KEEP | unchanged. |
| 6. Manual override / pin | ✅ KEEP | unchanged. |
| Index baskets / Graded + JustTCG | ✅ KEEP | unchanged; indices sum constituent prices, now from the median. |
| Engine risk (liquidation, ADL, insurance, OI caps, max-leverage) | ✅ KEEP | the **sole** gap-risk handler now. |

**Net:** drop 4 mechanisms (±25% clamp, 3× agreement gate, 60% reject, persistence). The price layer
becomes **median (price + manipulation filter) + spread flag (confidence) + hybrid dedup (new timestamp OR changed value).**

## The two controls we keep at the price layer (plain English)

- **Spread flag** — after taking the median, look at how far apart the three sources are. If the
  highest is more than ~2× the lowest (or there are fewer than two usable sources), the data is too
  shaky to trust → mark the card **low-confidence**. It never moves the price; it only raises a flag.
- **Reduce-only** — a low-confidence flag flips the market to **reduce-only**: traders can *close* but
  not *open*. Same plumbing as today; only the trigger changes (old: 3× agreement gate → new: spread
  flag). It clears on its own once the sources agree again.

## Dedup — HYBRID: new timestamp OR changed value (two live-DB corrections)

This went through two corrections, both driven by live-DB checks.

**Round 1 — value-dedup rejected.** We first planned value-dedup (skip the write when the new median
equals the last price). It would have broken the staleness circuit breaker. `haltStaleMarkets`
(`engine.ts`) flips a market to **reduce-only** when its newest print's `ingested_at` is older than
`ORACLE_STALE_MS` (**36h**); it uses "did a print land recently?" as the proxy for "is the feed alive?"
The provider advances `last_price_update` on every ~6h pull even when the price is flat (verified: a
card at $2999.99 for days, `last_price_update` ticking each pull). So a flat-but-live card prints every
pass and stays open — but value-dedup would suppress those repeats, freeze `ingested_at`, and halt all
203 tradeable cards within 36h. Value-dedup conflates "price flat" with "feed dead." Rejected.

**Round 2 — pure timestamp-dedup superseded by HYBRID.** Timestamp-dedup (write only on a new
`source_observed_at`) is safe for the breaker, but a live check on the top Pokémon cards exposed its
blind spot: those cards have `last_price_update = null` and an `updated_at` frozen for ~3 weeks, so
their freshness timestamp never advances → timestamp-dedup never re-prices them. They were stuck on
**old, pre-median-deploy values** that differ from the current median by −43% to +75% (e.g. Treecko
$2,400 stored vs $4,200 now; Latias & Latios $2,548 vs $1,451). The new median was effectively **inert**
for the frozen universe.

**Decision: HYBRID dedup.** Write a print when EITHER:
- the provider timestamp is new (`ON CONFLICT(market_id, source_observed_at)` lets it in — even at an
  unchanged value, so a flat-but-live feed keeps the breaker fed), OR
- the timestamp collided but the **computed value moved** since the last accepted print — the provider
  changed the price without advancing its clock (or our pricing logic changed). That move is re-stamped
  on the ingest wall-clock so it lands as a fresh print + mark.

Skip only when the timestamp AND the value are both unchanged. This only ever **adds** writes versus
pure timestamp-dedup, so it cannot re-trip the 36h breaker — and on the first pass after deploy it
re-prices the whole frozen universe under the new median. (It still does not "declutter" a genuinely
flat chart, nor should it: a flat price is legitimate data.)

## Gap risk — the engine, not the price

A big move now prints in full immediately. The trader's loss is capped at their margin (isolated
margin); the engine's controls (conservative max leverage, insurance fund, ADL, OI caps — all **ON in
production**) absorb the tail. The price layer no longer does gap-limiting.

## Residual to be aware of

With no reject, a simultaneous **two-source** glitch (both eBay and TCGplayer wrong at once) prints
for one cycle and self-corrects on the next pull. A single-source glitch is still ignored by the median.

## Worked example (one card)

Provider gives eBay-1d **$10.00**, TCGplayer **$10.50**, eBay-7d **$10.20**:
1. Grade: near-mint has data → use it.
2. Median of (10.00, 10.50, 10.20) = **$10.20** ← the price. *(today's clamp logic would show $10.00.)*
3. Spread: 10.50 / 10.00 = 1.05× → narrow → **confident, tradeable.**
4. New provider `last_price_update` vs the last one? yes → record the print (it would record even if
   the price were unchanged — a new timestamp is a real print).
5. Mark: slight long skew, +1% premium → **mark $10.30** (displayed/traded price).

The cases that matter:
- **Real +110%** — eBay-1d $33, TCGP $33.5, 7d $17.7 → median **$33**, tracks instantly.
- **Manipulation** — eBay-1d $30 (fake), TCGP $16, 7d $13.6 → median **$16**, fake spike ignored.
- **Calm** — all three ~$10 → ~$10, unchanged (no new point written).

## Implementation plan

### Backend
1. **`priceCard` (`providers/tcgpricelookup.ts`)** — replace the anchor/agreement/clamp body with, per
   the condition fallback: `sigs = [eBay-1d, TCGplayer-market, eBay-7d]` filtered to `> 0`;
   if `sigs` empty, try the next condition; `usd = median(sigs)`;
   `confident = sigs.length >= 2 && max(sigs) <= SPREAD_MAX_RATIO × min(sigs)`. Return `{ usd, confident }`.
   - Delete `PRICE_BAND` and `AGREEMENT_MAX_RATIO`; add `SPREAD_MAX_RATIO` (≈ **2**, tunable). Keep the
     `median` + `cents` helpers and the `usd = 0 ⇒ unpriced` behavior.
2. **`recordOracle` (`oracle.ts`)** — delete the 60% `OUTLIER_THRESHOLD` reject + persistence block.
   **Hybrid dedup:** try the insert on the provider `source_observed_at` (= `last_price_update`); if it
   collides, re-read the last accepted value and, when the new value differs, re-insert on the ingest
   wall-clock so a timestamp-frozen move still lands. `is_accepted` always true.
3. **`applyConfidence` / reduce-only** — plumbing unchanged; `confident` now comes from the spread
   check, so reduce-only is driven by the spread flag automatically.
4. **Untouched:** `recomputeMark`/`syntheticMark`, `markets.ts` 24h/chart, `admin-pricing` pin,
   `buildIndex`, graded + JustTCG, all engine risk controls.

### Tests
- `providers/tcgpricelookup.test.ts` — median price (real move tracks; single spike outvoted), spread
  flag → `confident=false`, condition fallback, single-signal (price = that source, low-confidence).
- `oracle.test.ts` — no outlier reject (a large move is accepted); hybrid dedup (same timestamp + same
  value ⇒ skip; a NEW timestamp ⇒ a print even at an unchanged price; SAME timestamp + a changed value
  ⇒ a print + the mark re-prices); remove the 60%/persistence tests.

### Out of scope (separate decisions)
- `isListable` market-creation gate (NM ≥ $10 + eBay-7d within 25%) — unchanged.
- Risk-engine sizing (leverage / insurance / ADL / OI) — assumed configured in prod.

### Rollout
Code-only change to two functions, behind the existing `ORACLE_PRIMARY=tcgpricelookup` path. **No
schema change.** Reversible by reverting the two functions.

---

# ③ Scrydex-primary pricing (Option B) — LIVE in production

**Status:** **LIVE.** `ORACLE_PRIMARY=scrydex` since 2026-06-20 — this is the mechanism that prices cards
today (re-verified against the live prod DB 2026-06-23). Decided 2026-06-17, built/merged/deployed through
mid-June, cutover 2026-06-20; Pokémon graded moved to the Scrydex ladder 2026-06-22. The §6 confidence
tree and §6a mark guard described below are the **live** behaviour. Supersedes the median-of-three above.
Full implementation spec: `docs/scrydex-pricing-build-spec.md`. Evaluation that led here:
`docs/scrydex-evaluation.md`. **A known gap in this approach + the fix in flight: see ④ at the end.**

## Why the median-of-three is being replaced

The median above is **2 parts eBay : 1 part TCGplayer** (`avg_1d`, `market`, `avg_7d`), and
tcgpricelookup's eBay `avg_1d`/`avg_7d` come back identical, so **one eBay value outvotes the correct
TCGplayer price** — both when eBay is too low (Sheoldred: a ~$1,247 serialized card priced $19.99) and
too high (Apprentice Sorcerer: a $1 card priced $6,449.95). Measured across all 751 cards, eBay
corroborates TCGplayer within 2× for **~70%** (median ratio 0.865 — the real eBay discount), so the eBay
number is a fine **confidence cross-check** but a bad **price input**. tcgpl's own TCGplayer field is
mostly correct and equals Scrydex; Scrydex's is the same source but fresher (catches tcgpl's stale
TCGplayer, e.g. Charizard δ tcgpl $599 vs Scrydex $4,000) and adds trends, sealed, pop reports, webhooks.

## The design (Option B)

- **Sources:** **Scrydex primary** (TCGplayer `market`/`low/mid/high` + `trends`), **tcgpricelookup
  secondary** (its TCGplayer `market` + eBay `avg_1d`), used as a cross-check + fallback when available.
- **Price = the TCGplayer market**, anchored, never set by eBay: Scrydex `market` (NM→LP→MP) ?? tcgpl
  TCGplayer `market` ?? manual pin ?? keep-last/halt. eBay is no longer a price input.
- **Confidence = a decision tree** (not a single spread test) over five checks: (i) Scrydex & tcgpl
  TCGplayer agree (cross-feed stability — same venue, so a freshness check, NOT an independent one),
  (ii) eBay corroborates within **0.5×–1.5×** (the only independent venue), (iii) Scrydex `low/high`
  spread tight (liquidity), (iv) `trends.days_1` not a wild unexplained spike (manipulation), (v) data
  fresh. First-match precedence: no price → **halted**; a **spike that eBay didn't confirm** →
  **reduce-only** (only the independent venue corroborates a *move* — cross-feed is the same venue);
  a corroborator (eBay OR cross-feed) confirms a *stable* price → **tradeable**; a corroborator present
  but disagrees → **reduce-only**; no corroborator available → lean permissive (**tradeable** iff spread
  tight + fresh). This keeps a self-consistent TCGplayer price tradeable even when eBay mismatched the
  wrong printing (fewer false `reduce_only`), while flagging genuine spikes and uncorroborated thin
  markets. (Full tree: build spec §6.)
- **Mark guard (liquidation protection):** ONE visible mark (displayed = traded = liquidation). A
  **>25%** jump caps the per-update move at 25% **unless eBay (the independent venue) confirms it** —
  two TCGplayer vendors agreeing is NOT enough — so a single bad print can't wrongfully liquidate; a
  **"price stabilizing"** badge + an admin **"mark guards"** panel + a clamp-events log make it visible.
  (Full design + worked scenarios: build spec §6a.)

## Kept / changed / dropped vs the median approach

| Median-of-three (now live) | Option B | Note |
|---|---|---|
| price = median([eBay 1d, TCGP, eBay 7d]) | 🔄 price = TCGplayer market (Scrydex→tcgpl) | eBay is NO longer a price input |
| confident = ≥2 signals within 2× | 🔄 **decision tree** → tradeable/reduce-only/halted | richer, fewer false flags — build spec §6 |
| eBay as a price source | 🔄 eBay as a confidence cross-check only | fixes the outvote bug |
| freshness / dedup | 🔄 **webhooks-primary** | Scrydex push (`raw_updated`) fixes staleness; batch-poll backfill — build spec §8 |
| 36h staleness breaker | ✅ KEEP | fed by whether Scrydex still returns the card |
| mark = index × (1+premium) (skew) | 🔄 + **mark guard** | one guarded mark: uncorroborated >25% jump clamps to ≤25%/update (liquidation protection) — build spec §6a |
| 24h change from marks | 🔄 can use Scrydex `trends.days_1` natively | the 24h we never had |
| manual pin, engine gap controls | ✅ KEEP | unchanged |
| graded via tcgpl/JustTCG | 🔄 Scrydex PSA/BGS/CGC ladder + pop reports | upgrade |

**Net:** the manipulation defence moves from "median outvotes a lone source" to "TCGplayer-anchored price
+ cross-venue/cross-feed corroboration (the open/close gate) + a per-update clamp on the mark itself
(liquidation protection)" — keeping every existing safety layer and adding a real cross-venue check.

## Worked example (four cards)

| Card (true value) | feeds | median (today) | **Option B** |
|---|---|---|---|
| Pikachu Star (~$3,200) | TCGP $3,200, eBay $3,200 | $3,200 · tradeable | $3,200 · tradeable |
| Sheoldred serial (~$1,247) | TCGP $1,247, eBay $20 | **$20 · locked (wrong)** | **$1,247 · tradeable** (TCGP self-consistent; eBay mismatch noted) |
| Apprentice Sorcerer (~$1) | TCGP $1, eBay $6,449 | **$6,449 · locked (wrong)** | **$1 · tradeable** |
| Spiked card (~$100) | TCGP jumps $900, eBay $100 | $100 · locked | **reduce-only**; mark guard caps the move to **$125** this update (not $900), reverts if it was a glitch |

Option B prices every card correctly and keeps the self-consistent ones tradeable, while still flagging
the genuine spike. (Options A and C — simpler binary gate / move-hold — are recorded in
`docs/scrydex-evaluation.md` §10–12 and the build spec; B was chosen for fewest false `reduce_only`.)

---

# ④ Proposed enhancement — broken-rung detection + condition-aligned cross-feed (proposed 2026-06-23, revised after QA)

**Status:** **PROPOSED, not built.** A targeted fix to the LIVE Scrydex-primary approach (③), not a new
approach. **No schema change**; three functions touched (`extractRaw`, `combinePrice`, `tplCrossCheck`),
behind the existing `ORACLE_PRIMARY=scrydex` path. Reversible by reverting them.

> **Revised after an adversarial QA pass (2026-06-23).** The first draft paired the broken-rung check with a
> *cross-feed eBay-median override*. Two independent reviews + a code trace rejected that override: it
> (a) re-created the staleness bug in the **down** direction (it could pull a genuine fresh crash back up to a
> stale pair), (b) promoted eBay to a price-setter behind a "pair agrees" check that is really one tcgpl feed
> agreeing with itself (`tcgpricelookup.ts:250-251` — tcgpl market + eBay come from the same feed row), and
> (c) leaned on an arbitrary `0.7×` threshold. The QA also surfaced a **standing** defect: the cross-feed is
> **condition-blind** (fix #3 below). This revision drops the override and instead routes a broken rung to
> the **existing** tcgpl-market fallback — no new price source, no eBay-into-price.

## The gap it fixes

Under ③, the price anchor is **Scrydex's TCGplayer market for our card's variant, best condition first**
(`extractRaw`: walk `NM → LP → MP`, take the first rung with `market > 0`), and `combinePrice` uses that
Scrydex value **whenever it is > 0** — tcgpl is only a fallback for when Scrydex is *missing*, never a
sanity-check on a present-but-wrong Scrydex value. So a single broken Scrydex rung becomes the mark.

**Live evidence — Umbreon ex #112/115** (probed against both APIs 2026-06-23):

| Condition | Scrydex market | tcgpl market | tcgpl eBay 1d |
|---|---|---|---|
| **Near Mint** | **$1** 🚩 | **$899.99** | **$800** |
| Lightly Played | $500.00 | $500.00 | $592 |
| Moderately Played | $500.66 | $500.99 | — |
| Heavily Played | $334.98 | $301.64 | $200 |
| Damaged | $275.12 | $249.68 | $300 |

The two feeds agree within a few percent on **every condition except NM**, where Scrydex returns a broken
placeholder **$1**. That is internally impossible — NM (best grade) can never be worth less than LP — yet
`extractRaw` takes it (first rung > 0) and never sees the sane $500 LP below it. `combinePrice` then sets
the candidate to $1. The §6a mark guard correctly **refuses** the uncorroborated crash (it never let the
mark hit $1) — the last *trusted* mark, **$600 from 2026-06-19**, still stands because the unchanged broken
print is deduped each pass (same timestamp + same value ⇒ no new mark computation), so the mark sits at a
stale $600 while the card is really worth **~$900** (tcgpl NM $899.99 / eBay $800). (Mechanism note: the
guard *clamps* an uncorroborated move to ≤25%/update rather than hard-freezing; the observed freeze here is
the dedup skip, not the clamp creeping — see §6a.)

**Scale (live DB, visible EN board, 2026-06-23):** of 101 `reduce_only` cards carrying *both* feeds,
**60 have Scrydex disagreeing with tcgpl by >50%**, 37 by >2×, 10 by >5× (the $1-class). `reduce_only` +
"price stabilizing" together cover ~38% of the visible Pokémon/MTG boards and ~56% of One Piece — most of
it traceable to this anchor-trusts-a-broken-Scrydex-rung defect.

## In plain English — the fix

Three changes, all using mechanisms that **already exist** — no new price source, no eBay in the price:

1. **Spot the broken rung.** A real price can't sit below its own quoted `low`, and a better grade can't be
   worth a fraction of a worse one. Flag a Scrydex rung as broken when its `market` is **below its own
   `low`**, or — when Scrydex gives no `low`/`high` band — when it sits **far below the card's best rung**.
   (Umbreon NM $1 has no band and is 0.2% of the $500 rungs → broken.)
2. **A broken best rung ⇒ ignore Scrydex and use the fallback we already have.** `combinePrice` *already*
   uses the tcgpl market when Scrydex is missing. Treat a broken rung as "missing" and let that same fallback
   supply the price — the tcgpl **near-mint** market, the right grade. (Umbreon → tcgpl NM $899.99.) Only if
   there's no tcgpl price do we drop to Scrydex's next sane condition.
3. **Compare like-for-like.** The confidence check today reads tcgpl's *near-mint* price no matter which
   grade priced the card, so an LP-priced card gets wrongly compared to an NM cross-price and flagged. Read
   the cross-check at the **same condition** as the anchor, so corroboration is real.

eBay stays a confidence cross-check only, exactly as in ③. The mark guard is untouched — it just receives a
sane, corroborated candidate, so the mark un-sticks.

## Current flow (③, today)

```
① extractRaw     walk NM→LP→MP, take first market>0        ⚠ grabs broken NM=$1, never sees LP=$500
② combinePrice   price = Scrydex mkt (FX'd) if >0  else tcgpl mkt  else 0   ⚠ Scrydex wins even when wrong → $1
③ tplCrossCheck  reads tcgpl's NM grade regardless of the anchor grade      ⚠ condition-blind
④ scoreConfidence (§6 tree) → corroborator present but disagrees → reduce_only   ✓ correct call, bad price
⑤ mark guard (§6a) → refuses the un-corroborated $1; the unchanged print is deduped → mark stays $600
RESULT: candidate $1 (wrong) · reduce_only · mark stuck $600 (stale)
```

## Proposed flow (③ + the three ✚ fixes)

```
① extractRaw ✚ broken-rung check   reject market < its own low, OR (no band) market far below the best rung
                                   → Umbreon NM $1 rejected ⇒ Scrydex has no usable NM
② combinePrice ✚ broken ⇒ "missing"   a dropped best-grade rung falls through the EXISTING tail:
     Scrydex best sane rung → tcgpl market → next Scrydex condition → pin → keep-last/halt
     → Umbreon ⇒ tcgpl NM $899.99   (no median, no eBay-in-price)
③ tplCrossCheck ✚ condition-aligned   read tcgpl at the anchor's grade (NM) → tcgpMarket $899.99, eBay $800
④ scoreConfidence (unchanged) → eBay $800 in-band of $899.99 → tradeable
⑤ mark guard (unchanged) → the move IS eBay-corroborated → adopts it → mark un-sticks to ~$900
RESULT: candidate ~$900 (correct NM) · tradeable · mark updates to ~$900
```

## The three fixes, precisely

**1. Broken-rung detection (`extractRaw`, `scrydex.ts:210`).** Reject a raw rung as broken when its market
is implausibly low — `market < BROKEN_RATIO × ref`, `BROKEN_RATIO ≈ 0.5` — where `ref` is:
- the rung's **own `low`** (a market less than half its own quoted floor is impossible), or
- when the rung is band-less (`low`/`high` absent), the **max market among the rungs that DO carry a band**
  (placeholders are band-less, so a *cluster* of $1 placeholders can't drag the reference down to their own
  level — the median would be poisoned by ≥2 glitches, the banded max isn't); no banded rung ⇒ the max
  across all rungs.

0.5× is tight — it clears the $1-vs-$500 placeholder with a wide margin while tolerating ordinary spread
(LP $500.00 vs MP $500.66).

Return the best **non-broken** rung, and signal when the top (best-grade) rung was dropped so `combinePrice`
can prefer the same-grade cross-feed over a downgraded Scrydex condition.

**2. Broken-best-rung ⇒ no Scrydex anchor (`combinePrice`, `scrydex.ts:344`).** When the best grade was
dropped as broken, treat Scrydex as having no price and fall through to the **existing** order: tcgpl market
→ next sane Scrydex condition (for Scrydex-only cards) → manual pin → keep-last/halt. **No new median, no
eBay in the price** — the corrected price comes from a path that already exists.

**3. Condition-aligned cross-feed (`tplCrossCheck`, `tcgpricelookup.ts:246`).** Today it walks
`[near_mint, lightly_played]` and returns the first populated grade — tcgpl's NM — *regardless* of which
grade priced the card, so the §6 `crossAgrees` test compares mismatched grades (a Scrydex-LP price vs a
tcgpl-NM cross). Pass the anchor's condition in and read the matching tcgpl grade. This alone clears the
slice of the `reduce_only` flood caused by grade mismatch — with no override path at all.

**Safety property — only an *internally-broken* rung is ever dropped.** The trigger is Scrydex contradicting
*itself* (`market < low`, or a bandless rung far below its own siblings) — never "Scrydex disagrees with
tcgpl/eBay." So a legitimately-fresh Scrydex price (consistent ladder, whether higher *or lower* than a
stale tcgpl) is **never** overridden — preserving the freshness advantage ③ exists for, in both directions.
This is the key change from the first draft, whose cross-feed override could revert a genuine fresh *crash*
back up to a stale pair. And when a broken rung is dropped, the replacement is tcgpl (a TCGplayer price,
same venue as the Scrydex anchor), never eBay — so "eBay never sets the price" still holds.

## Kept / changed vs ③ (live)

| ③ stage (live) | Decision | Note |
|---|---|---|
| `extractRaw` first rung NM→LP→MP | ✚ ADD broken-rung check | reject `market < low`, or a bandless rung far below the best sibling |
| `combinePrice` Scrydex mkt → tcgpl → 0 | ✚ ADD broken ⇒ treat as missing | a broken best-rung falls through to the **existing** tcgpl fallback — no new source |
| `tplCrossCheck` NM-first, condition-blind | 🔄 ALIGN to the anchor condition | makes §6 corroboration like-for-like; clears grade-mismatch `reduce_only` |
| §6 confidence tree (`scoreConfidence`) | ✅ KEEP | unchanged — now fed a sane, same-grade comparison |
| §6a mark guard | ✅ KEEP | unchanged — adopts the eBay-corroborated candidate, mark un-sticks |
| eBay as confidence-only (never sets price) | ✅ KEEP | **no exception** — the price is Scrydex or tcgpl, never eBay |
| webhooks / dedup / 36h breaker / pins / engine risk / indices / graded ladder | ✅ KEEP | untouched (the broken-rung drop also cleans the graded ladder if applied at parse) |

## Worked examples

| Card (true value) | feeds | ③ today | **④ proposed** |
|---|---|---|---|
| **Umbreon ex #112** (~$900 NM) | Scrydex NM **$1** (LP $500), tcgpl NM $899.99, eBay $800 | candidate $1 · `reduce_only` · mark stuck $600 | NM rejected (bandless, ≪ siblings) ⇒ no Scrydex anchor ⇒ tcgpl NM **$899.99**; cross aligned to NM ⇒ eBay backs it ⇒ **tradeable**, mark un-sticks to ~$900 |
| **Charizard δ** (fresh ~$4,000) | Scrydex $4,000 (consistent ladder), tcgpl $599 stale | $4,000 · `reduce_only` until eBay confirms | **unchanged** — nothing internally broken ⇒ Scrydex kept ⇒ fresh $4,000 preserved |
| **Real crash** (Scrydex fresh-low) | Scrydex NM $400 (consistent ladder), tcgpl/eBay stale $850 | $400 · `reduce_only` until eBay confirms | **unchanged** — ladder consistent ⇒ NOT overridden ⇒ the real down-move is kept (the first draft's override would have wrongly reverted it to $850) |
| **Raikou (13)** (no eBay) | Scrydex $348, tcgpl $201, eBay — | $348 · `reduce_only` (cross-feed disagrees) | **unchanged** — Scrydex ladder consistent ⇒ kept; genuine two-feed disagreement ⇒ stays `reduce_only` |

## New constants

| Constant | Value (tunable) | Where | Role |
|---|---|---|---|
| `BROKEN_RATIO` | ≈ 0.5 | `extractRaw` | a bandless rung below `RATIO ×` the best sibling is a placeholder |

(The `market < low` rule needs no constant — it's a self-consistency check.)

## What this deliberately does NOT fix

- **Scrydex genuinely higher than tcgpl** (freshness, or a real spike) → stays `reduce_only` until eBay
  confirms — by design (③).
- **Two-feed disagreement with no eBay** (Raikou-class) → no independent venue to break the tie → stays
  `reduce_only`.
- **Graded-ladder placeholders** → the broken-rung filter is RAW-only; a $1-style placeholder on a *graded*
  rung (which feeds the graded index/panel via `scrydexGradedLadder`/`scrydexPsa10E6`) is not yet filtered.
  Separate follow-up — graded rungs are per-(company,grade) peers, not a condition ladder.

So this clears the **broken-low-rung** subset + the **grade-mismatch** subset, not the whole flood. Exact
reach needs a Scrydex re-probe of the featured set (the lake's `scrydex_prices` is sparse) — part of the
build's validation.

## Implementation sketch

1. **`extractRaw` (`providers/scrydex.ts:210`)** — when scanning `NM→LP→MP`, skip a broken rung
   (`market < low`, or bandless and `< BROKEN_RATIO ×` the best sibling market). Return the best surviving
   rung plus a flag for whether the top grade was dropped.
2. **`combinePrice` (`providers/scrydex.ts:344`)** — if the top grade was dropped, skip the Scrydex anchor
   and use the existing `tcgpl market → …` fallback; otherwise unchanged.
3. **`tplCrossCheck` (`providers/tcgpricelookup.ts:246`)** — take the anchor's condition as a parameter and
   read tcgpl at that grade (fall back to NM-first only when that grade is absent on tcgpl).
4. **Untouched:** `scoreConfidence`, the §6a mark guard, `recomputeMark`, dedup/webhooks, pins, indices,
   engine risk. (Optionally apply the same broken-rung drop at parse so `scrydexGradedLadder` benefits too.)

**Tests** (`providers/scrydex.test.ts`, `tcgpricelookup.test.ts`): a broken NM (`market < low`, and bandless
≪ siblings) is skipped; broken-best-rung + tcgpl present ⇒ price = tcgpl, tradeable; **freshness not
regressed** — a consistent higher *or lower* Scrydex is kept (the real-crash row above); a condition-aligned
cross-check flips a grade-mismatch card to tradeable; Scrydex-only broken-NM ⇒ next condition / halt; the
Umbreon fixture end-to-end. Plus a live oracle pass to confirm the `reduce_only` count drops on the
broken-low set.

**Tests** (`providers/scrydex.test.ts`): ladder check skips a broken-low NM and uses LP; broken-low NM +
corroborated pair ⇒ price = median(pair) + `tradeable`; **freshness not regressed** — Scrydex above a stale
pair is kept (LOW-side guard does not fire); no-eBay divergence ⇒ no override, stays `reduce_only`; the
Umbreon numbers as a fixture. Plus a live re-derivation/oracle pass to confirm the `reduce_only` count
drops and the `>2×` divergence set clears.
