# Scrydex vs tcgpricelookup — raw-pricing evaluation (2026-06-16)

Should we switch raw card pricing from **tcgpricelookup** (current primary) to **Scrydex**? This
documents a live head-to-head on a sample of cards across all three games, the granular results, and
a recommendation.

**TL;DR — two findings, in priority order:**

1. **URGENT + FREE (does not need Scrydex):** the live mispricing is largely **self-inflicted**. Our
   median-of-three is 2-parts-eBay : 1-part-TCGplayer, so one eBay value **outvotes the correct
   TCGplayer market price** — both when eBay is too high (Apprentice Sorcerer: a $1 card live at $6,450)
   and too low (Sheoldred: a ~$1,247 serialized card live at $19.99). The defect is **using eBay to set
   the price**, not the eBay number itself: measured across the universe, eBay corroborates TCGplayer
   within 2× for **~70%** of cards (median ratio **0.865** — the real eBay discount), so it is a valid
   *confidence cross-check*, just not a price input (§13). **Fix: price from the TCGplayer market;
   use eBay `avg_1d` as the confidence gate (corroborate within a band), with TCGplayer's own low/high
   spread as the fallback gate when eBay is absent/off.** Corrects the bulk of mispricing today and
   un-flags many false `reduce_only` markets, no new vendor. See §12–§13.

