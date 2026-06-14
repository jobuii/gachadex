# Data providers (card price feeds)

What powers the card markets and indices today, and the provider chosen for the **multi-game
expansion** (adding One Piece + MTG alongside Pokémon).

- Original plan (2026-06-03): scrydex for raw + tcgpricelookup for graded.
- **Updated 2026-06-11** (verified live against the tcgpricelookup docs + pricing): **tcgpricelookup
  alone covers raw AND graded for all three games**, in one USD API — so it becomes the **primary**
  provider. **scrydex is kept as a raw fallback** for redundancy (see "Fallbacks" below). Nothing is
  wired yet.

> Secrets note: env var names only, never key values.

## TL;DR — the chosen provider

**tcgpricelookup**, **Trader** plan ($14.99/mo). One API, USD, covers Pokémon + One Piece + MTG:
- **Raw** prices: TCGplayer (`market/low/mid/high`) + eBay rolling averages, per condition.
- **Graded** prices: PSA / BGS / CGC, eBay rolling averages, per grade.
- **Price history** (daily series) — Trader-gated.
- **Commercial use** requires Trader (Free is non-commercial — so Trader is mandatory for us
  regardless of the data).
- **All USD** → no FX needed on the primary path (FX only matters if the scrydex fallback is used).
- **Sealed is NOT covered** (cards only) — still a gap.
- **Fallbacks:** **scrydex** kept as a backup **raw** source (all 3 games) for redundancy; **JustTCG**
  stays as a graded fallback (already wired). See "Fallbacks" below.

---

## Live today (to be replaced by tcgpricelookup)

- **pokemontcg.io v2** `/cards` — the single live feed; raw Pokémon prices (surfaces TCGplayer
  market). Powers card markets + Top 100/250 indices (`apps/api/src/services/oracle.ts`). Pokémon
  only, ~daily.
- **JustTCG** — the only graded source wired (Pokémon PSA-10), gated on `JUSTTCG_API_KEY`
  (`oracle.ts` `fetchGradedPrice`). Superseded by tcgpricelookup graded in the multi-game build.

---

## tcgpricelookup — verified spec (2026-06-11)

Base URL `https://api.tcgpricelookup.com/v1`. Auth: **`X-API-Key`** header (env: `TCGPRICELOOKUP_API_KEY`).
**Games:** pokemon, pokemon-japan, **mtg**, yugioh, **onepiece**, lorcana, star-wars, flesh-and-blood
(all on every tier). List endpoints return `{ data: [...], total, limit, offset }` (paginate with
`limit`/`offset`).

### Plan tiers

| | Free | **Trader $14.99/mo** | Business $89.99/mo |
|---|---|---|---|
| Requests/day | 200 | **10,000** | 100,000 |
| Rate limit | 1 req / 3s | **1 req / s** | 3 req / s |
| TCGplayer raw prices | ✓ | ✓ | ✓ |
| **eBay prices** | ✗ | **✓** | ✓ |
| **Graded (PSA/BGS/CGC)** | ✗ | **✓** | ✓ |
| **Price history** | ✗ | **✓** | ✓ |
| **Commercial use** | ✗ | **✓** | ✓ |

### Endpoints

- `GET /v1/cards/search?q=&game=&limit=&offset=` — search/list cards (paginated envelope).
- `GET /v1/cards/:id` — full card details (schema below).
- `GET /v1/cards/:id/history?period={7d|30d|90d|1y}` — **Trader** — daily series
  `{ date, prices: [{ price_market, price_low, price_mid, price_high }] }`.
- `GET /v1/sets` — browse sets. `GET /v1/games` — list games.

### Response schema (card details)

```jsonc
{
  "id": "<uuid>", "tcgplayer_id": 510327,
  "name": "Charizard ex", "number": "006/197", "rarity": "Double Rare", "variant": "Standard",
  "image_url": "https://cdn.tcgpricelookup.com/...", "updated_at": "2026-02-16T12:00:00Z",
  "set":  { "slug": "obsidian-flames", "name": "Obsidian Flames" },
  "game": { "slug": "pokemon", "name": "Pokemon" },          // slug ∈ pokemon | mtg | onepiece | ...
  "prices": {
    "raw": {
      "near_mint":      { "tcgplayer": { "market": 48.97, "low": 42.50, "mid": 49.99, "high": 64.99 },
                          "ebay": { "avg_1d": 52.30, "avg_7d": 50.75, "avg_30d": 49.20 } },
      "lightly_played": { "tcgplayer": { ... }, "ebay": { ... } }
    },
    "graded": {
      "psa": { "10": { "ebay": { "avg_1d": 425, "avg_7d": 418.5, "avg_30d": 410 } }, "9": { ... } },
      "bgs": { "10": { "ebay": { ... } } },
      "cgc": { ... }
    }
  }
}
```

