# Data providers (card price feeds)

What powers the card markets and indices today, and the providers picked for the **multi-game
expansion** (adding One Piece + MTG alongside Pokémon). Decision made 2026-06-03; recorded here
2026-06-11 after reviewing the planning sessions. Nothing in the "Planned" section is wired yet —
all of it is blocked on valid paid API keys (details per provider).

> Secrets note: this doc references **env var names only**, never key values.

## TL;DR — the two primaries we picked

| Need | Provider | Status |
|---|---|---|
| **Raw** card prices (Pokémon + One Piece + MTG) | **scrydex** | Planned — key-blocked (401), not wired |
| **Graded** prices (One Piece + MTG) | **tcgpricelookup** | Planned — tier/Cloudflare-blocked, not wired |

Plus a graded split + fallback: **Pokémon graded** comes from scrydex inline; **JustTCG** is the
graded fallback — and the only graded source actually in the code today (Pokémon PSA-10).

---

## Live today

### pokemontcg.io v2 — raw, Pokémon only ✅
The single live feed. `GET https://api.pokemontcg.io/v2/cards?q=supertype:Pokémon&orderBy=-tcgplayer.prices.holofoil.market&pageSize=250`.
Surfaces **TCGplayer** market prices. One response powers both the individual card markets and the
Top 100 / Top 250 in-house basket indices (`apps/api/src/services/oracle.ts`). Updates ~once a day;
`pageSize` caps at 250, so the tracked universe is the ~250 highest-priced Pokémon cards. No OP/MTG.

### JustTCG — graded, Pokémon PSA-10 🔒
The only graded source currently wired. `${JUSTTCG_BASE}/v1/cards` with an `x-api-key` header
(`oracle.ts` `fetchGradedPrice`, `config.justtcgApiKey` / `justtcgBase` / `gradedConstituents`).
Gated: the Graded (PSA-10) index becomes tradeable only when **`JUSTTCG_API_KEY`** is set. In the
multi-game plan this is **demoted to the graded fallback** (see below), not the primary.

---

## Planned — multi-game expansion (+ One Piece + MTG)

### Raw → scrydex (all three games)
Replaces pokemontcg.io as the raw-price source across Pokémon + One Piece + MTG — one code path
instead of a Pokémon-only feed. Rationale: scrydex covers all three games, and pokemontcg.io was
acquired by scrydex so it will likely be phased out.

- **Endpoint:** `https://api.scrydex.com/{pokemon|magic|onepiece}/v1/cards?include=prices`
- **Auth:** headers `X-Api-Key` + `X-Team-ID` (planned env: `SCRYDEX_API_KEY`, `SCRYDEX_TEAM_ID`)
- **Cost:** credit-based paid plan (Starter ~$29/mo)
- **Prices:** USD or JPY (JPY needs FX → see below)
- **Status / blocker:** the supplied keys returned `401 INVALID_CREDENTIALS` — needs a valid key +
  `X-Team-ID` from an active subscription. **Not wired** — exists only as TODO comments in
  `apps/api/src/services/oracle.ts:132` and `oracle.test.ts:57`. OP/MTG markets are listed but gated
  until scrydex data lands.

### Graded → tcgpricelookup (OP/MTG), with a split
scrydex's graded coverage is Pokémon + Lorcana only (MTG/OP "Coming Soon"), so graded splits by game:

- **Pokémon graded** → **scrydex inline** (free with `?include=prices` on the raw call above).
- **One Piece + MTG graded** → **tcgpricelookup** (primary).
- **Fallback** → **JustTCG** (currently the only wired graded source).

tcgpricelookup specifics:
- **Endpoint:** `https://api.tcgpricelookup.com/v1/search?q=<name>&game={pokemon|mtg|onepiece}`
- **Auth:** `X-API-Key` header (planned env: `TCGPRICELOOKUP_API_KEY`)
- **Response:** a `graded` object (`psa_10`, `psa_9`, `bgs_9_5`, `cgc_9_5`), sourced from TCGplayer +
  eBay, in **USD** (no JPY conversion needed)
- **Cost:** graded is gated behind the **Trader (~$14.99/mo)** plan; the free tier returns `raw` only
- **Status / blocker:** the supplied key was free-tier (no `graded`), and the API is Cloudflare-
  throttled from the build sandbox. A fill-rate spike (`apps/api/scripts/graded-spike.mjs`, ~20 MTG +
  20 OP cards) was **built but never run** — blocked on a Trader-tier key. **Not wired.**
- Note: `tcgfast.com` appears to be the same product.

---

## Deferred / rejected

- **Sealed → deferred.** No source chosen. Candidate feeds named but not adopted: **TCGplayer Sealed**,
  **PriceCharting**. (scrydex has Sealed Products for Pokémon + OP that could unlock it later.) The
  Sealed index stays gated ("Soon").
- **TCGFish → rejected** as a data source: Cloudflare bot-challenged pages, and its badges are rendered
  images, not an API — can't be ingested server-side. A licensed feed or data partnership would be a
  separate decision.
- **PriceCharting** — used once as a research/volatility reference (calibration), not adopted as a
  price provider.

## FX (for scrydex JPY prices)

- **Frankfurter** (`api.frankfurter.dev`, ECB rates, free) — picked for JPY → USD conversion. Only
  needed once scrydex raw lands (its prices can be JPY). **Not wired yet** (part of the parked plan).

---

## Open question / next step

The graded provider isn't reconciled in code yet:
- **Plan:** tcgpricelookup (OP/MTG) + scrydex inline (Pokémon), JustTCG as fallback.
- **Reality:** JustTCG is the only graded source wired (Pokémon-only), gated on `JUSTTCG_API_KEY`.

To unblock: get a valid scrydex key (+ `X-Team-ID`) and a tcgpricelookup **Trader** key, then run
`graded-spike.mjs` to confirm OP/MTG graded fill rates before wiring. The OP/MTG-graded primary was
explicitly "decide after the spike" — and the spike hasn't run.