2. **ENHANCEMENT: adopt Scrydex as the primary raw source** (demote tcgpricelookup to cross-check /
   fallback). Scrydex's raw ≈ TCGplayer market but **fresher** than tcgpl's, plus native price trends
   (the 24h-change we never had), **sealed products**, **population reports**, and **webhooks**. It is
   single-source (TCGplayer-only) for raw, needs EN/currency handling, vintage condition-mapping, and a
   fallback for the promo/serialized printings it misses — so keep tcgpricelookup as the second opinion.
   Worthwhile, but it is the freshness/features upgrade, NOT the thing that fixes correctness (the median
   fix in #1 does that).

---

## 1. Why we're evaluating (the tcgpricelookup problems)

Measured live on prod (see `docs/price_discovery.md` and the 2026-06-16 session):

- **No real freshness signal.** `last_price_update` is **null** for the top cards; `updated_at` is
  frozen for weeks/months. We worked around it with hybrid dedup, but the feed itself is stale.
- **Thin, dirty signals.** Raw price = `[eBay avg_1d, TCGplayer market, eBay avg_7d]`. eBay listings
  get mismatched (graded/foreign/lots scraped as the raw card), producing wild outliers
  ($1.05, $599, $249.95, $300 seen live). Our median-of-three is **eBay-weighted (2 of 3 inputs)**, so
  a bad eBay pair can **outvote** the correct TCGplayer value.
- **Coverage holes.** Some cards can't be priced at all (e.g. Mew ★ δ has no provider id).

## 2. Recorded history of Scrydex in this project (`docs/data-providers.md`)

- **2026-06-03:** Scrydex was the **original** choice for raw prices (tcgpricelookup for graded).
- **2026-06-11:** demoted to an **unwired raw fallback** when tcgpricelookup was found to cover raw +
  graded for all 3 games in one USD API. Reasons Scrydex lost then:
  1. the supplied key returned `401 INVALID_CREDENTIALS` (needs a valid key **+ `X-Team-ID``);
  2. prices can be **JPY** (needs FX);
  3. graded was thought to be Pokémon+Lorcana only;
  4. cost (~$29/mo Starter vs $14.99 Trader).
- That demotion was decided on **breadth + cost + currency** — **before** we knew tcgpricelookup's
  raw data quality was this poor. The key now works (operator signed up; $99/mo plan).

## 3. Scrydex API (verified live, 2026-06-16)

- **Base:** `https://api.scrydex.com`. **Auth headers:** `X-Api-Key` + `X-Team-ID`.
- **Path:** `GET /{game}/v1/cards?q=&include=prices&page=&pageSize=` — paginated envelope
  `{ data, page, page_size, count, total_count }`. Search is a **Lucene-like DSL** (`select=`,
  field filters, `orderBy`). Single card: `GET /{game}/v1/cards/{id}`.
- **Game slugs (verified):** `pokemon`, `onepiece`, **`magicthegathering`** (NOT `mtg`/`magic` — both
  404). Also supports Lorcana, Gundam, Riftbound (beta). MTG **is** covered (the old doc's "magic"
  slug was wrong/untested).
- **Prices live under `variants[]`** (not top-level), each variant carries `marketplaces[]` (with
  TCGplayer `product_id` — the join key to our `markets.tcgplayer_id`), `pop_reports[]`, and
  `prices[]`. Each price entry:

```jsonc
{ "condition": "NM", "type": "raw",            // or { "grade":"10","company":"PSA","type":"graded" }
  "low": 42.50, "mid": 49.99, "high": 64.99, "market": 48.97,
  "currency": "USD",                            // PER-ENTRY currency (EN→USD, JP cards→JPY)
  "trends": { "days_1": {"price_change":..,"percent_change":..},
              "days_7": {...}, "days_14": {...}, "days_30": {...}, "days_90": {...}, "days_180": {...} } }
```

- Raw prices are **TCGplayer-sourced only** (`marketplaces: ["tcgplayer"]`) — `market/low/mid/high` +
  built-in **trends**. No eBay second source on the raw side.
- Graded = full ladder (PSA/BGS/CGC, grades 10/9/8…) with **population reports**.

## 4. Test methodology

Match by **`tcgplayer_id` ↔ Scrydex `variants[].marketplaces[].product_id`** (the only reliable key —
card names collide across dozens of printings). For each sample card: search by name, scan pages for
the variant whose product_id equals our `tcgplayer_id`, then read that variant's raw NM
`market`/`low`/`high`, `currency`, and `trends.days_1/days_7`. Compare to our current mark (= the
tcgpricelookup median now live). Read-only; no writes to prod.

## 5. Results — high-value / exotic sample (19 cards)

Deliberately the **hardest** cases (5k+ alt-arts, the cards that exposed tcgpl's problems).

| Card | Game | Our mark (tcgpl) | Scrydex raw NM | Currency | Scrydex trend (1d/7d) | Note |
|---|---|---|---|---|---|---|
| **Apprentice Sorcerer** | mtg | **$6,449.95** | **$0.93** | USD | 0 / 0 | our feed mispriced a ~$1 common ~7000× |
| **Jolteon Star** | pkmn | **$1,675** | **$300** | USD | +36.4% / — | eBay outlier outvoted TCGplayer in our median |
| **Flareon Star** | pkmn | **$1,503.42** | **$245** | USD | −2.0% / −2.0% | same pattern |
| Pikachu Star 104/110 | pkmn | $3,200 | **$3,200** | USD | 0 / 0 | exact agreement |
| The Soul Stone #242 | mtg | $32,999.99 | **$32,999.99** | USD | 0 / 0 | exact agreement |
| Sabo OP13-120 | op | $6,000 | **$6,000** | USD | 0 / 0 | exact agreement |
| Umbreon VMAX AA 215/203 | pkmn | $2,475 | $2,292.45 | USD | 0 / +1.4% | close (7%) |
| Lugia 149/147 | pkmn | $2,499.99 | $2,225 | USD | 0 / 0 | close |
| Latias Star 105/107 | pkmn | $2,000 | $2,300 | USD | 0 / 0 | close |
| Traveling Chocobo #551 | mtg | $6,199 | $5,950 | USD | 0 / 0 | matched the **JA** printing |
| Charizard Star δ 100/101 | pkmn | $5,600 | $4,000 | USD | 0 / 0 | thin alt-art disagreement |
| Treecko Star 109/109 | pkmn | $4,200 | $2,400 | USD | 0 / 0 | thin alt-art disagreement |
| Latias & Latios GX 170/181 | pkmn | $1,450.96 | $2,785.65 | USD | — | thin alt-art disagreement |
| Luffy OP13-118 AA | op | $8,612.48 | $19,999 | USD | 0 / — | thin; Scrydex `low` $99,999 (listing noise) |
| Black Lotus (Unlimited) | mtg | $12,049 | NM **unpriced** (DM $8,000) | USD | — | vintage: no NM market; price in lower grades |
| Hurricane (Summer Magic) | mtg | $6,111 | **no price at any condition** | USD | — | ultra-rare, Scrydex has no market |
| Tamiyo, Inquisitive Student | mtg | $7,500 | **printing not matched** | — | — | Scrydex has MH3 Tamiyo, not our serialized product_id |
| Bitterbloom Bearer #352 | mtg | $7,309.40 | **printing not matched** | — | — | Scrydex has #352 Lorwyn Eclipsed under a different product_id |
| Uta OP09-002 (Treasure Cup) | op | $5,954.50 | **not carried** | — | — | tournament-prize promo absent from Scrydex |

## 6. Findings by criterion

1. **Cleanliness — Scrydex wins decisively.** Single clean TCGplayer `market/low/mid/high`, no
   eBay-mismatch outliers. The Apprentice/Jolteon/Flareon trio shows our current feed actively
   mispricing; Scrydex gives the sane value. (Scrydex's `low`/`high` can still carry listing noise on
   thin markets — e.g. Luffy `low` $99,999 — so the `market` field is what to trust, not the range.)
2. **Freshness — Scrydex wins.** Built-in `trends` (1/7/14/30/90/180-day price + % change) — the
   native 24h-change we never had. Populated and non-zero on moving cards (Jolteon +36.4%/1d, Umbreon
   +1.4%/7d). *Caveat: confirmed the mechanism + that it updates; cadence-over-days not yet measured.*
3. **Depth — Scrydex wins on structure** (price spread + full graded ladder + population reports),
   **loses on cross-source** (raw is TCGplayer-only; no eBay second opinion → no median cross-check).
   Mitigations: the `low/mid/high` spread, the trends (a spike shows in `days_1`), our existing
   confidence gate, and keeping tcgpricelookup as the cross-check.
4. **Currency — mostly USD, one edge.** EN cards → USD. **Japanese-exclusive cards → JPY** (Traveling
   Chocobo matched the JA printing). Needs EN-language filtering + FX (JPY→USD) for JP-exclusives.

## 7. The smoking gun

**Apprentice Sorcerer is live right now at $6,449.95; it is a ~$1 bulk common (Scrydex: $0.93).**
Cause: tcgpricelookup's eBay `avg_1d`/`avg_7d` both returned $6,449.95 (a mismatched listing), and our
median-of-three (2 eBay : 1 TCGplayer) picked it over the correct TCGplayer $1.05. Our confidence gate
flagged it `reduce_only` (the spread tripped it), so it isn't openable — but the **displayed and
settlement price is still wrong**, and the same eBay-outlier mechanism inflates an unknown number of
other markets. Scrydex's TCGplayer-sourced data does not have this failure mode.

## 8. Coverage caveats (the real cost of switching)

- **Genuine price gaps:** ultra-rares with no TCGplayer market (Hurricane / Summer Magic — no price at
  any condition), and tournament-prize promos not carried (Uta OP09-002).
- **Printing-match gaps:** serialized/borderless variants (Tamiyo, Bitterbloom #352) exist in Scrydex
  under a *different* product_id than our `tcgplayer_id` — the card's there, our exact variant isn't
  matched by the join key.
- **Vintage condition-mapping:** Black Lotus Unlimited has **no NM** price (none exist NM); value sits
  in LP/MP/DM. Our pipeline keys on NM `market`, so vintage needs a condition fallback (NM→LP→…).
- **Implication:** a switch needs a **fallback to tcgpricelookup / manual pin** for cards Scrydex can't
  price or match, plus condition-fallback logic. Not a clean rip-and-replace.

## 9. Other platform features (beyond raw pricing)

From the Scrydex docs (`scrydex.com/docs`):

- **Sealed Products** endpoint — closes the sealed gap tcgpricelookup couldn't (sealed index is "Soon").
- **Webhooks** (price + pop-report push) — replace polling; could fix staleness structurally and retire
  the 6h cron.
- **Price History** endpoint — native chart backfill.
- **Population Reports** — graded scarcity data; a real edge for pricing graded markets.
- **Listings** — actual marketplace listings (a depth/liquidity signal).
- **Vision (image identify by URL/photo)** — card recognition; a product/onboarding feature, not pricing.

## 10. Recommendation + work to budget

**Switch the primary raw source to Scrydex; demote tcgpricelookup to cross-check/fallback.** Same
confidence gate, better inputs: if Scrydex vs tcgpl-TCGplayer disagree beyond a band, flag
low-confidence. Keep tcgpl for the printings/vintage Scrydex misses.

Build work (not trivial):
- Scrydex adapter for the 3 game slugs (incl. `magicthegathering`); `include=prices`, pagination.
- EN-language filtering; product_id ↔ tcgplayer_id matching with a name/number fallback.
- Vintage **condition fallback** (NM→LP→MP→…) for cards with no NM market.
- **JPY→USD FX** for JP-exclusive cards (Frankfurter, already speced).
- Coverage fallback to tcgpricelookup / manual pin for unmatched/unpriced cards.
- Optional follow-ons: sealed ingest, webhooks (replace cron), pop-report-weighted graded pricing.

Cost: $99/mo (already signed up) vs $14.99 — justified by the data quality + features.

## 11. Open items / validation still wanted

1. **Broader liquid-card sample** ($5–$200, the bulk of real volume) — section 12 below. The §5 sample
   was deliberately the hardest exotic alt-arts.
2. **Freshness cadence poll** (2–3 days) to prove Scrydex updates beat tcgpl's frozen feed.

## 12. Liquid-card sample ($5–$200) — and the ROOT CAUSE it exposed

Stratified sample, 6 cards/game spread across the $5–$200 band (all `active`, mostly `low_confidence`).
Scrydex first appeared to wildly *overprice* these (Sheoldred: our $19.99 vs Scrydex $1,247). Pulling the
raw tcgpricelookup signals behind our marks flipped that and revealed the real root cause.

| Card | our mark | tcgpl **TCGplayer mkt** | tcgpl eBay 1d=7d | **Scrydex raw** |
|---|---|---|---|---|
| Sheoldred (serial) MOM | $19.99 | **$1,247.39** | $19.99 = $19.99 | **$1,247.39** |
| Atraxa (serial) MUL | $23.99 | **$1,117.33** | $23.99 = $23.99 | **$1,117.33** |
| Ragavan (serial) MUL | $44.64 | **$945.00** | $42.00 ≈ $44.64 | **$945.00** |
| Niv-Mizzet (retro) RVR | $7.04 | **$893.00** | $7.04 = $7.04 | **$893.00** |
| Hallowed Fountain (retro) | $52.46 | **$799.99** | $52.46 = $52.46 | **$799.99** |
| M Charizard EX (Secret) | $150.00 | $680.94 | $150 = $150 | $1,000.62 |
| Lugia EX (Team Plasma) FA | $47.18 | $510.75 | $47.18 = $47.18 | $725.00 |
| Latias EX (112) FA | $135.00 | $376.06 | $135 = $135 | $376.06 |
| M Gengar EX (XY166) | $88.50 | $239.60 | $88.50 = $88.50 | $277.22 |
| Groudon ex (93/101) | $169.99 | $196.01 | $169.99 = $169.99 | $263.03 |

Three facts:
1. **Our median-of-three is 2 eBay : 1 TCGplayer**, so one eBay value (counted twice via `avg_1d` +
   `avg_7d`) **outvotes the one correct TCGplayer market price** — whether eBay is too low (Sheoldred)
   or too high (Apprentice).
2. **The eBay number is NOT uniformly garbage** (measured in §13): it corroborates TCGplayer within 2×
   for ~70% of cards (median ratio 0.865 — the real eBay discount). It is a valid *confidence
   cross-check*; the defect is using it to **set the price**. The ~30% where it's off (13% wildly) are
   wrong-printing matches concentrated in premium/exotic printings — exactly the cards to flag.
3. **Scrydex's raw price ≈ tcgpl's OWN TCGplayer market field** (identical on the serialized/retro MTG
   cards), just **fresher** where tcgpl's TCGplayer lags (Charizard δ exotic: tcgpl-TCGplayer $599 stale
   vs Scrydex $4,000; M Charizard EX: $680 vs $1,000; Lugia EX: $510 vs $725).

**So the live mispricing is largely self-inflicted.** We let eBay outvote the good TCGplayer value in the
price median. Sheoldred (a ~$1,247 serialized card) is **live at $19.99**; Apprentice Sorcerer (a $1
card) is **live at $6,449.95** — the SAME bug in opposite directions. It's also why so many cards sit
`reduce_only`: the eBay-vs-TCGplayer disagreement trips the confidence gate constantly (every card in
this sample except two was `low_confidence`).

**Coverage note:** 5 of 6 One Piece liquid cards were promo/event/regional printings (Treasure Cup,
Online Region, Event Pack) that **did not match** in Scrydex — confirming weaker Scrydex coverage of OP
promos, and our DB is heavy on exactly those.

### What this changes about the recommendation

The headline §0 recommendation ("switch to Scrydex") still holds for freshness + features, but the
**urgent** fix is cheaper and does not need Scrydex:

1. **NOW (free, urgent): price from the TCGplayer market; use eBay as the confidence gate, not a price
   input.** `price = TCGplayer market` (NM→LP). `confident` when eBay `avg_1d` corroborates within a band
   (eBay runs ~0.87× TCGplayer, so an asymmetric band like 0.5×–1.3× is the starting point), with
   TCGplayer's own `low/high` spread as the fallback gate when eBay is absent (~30% of cards) or off.
   This corrects the bulk of live mispricing today — Sheoldred $19.99→$1,247, Apprentice $6,450→$1 — with
   no new vendor, and un-flags the false `reduce_only` markets. tcgpl's TCGplayer field is already mostly
   correct (== Scrydex). **Decision to make:** strict (eBay-only gate → ~30% premium cards reduce-only)
   vs hybrid (eBay OR tight TCGplayer low/high spread → fewer false flags). Recommend hybrid.
2. **THEN (enhancement): adopt Scrydex as primary raw.** Its value over the free fix is real but narrower
   than first thought: a consistently **fresher** TCGplayer market than tcgpl's, plus native trends (24h),
   sealed products, population reports, and webhooks. Keep tcgpl as cross-check + a fallback for the
   promos/serialized printings Scrydex misses.

**Bottom line:** Scrydex is a worthwhile upgrade for freshness + features, but it is NOT what fixes
correctness — our own median letting eBay outvote the good TCGplayer value is the bug, and fixing that is
free and urgent. Do the median fix immediately; adopt Scrydex as the enhancement.

## 13. Is eBay `avg_1d` reliable as a confidence source? (measured across all 751 cards)

An earlier draft called eBay "garbage." That was wrong — measured, the eBay number is a usable second
source for the majority of cards. The defect is using it to set the price (the 2:1 median), not the
number itself. Stats from the latest stored print of every card market (`oracle_prices.raw_payload`):

- **Coverage:** 679/751 have a TCGplayer market; **473 have eBay `avg_1d`** (so ~30% of cards have no
  eBay at all → the confidence gate needs a non-eBay fallback for those).
- **Is it a real average?** `avg_1d == avg_7d` on **375 (79%)**, differ on **98 (21%)**. So it's a
  genuine 1d/7d series 21% of the time; the identical 79% is mostly low-volume cards with a flat weekly
  average (consistent with a real average, not proof of a placeholder).
- **Agreement with TCGplayer** (431 cards with both): within ±25% = **177 (41%)**, within 2× =
  **298 (69%)**, beyond 2× = **133 (31%)**, wildly off >10× = **58 (13%)**. **Median ratio 0.870** —
  eBay typically prints ~13% under TCGplayer, the real sold-price discount.

**By price tier** (the universe is ~98% premium — 423 of 431 cards-with-both have TCGplayer > $200):

| TCGplayer tier | cards | agree within 2× | disagree % | median eBay/TCGplayer |
|---|---|---|---|---|
| > $200 | 423 | 297 (70%) | 30% | 0.865 |
| $20–200 | 4 | 1 | 75% | — (tiny n) |
| < $20 | 4 | 0 | 100% | — (tiny n; the $1→$6,450 type) |

**Conclusion:** eBay `avg_1d` corroborates TCGplayer for ~70% of cards (median 0.865) — **reliable
enough to be the confidence cross-check**, not reliable enough to set the price. The ~30% it's off on
are wrong-printing matches concentrated in premium/exotic printings — which is exactly what the
confidence gate should flag as low-confidence. Hence the §12 design: price from TCGplayer, gate
confidence on eBay corroboration, fall back to the TCGplayer low/high spread when eBay is absent/off.