### What we ingest (mapped to the oracle)

| Our need | Field |
|---|---|
| **Raw market price** (raw card markets + Top 100/250 indices) | `prices.raw.near_mint.tcgplayer.market` — direct successor to today's `tcgplayer.prices.holofoil.market` |
| **Graded price** (PSA-10 Graded index + graded markets) | `prices.graded.psa.10.ebay.avg_7d` (also `psa.9`, `bgs.10`, `cgc.*` for more graded markets) |
| **Market display metadata** | `name`, `number`, `rarity`, `set.name`, `image_url`, `game.slug` |
| **Smoothing / cross-check** | `prices.raw.near_mint.ebay.avg_7d` — less jumpy than the TCGplayer spot if daily ticks are noisy |
| **Chart backfill (optional)** | `/cards/:id/history?period=` — we already build candles from our own ticks; this can seed history on day one |
| **Freshness gate** | `last_price_update` (advances per re-price; `updated_at` is the record's ~static metadata timestamp and must NOT be used — keying print dedup on it freezes the price) |

### Integration notes

- **Cadence ~daily** (eBay fields are 1/7/30-day rolling averages; TCGplayer is a market price) —
  matches the existing daily oracle, no architecture change.
- **Rate limit is a non-issue:** `search` returns paginated lists, so a full refresh of the
  ~250-card universe per game is a handful of requests, not one-per-card. 3 games × a few pages/day
  is far under 10,000/day at 1 req/s.
- **Graded is eBay-only** (no TCGplayer graded) — use `avg_7d` for a stable graded oracle, `avg_1d`
  if fresher is wanted.
- **All USD** — no JPY, so **no FX/Frankfurter**.

---

## Fallbacks (kept for redundancy)

Not used on the primary path; available if tcgpricelookup is unavailable or for cross-checking.

- **scrydex — raw fallback** (all 3 games). A backup raw-price source if tcgpricelookup is down.
  - Endpoint: `https://api.scrydex.com/{pokemon|magic|onepiece}/v1/cards?include=prices`
  - Auth: headers `X-Api-Key` + `X-Team-ID` (env: `SCRYDEX_API_KEY`, `SCRYDEX_TEAM_ID`); paid (Starter ~$29/mo)
  - **Caveats to activate:** the supplied keys returned `401 INVALID_CREDENTIALS` (needs a valid key +
    `X-Team-ID`); prices can be **JPY**, so this path also needs the FX step below; graded is
    Pokémon+Lorcana only, so it's a **raw-only** fallback. TODO comments at `oracle.ts:132`,
    `oracle.test.ts:57`.
- **JustTCG — graded fallback** (Pokémon PSA-10). Already wired (`oracle.ts` `fetchGradedPrice`,
  gated on `JUSTTCG_API_KEY`); kept as the graded fallback for Pokémon.
- **Frankfurter — FX (JPY→USD)** (`api.frankfurter.dev`, ECB, free). Only needed **if the scrydex raw
  fallback is activated** (its JPY prices). Not needed on the tcgpricelookup primary path.

## Still deferred / rejected

- **Sealed → deferred.** tcgpricelookup is cards only. Candidate sealed feeds (not adopted):
  **TCGplayer Sealed**, **PriceCharting**. Sealed index stays gated ("Soon").
- **TCGFish → rejected** as a data source (Cloudflare bot-challenged, image badges, not an API).

---

## Next step

Wire a tcgpricelookup adapter as the **primary** raw + graded source, keyed by `game.slug`, for all
three games — once the **Trader** key is active. This retires the pokemontcg.io ingest and demotes
JustTCG to the graded fallback (scrydex stays the raw fallback, unwired until its key works). Optional
fill-rate sanity check first via `apps/api/scripts/graded-spike.mjs` (point it at the Trader key).
