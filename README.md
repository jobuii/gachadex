# GachaDex

A **leveraged perpetual-futures exchange on trading-card prices**, settled in USDC, across
**Pokémon, One Piece, and Magic: The Gathering**. Trade perps on individual cards **and** on
basket **indices** — Top 100 / Top 250 (all three games) plus a Pokémon **Graded** index, each
published in three weighting methodologies (**GJ** price-weighted, **G&P** equal-weight, **Pokedaq**
5%-capped) — with an index-anchored synthetic mark, a pooled-LP counterparty, funding, and
liquidations — plus a leaderboard, referrals, a sortable **markets screener**, shareable **PnL cards**,
**delegated trading keys** (for bots / the official CLI), eight selectable UI **skins**, and a **live
chat & social layer** (reactions, rank badges, presence, moderation, and a **DROP** giveaway pot).

> **Two run modes.** The same engine runs on **play money** (a faucet, for demo/testing) or on **real
> funds** — USDC custody with on-chain deposits/withdrawals on **Solana mainnet** — selected by the
> `REAL_FUNDS` flag. Real-funds mode needs the full custody config and, on mainnet, an explicit
> `ALLOW_MAINNET_FUNDS=true`: the boot gate that acknowledges the operator has handled the audit /
> KYC-AML / geofence prerequisites for holding customer money. See
> [Custody & wallets](#custody--wallets-real-funds-mode).
>
> A fan project built on public trading-card price data (primarily via
> **[Scrydex](https://scrydex.com)**, with [tcgpricelookup.com](https://tcgpricelookup.com) as the eBay
> cross-check + fallback and [pokemontcg.io](https://pokemontcg.io) as a legacy feed); **not** affiliated
> with Nintendo, The Pokémon Company, Bandai, Wizards of the Coast, or TCGFish, and **not financial advice**.

---

## What you can do (V1)

- **Sign in with your Solana wallet** (Sign-In-With-Solana) — no passwords, no email.
- **Fund your account** — claim **faucet** play-USDC (play-money mode), or **deposit real USDC** to a
  per-user Solana deposit address and **withdraw** back out (real-funds mode).
- **Open leveraged perps**, long or short, up to **20×**, on any card market or on any index — Top 100 /
  Top 250 across all three games, plus Pokémon Graded; each in the GJ / G&P / Pokedaq series.
- **Manage positions** — partial or full close, live unrealized PnL, liquidation price, and a one-click
  **shareable PnL card** (the traded card's art + your ROE %) you can copy or download.
- **Browse the markets** — toggle between **Indices** and **Cards**. *Indices* is a financial-style
  overview (price · 1D / 1W / 1M / YTD · 52-week low/high · **View → trade**), grouped by game then by
  methodology (GJ / G&P / Pokedaq), with a per-game filter. *Cards* is a sortable screener (price · 24h % ·
  volume · rarity) with top-mover tabs, a game filter, a rarity filter, and a **JPY** toggle.
- **Provide liquidity** to the LP pool (the counterparty to all trades) and earn fees + trader PnL.
- **Leaderboard** — traders ranked by net realized PnL (with equity + volume).
- **Set up your profile** — a Portfolio banner with a **Pokémon avatar** (gen 1–5, default or shiny),
  an editable **username**, and an at-a-glance **DEX stat strip** (equity · realized PnL · volume · rank);
  your avatar + name follow you into chat.
- **Referrals & affiliate codes** — every account gets a shareable code (auto-redeemed on sign-in);
  redeeming pays both sides a play-USDC bonus. Operators can give KOL/affiliate codes a **cashback %**
  (a cut of their referees' trading fees, paid as real USDC) + a **fee-discount %** on their own trades —
  per code, or as a **platform-wide default** applied to every code.
- **Free signup credit** *(operator-configurable; **dark by default**)* — an operator-set amount of free,
  **tradeable but non-withdrawable** USDC granted on a new customer's **first deposit**. The principal is
  locked forever (a floor at the one withdrawal chokepoint); only *winnings* cash out, and only after the
  customer deposits ≥ a wager minimum and trades ≥ a wager volume. Loss-prevention: non-withdrawable
  principal · wagering gate · **dormancy expiry** (unused credit is clawed back after N days; active traders
  keep it) · **manual review** on the first credit-origin withdrawal · **velocity auto-freeze** (grants pause
  + the admin is flagged if new accounts spike past a daily cap). Funded from a dedicated `CREDIT_BUDGET`
  topped up from earned fees; the budget balance is the hard cap. Runs entirely off the custodial ledger.
  See [`docs/signup-credit-spec.md`](docs/signup-credit-spec.md); enabled by `signup_credit_enabled`.
- **Chat & socialize** — a live chat rail with emoji reactions, leaderboard **rank badges**, an
  online-presence count, and **BIG BET / BIG WIN** action bars that broadcast notable trades; moderated
  (mods + operator can delete / mute / ban).
- **DROP** — a timed TCG-pack giveaway: tip USDC into the pot. (Teaser shipped; the draw/prize mechanic
  is in progress — see [Chat, social & DROP](#chat-social--drop).)
- **Trade by API** — mint scoped **delegated keys** (trade-only; can never withdraw) for bots or the
  official `gachadex` CLI / SDK, without exposing your main wallet.
- **Reskin the app** — pick one of **8 skins** (default **gachadex**, the modern house look; plus retro
  **arcade** and Pokémon / One Piece / Magic themes); a separate sidebar **game switcher** filters markets by game.
- Everything is **server-authoritative** and streamed live over WebSocket; the browser is a renderer.

---

## Where the data comes from

This is the part most people ask about, so it's spelled out explicitly.

### Card prices and the live indices — the feed

The oracle's **live** primary feed is **[Scrydex](https://scrydex.com)** (`ORACLE_PRIMARY=scrydex`) — a
fresh, **TCGplayer-anchored raw price** plus a **full graded ladder** (PSA / BGS / CGC / TAG, per grade,
with trends) for **Pokémon, One Piece, and Magic: The Gathering**, joined to our markets by the TCGplayer
`product_id`. **[tcgpricelookup.com](https://tcgpricelookup.com)** runs alongside it as the **eBay
cross-check** (drives price confidence + the mark guard) and as the price **fallback** for cards Scrydex
doesn't cover (e.g. most One Piece). JP-only printings report JPY → converted to USD via Frankfurter FX.
The legacy **[pokemontcg.io](https://pokemontcg.io) v2** path and a pure-tcgpl **median-of-three** mode
remain selectable via `ORACLE_PRIMARY` (`pokemontcg` / `tcgpricelookup` / `scrydex`) — flip at boot, no
deploy. Full matrix: [docs/data-providers.md](docs/data-providers.md), build spec:
[docs/scrydex-pricing-build-spec.md](docs/scrydex-pricing-build-spec.md).

Each cycle the oracle fetches the tracked card universe from the active provider, and a **weekly
discovery pass** rebalances the featured set per game (top-N by price) and retires dead long-tail
markets. That data is used two ways (`apps/api/src/services/oracle.ts`):

1. **Individual card markets** — each tracked card becomes a tradeable market, priced by `priceCard`
   (the pipeline below). Card-market symbols are game-namespaced (`{game}:{providerCardId}`); legacy
   Pokémon markets keep their bare ids for continuity.
2. **The indices** — per game, cards are sorted by price into **Top 100 / Top 250** baskets (plus a
   Pokémon **Graded** basket). Each basket is published in **three weighting methodologies** — **GJ**
   (price-weighted), **G&P** (equal-weight), and **Pokedaq** (5%-capped) — all computed over the same
   constituents and the same canonical card price. See [The indices](#the-indices-per-game).

So the indices are **not a separate API** — they're computed in-house from the same dataset that
powers the card markets. The price *origin* is TCGplayer / eBay; the provider is the delivery API.

### The indices (per game)

Every basket is published in **three weighting methodologies** (`INDEX_CATALOG` in
`packages/shared-types`; math in `services/index-weighting.ts`; weighting split in `services/oracle.ts` →
`buildIndex`):

- **GJ** — *price-weighted* (Dow-style): `value = Σ(prices) · SCALE / divisor`, the divisor chosen for a
  base of 1000 and **re-anchored** on a constituent change so the print stays continuous.
- **G&P** — *equal-weight* (S&P-EW-style): a chained average of each constituent's per-period return.
- **Pokedaq** — *capped-weight* (Nasdaq-100-style): chained return with each name capped at **5%**
  (iteratively redistributed), normalized so a flat pass is exact (no drift).

The three run over the same baskets and the same canonical card price. An index is listed but
**close-only** until its data flows, then auto-lights — no flag flip. Indices aggregate many cards, so
they're robust by construction and **never price-gated**. Slugs: GJ keeps the bare tier (`top-100`),
G&P prefixes `gp-`, Pokedaq `pdq-`.

| Basket (× GJ / G&P / Pokedaq) | Source | Status |
|---|---|---|
| **Top 100 / Top 250** — Pokémon, One Piece, Magic | In-house basket from card prices (Scrydex for Pokémon/Magic, tcgpl for One Piece) | ✅ Live (all three games) |
| **Graded (PSA-10)** — Pokémon | **Scrydex graded** PSA-10 → in-house basket (tcgpl eBay / JustTCG as fallback) | ✅ Live |
| **Sealed** — Pokémon | needs a sealed-product feed (TCGplayer Sealed / PriceCharting) | 🔒 Gated — no source wired; shows "Soon" |

**Index Overview (Markets → Indices).** The Markets page opens on an **Indices** tab: every index in a boxed
table **per game** (Pokémon / One Piece / Magic, with a per-game filter), grouped inside each box by series
(GJ / G&P / Pokedaq). Each row shows the live price, **1D / 1W / 1M / YTD** change, the **52-week low & high**,
and a **View → Exchange** action. Price + 1D stream from the live `/markets` feed; the slower windows come
from `GET /markets/index-overview` (`indexOverview` in `services/markets.ts`), computed off the same `marks`
series as the chart + 24h change. YTD and 52W are measured over each index's **available history** (indices
are young, so YTD falls back to since-launch and 52W to the window that exists). Toggle to **Cards** for the
per-card screener.

We deliberately do **not** scrape TCGFish: their pages and embed badges are Cloudflare bot-challenged and
the badges are rendered images, not an API. Enabling the **Sealed** index for real is a data decision (a
licensed feed), not a hack.

### The oracle pipeline

`oracle.ts` re-prices the tracked universe on a timer (`ORACLE_REFRESH_MS`, default 6h; the upstream
re-prices each card roughly daily). Full rationale: [docs/price_discovery.md](docs/price_discovery.md).
Each pass:

1. **Fetch** the per-card signals from the active feed: the TCGplayer **market** price plus eBay
   **1-day / 7-day** average sale prices, per condition (Near Mint preferred, Lightly Played fallback).
2. **Price** each card with `priceCard` — one definition of "the price"
   (`services/providers/tcgpricelookup.ts`):
   - **Price = `median(eBay 1-day avg, TCGplayer market, eBay 7-day avg)`.** The median *is* the fair
     value **and** the manipulation filter: a lone bad or manipulated source is the highest or lowest of
     the three, so the middle skips it — the price only moves when **≥2 sources agree**. No separate
     anchor, no clamp. Rounds to the $0.01 tick.
   - **Confidence (spread flag)** — a stand-in for volume (the provider gives no sale counts): trusted
     only when there are **≥2 usable signals that agree within 2×** (`SPREAD_MAX_RATIO`). Otherwise the
     card is **low-confidence** → its market is **restricted to reduce-only** (no new positions against a
     price we can't cross-check). Gap risk is handled by the **engine** (leverage / liquidation / ADL /
     insurance), *not* by clamping the price.
3. **Record** the accepted print to `oracle_prices` via a **hybrid dedup**: write when the provider's
   freshness timestamp is new (even at an unchanged value — keeps the staleness breaker fed) **or** when
   the value moved at a colliding timestamp (re-stamped on the ingest clock). No outlier reject.
4. **Recompute the synthetic mark** and publish on the `mark:{id}` channel.
5. **Apply the gate** — set `markets.low_confidence`, and on a *transition* append a
   `market_restriction_events` row (powers the admin "restricted now" + "flipped today" views).
6. **Staleness halt** — a market with no accepted print within `ORACLE_STALE_MS` (36h) goes reduce-only.

Worked examples (price = median of the signals; confident = ≥2 usable signals within 2×):

| Signals — 1d / market / 7d | Price (median) | Tradeable? |
|---|---|---|
| 10.80 / 9.80 / 10.10 | **10.10** | ✅ three signals agree |
| 13 / 10 / 10 | **10** | ✅ ≥2 agree; the high 1d is outvoted |
| — / 10.00 / 10.50 | **10.25** | ✅ two signals within 2× |
| 4699 / 10.00 / 9.96 | **10.00** | ❌ restricted — the median ignores the 4699 spike, but it blows the 2× spread → can't cross-check |
| 50 / — / — | **50** | ❌ restricted — one signal, can't cross-check |

A restricted market is **close-only** until its signals recover — or until an operator sets a manual
price, which is treated as trusted and clears the gate. Indices aggregate many cards, so they're robust
by construction and never gated.

> **The median-of-three above is the `ORACLE_PRIMARY=tcgpricelookup` mode.** **Prod runs
> `ORACLE_PRIMARY=scrydex`** (cutover complete), where the price is instead `combinePrice`
> (`services/providers/scrydex.ts`): the **Scrydex TCGplayer market** anchors the value, tcgpl's **eBay**
> read is the confidence cross-check (not part of the price), and the **§6a mark guard** clamps an
> uncorroborated jump toward a real move over a few updates. This fixed the eBay-median garbage the median
> mode suffered (a lone bad eBay read outvoting the good TCGplayer price). Cards Scrydex doesn't match
> price off the tcgpl TCGplayer market via the same fallback. **Graded** prices likewise come from the
> Scrydex ladder first, tcgpl fallback. Build spec: `docs/scrydex-pricing-build-spec.md`.

### How a card's price is calculated (the customer explanation)

> Every market settles against a **fair value** we compute for each card from real markets — never a
> single listing.
>
> **A corroborated TCGplayer price.** We anchor each card to its **TCGplayer market** price (kept fresh via
> Scrydex) and cross-check it against recent **eBay** sales. If the two agree, the card trades normally;
> if a print jumps without eBay confirming it, we ease the mark toward the move over a few updates instead
> of snapping — so one freak print can't wrongly liquidate you. The price tracks the real market, but a
> single bad sale can't move it alone.
>
> *(Earlier builds used a median of three eBay/TCGplayer reads — still selectable via
> `ORACLE_PRIMARY=tcgpricelookup` — but prod runs the Scrydex-anchored model above.)*
>
> **Thin cards are limited.** Some cards trade too rarely to price safely. Where our sources disagree
> (more than 2× apart) or there's only one, we hold the card at its median fair value and make it
> close-only (no new positions). Our **indices** — baskets of many cards — are the most robust markets
> and a great default.
>
> **What you actually trade.** Your mark price is this fair value plus a small premium reflecting live
> buying vs. selling pressure on the venue (standard for perpetuals). With no open positions, it's
> exactly the fair value.
>
> **Why it may differ from a price you see elsewhere.** We won't quote a lone $4,699 listing on a card
> that sells for $10 — our number is the corroborated consensus, and risk from a sudden real move is
> managed by margin and liquidations rather than by capping the price.

---

## How trading works

- **Synthetic mark.** The tradeable price is `mark = clamp(index · (1 + premium), ±maxDev)`, where
  the `premium` comes from the LP pool's long/short skew (scaled by a per-market `k`, capped). The
  oracle/index value is a hard anchor; skew adds bounded intraday motion. Same model for cards and
  indices. (`packages/pricing/src/index.js` → `syntheticMark`.)
- **Mark guard** (under `ORACLE_PRIMARY=scrydex`). An *uncorroborated* price jump — one the independent
  eBay venue doesn't confirm — is capped at **±`mark_clamp_bps`** of the last mark per update, so the
  displayed = traded = liquidation price *creeps* toward a real move over a few updates and a one-print
  glitch can't wrongfully liquidate open positions; an eBay-corroborated move adopts immediately. The
  clamp is a settings-backed **live knob** — default **25 %** (range 1–90 %), tunable with no deploy via
  `GET`/`POST /admin/mark-clamp` — and currently-clamped markets + engage/disengage history show in the
  admin **mark-guards** panel. (`apps/api/src/services/marks.ts` → `recomputeMark`.)
- **Isolated margin, up to 20×.** Each position locks its own margin; leverage is capped per market.
- **Minimum order size.** A **$1 min-notional** floor (price-aware, enforced in `openPosition`) blocks
  dust positions; the per-market qty step is fine (0.0001 units) so small orders are reachable even on
  high-priced cards (`MIN_NOTIONAL_UUSDC` in `packages/pricing`).
- **Pooled-LP counterparty.** There is no order book. Trades fill against the LP pool at the mark;
  the pool books trader PnL (LPs win when traders lose, and vice-versa).
- **Fees.** A trading commission (`FEE_BPS`, **default 0** — off; when set, charged on both open and
  close) splits between LPs and platform fee revenue (`FEE_LP_SHARE_PCT`, default 50%). The LP's share of
  fees, funding, and liquidation penalties is operator-tunable in the admin **"LP Fee Sources"** panel.
- **Funding.** Hourly, skew-balancing: the heavier side pays the lighter side (cumulative-index lazy
  settle) via the LP pool, which keeps a configurable cut (`LP_FUNDING_SHARE_PCT`, default 80%; the rest
  → house revenue). Keeps the mark tethered to the index.
- **Liquidations.** A maintenance-margin sweep runs every few seconds and after every accepted print.
  Liquidations are loss-capped at the trader's margin; the penalty (`LIQ_FEE_BPS`) **splits LP/house**
  (`LP_LIQ_SHARE_PCT`, default 60% LP — it no longer auto-funds insurance). Any bad debt is drawn from
  insurance first, then socialized across LP NAV. Every leg is a ledger entry.
- **Open-interest caps.** Per-side OI caps protect the pool from one-sided risk — a static cap **and**
  a NAV-relative cap (`OI_CAP_NAV_BPS`), so no single side can outgrow a set fraction of LP NAV.
- **Adaptive depth.** The skew→premium conversion uses a depth that scales with pool NAV and
  cumulative volume, so the mark gets harder to move as the pool and traded volume grow.
- **Pool-health gate + auto-deleverage (ADL).** New opens pause once aggregate trader profit exceeds
  `MAX_PNL_FACTOR_BPS` of NAV; beyond `ADL_PNL_FACTOR_BPS` the most-profitable positions are
  force-closed (loss waterfall: trader margin → insurance → LP). Together these keep the LP pool
  solvent. Default **off** in play-money, **on** for real funds.

---

## Money & safety model

- **Integer money only.** All balances are `BIGINT` **micro-USDC** (1 USDC = 1,000,000); prices and
  quantities are `*_e6`. No floats anywhere. JSON encodes these as decimal strings.
- **Double-entry ledger.** Every value movement is a balanced transaction in `ledger_entries`
  (Σ per `txn_id` = 0, enforced by a deferred constraint). `balances` is a cache.
- **Continuous reconciler.** `reconcile.ts` proves `balances == Σ ledger`, every txn nets to 0, and
  the whole ledger nets to 0 — runs in tests and can auto-halt on drift.
- **Single-writer per market.** Each engine transaction takes an in-process mutex **and** a Postgres
  advisory lock, so concurrent orders on the same market serialize.
- **Idempotency.** Every order/close carries a client key; replays (even concurrent ones) return the
  prior result instead of double-executing.
- **Chart of accounts.** `USER_COLLATERAL`, `USER_POSITION_MARGIN`, `RESTING_ORDER_MARGIN` (reserve held
  against a resting limit order), `LP_POOL`, `INSURANCE_FUND`, `FEE_REVENUE`, `FUNDING_POOL`,
  `PNL_CLEARING`, `FAUCET_SOURCE`, `TREASURY_USDC` (real-funds custody mirror), `DROP_POOL` (the DROP
  giveaway pot), `GAME_POOL` (the Games house bankroll).

---

## Custody & wallets (real-funds mode)

When `REAL_FUNDS=true`, the platform custodies USDC on Solana through three wallet roles:

- **Deposit wallets (per user).** One HD master seed (`DEPOSIT_MASTER_SEED`, or a KMS reference)
  derives a unique deposit address per user at `m/44'/501'/{index}'/0'`. Users fund their account by
  sending USDC (or SOL) there; the server holds the seed so it can sweep those addresses.
- **Hot wallet** (`HOT_WALLET_SECRET`). One server-controlled keypair that **pays out withdrawals**
  and **pays the gas** to sweep deposits. Only a working float lives here, capped by the hot-wallet cap.
- **Cold treasury** (`TREASURY_PUBKEY`). A **Squads multisig the server cannot sign for** — only your
  operators can move funds out. Holds the bulk of customer funds.

**Money flow:** deposit → user deposit address → swept to the hot wallet (hot pays the gas) → hot
above its cap swept to cold. Withdrawals pay from hot; when hot runs low, an operator tops it up from
cold (a manual multisig action). SOL deposits are auto-swapped to USDC via Jupiter (mainnet only).

**Proof of reserves.** A treasury worker checks `on-chain (cold + hot + unswept deposits) ≥ ledger
liabilities` every pass. A breach **auto-freezes withdrawals** (deposits keep flowing); unfreezing is
manual, once the incident is understood.

**Insurance fund.** A ledger bucket that absorbs liquidation bad debt before it reaches LPs. It fills
from the 1% liquidation penalty, and an operator can top it up from accumulated platform fees or from
treasury surplus (admin panel).

**Custody limits** — hot-wallet cap, withdrawal daily cap, auto-approve max, min deposit/withdrawal/
sweep, swap slippage — are **live-editable from the admin panel** (no redeploy); defaults come from env.

**Withdrawal approval.** Withdrawals up to the **auto-approve max** are signed + broadcast automatically by
a worker loop; larger ones always wait for manual operator approval. The auto-approval path itself is a
**live admin toggle** (default `WITHDRAWAL_AUTO_PROCESS`) — turn it **off** and *every* withdrawal,
regardless of size, requires manual approval; the change converges within ~30s, no redeploy.

**Boot gate.** With `REAL_FUNDS=true` the API refuses to start unless the custody config is present
(`USDC_MINT`, `TREASURY_PUBKEY`, the deposit seed, `HOT_WALLET_SECRET`); on mainnet it additionally
requires `ALLOW_MAINNET_FUNDS=true`.

Deep dives: **[docs/real-funds-custody-plan.md](docs/real-funds-custody-plan.md)** (design) ·
**[docs/ops-runbook.md](docs/ops-runbook.md)** (operating withdrawals / treasury / limits / insurance) ·
**[docs/security-notes.md](docs/security-notes.md)** · **[DEPLOY.md](DEPLOY.md)** (deploy + env checklist).

---

## Accounts: auth, faucet, leaderboard, referrals

- **Auth (SIWS).** `nonce → wallet signMessage → server re-renders the canonical message → ed25519
  verify → short-lived access JWT + a rotating refresh token` with token-family reuse detection.
- **Delegated trading keys.** A full-scope wallet authorizes a fresh key (signed message) that receives
  a **`trade`-scoped** JWT — it can open/close positions but can never withdraw or manage identity.
  Powers bots and the official `gachadex` CLI / SDK ([docs/cli-spec.md](docs/cli-spec.md)); capped at
  `MAX_DELEGATED_KEYS`, bounded by `DELEGATE_MAX_TTL_DAYS`, and revocable (the pubkey is burned).
- **Faucet (play-money mode).** Credits play USDC from `FAUCET_SOURCE`, clamped so a user's available
  balance never exceeds $1,000,000. In real-funds mode the faucet is off — users fund via custody
  deposits instead (see [Custody & wallets](#custody--wallets-real-funds-mode)).
- **Leaderboard** (`GET /leaderboard`, public). Ranks traders by **net realized PnL**, derived from
  the ledger so it reconciles: `realized = (collateral + margin + LP-position value) − net deposits`.
  Equity and traded volume are shown as secondary columns; your own row is pinned when signed in.
- **Referrals.** Every account gets a unique `POKE-XXXXX` code at signup. Redeeming a code attributes
  the new account to the referrer (once) and, in play-money mode, pays **both** parties a bonus
  (default $1,000, clamped to the balance cap). The referrer is only paid for their first
  `MAX_REFERRALS_PAID` referrals (anti-farming). A `?ref=CODE` link is captured on first load and
  **auto-redeemed when the visitor signs in**, so attribution is reliable (not a manual step).
- **Affiliate / KOL economics.** Operators attach custom economics to a code in the admin **Affiliates**
  tab (`affiliate_terms`, linked to a wallet): a **cashback %** of the referees' trading fees — paid from
  the **house** revenue share (never the LP share) as real, withdrawable USDC — plus a **fee-discount %**
  on the affiliate's own trades (open + close; liquidation fees excluded). Cashback is capped at the house
  fee share (`100% − FEE_LP_SHARE_PCT`) and clamped at charge time so platform revenue can't go negative.
  An affiliate's lifetime cashback shows as a **Cashback** card in their Portfolio and the referral panel.
  **Platform-wide defaults** (operator-set, default 0) extend both knobs to *every* code with no active
  per-wallet terms, so a baseline cashback/discount can apply site-wide; an active `affiliate_terms` row
  overrides per wallet, and a deactivated row falls back to the default (resolved in one indexed lookup).

---

## Chat, social & DROP

A real-time **chat rail** runs alongside the exchange — server-authoritative like everything else,
streamed over the public `chat` WebSocket channel; the browser only renders. Built feature by feature
(spec: [docs/chat-social-spec.md](docs/chat-social-spec.md)):

- **Live chat** — post + read messages, with @-mention autocomplete and an emoji picker. History is
  persisted (`chat_messages`); the rail re-hydrates over REST and stays live over WS.
- **Action bars (BIG BET / BIG WIN).** The trading engine, *after* a trade commits (non-fatal to the
  trade), broadcasts a chat event when an open's notional clears `CHAT_BIG_BET_USD` (gold) or a close's
  realized profit clears `CHAT_BIG_WIN_USD` (green). Both are live-editable operator knobs.
- **Reactions.** Emoji reactions on messages (`chat_reactions`), broadcast as authoritative counts.
- **Identity.** Each handle shows the user's chosen **profile avatar** (a gen 1–5 Pokémon sprite set in the
  Portfolio banner; a deterministic default until they pick one) plus a leaderboard **rank badge** (👑#1 /
  🥈 / 🥉 / TOP 10 / TOP 100) from a ~60s-cached rank map; cumulative-volume **levels** back it (L1–L6).
- **Presence.** A live "● N online" count (connected sockets, including anonymous viewers).
- **Moderation.** Mods (and the operator via the admin key) soft-delete messages and mute/ban users;
  every action is an append-only audit row (`chat_mod_actions`). Mods act in-chat; the operator manages
  everything from the admin **CHAT** view. Mute/ban enforcement lives in the post path.
- **Readability.** The arcade skin renders chat text in a legible companion font (Pixelify Sans) while
  keeping Press Start 2P for brand/headers; messages group by consecutive author, with a hover toolbar
  (reply / react / mod) and a "new messages ↓" jump-to-bottom pill.

### DROP — the timed-giveaway pot

**DROP** is a flip.gg-style giveaway, built as a teaser first. A slim **DROP bar** pins to the top of the
chat (animated falling-`G` brand marks, "It's about to DROP") and opens a modal explaining the mechanic:
*the house opens a TCG GACHA pack — one eligible wallet wins the card drawn.* The **pot** is the
`DROP_POOL` ledger account:

- **Player tips.** Signed-in users tip **real USDC** into the pot (`USER_COLLATERAL → DROP_POOL`,
  validated against their available balance under a row lock, recorded in `drop_tips`). Gated by
  `DROP_TIPS_ENABLED` — **off by default**, so the pot never takes real money until an operator opts in.
- **Pot is operator-only.** The running pot total is shown in the admin CHAT view (plus a per-customer
  **Tips** column in the Customers view) but is **not** exposed to customers (UI, public API, or WS).
- **Deferred (Phase 2):** the round worker (single-leader via a `worker_leases` lease, scheduled by
  `DROP_INTERVAL`), the on-chain draw of a random eligible wallet (deposited **or** holding ≥ `DROP_GDEX_MIN`
  $GDEX), buying/opening the pack via the **rare.win** API, and the NFT prize (sell-back for USDC or keep).
  These need rare.win API access and are not built yet.

### Admin **Customers** view (operator tab)

One row per user — wallet, deposit address, balances, LP, volume, fees/funding, realized/unrealized P/L,
deposits/withdrawals/tips — paginated + sortable, with operator close actions (one position, one customer,
or a kill-switch across all). Each active customer expands to a drill-down with two tabs:
- **Positions** — open positions per market (entry, mark, uP/L, margin, liq, **open date**), with per-row close.
- **History** — deposits, withdrawals, and completed trades merged reverse-chronologically, each **dated**,
  with amount + status. (Sourced from the existing per-user history queries; no separate store.)

### Admin **CHAT** view (3rd operator tab)

A dedicated operator tab alongside Main + Customers, all under the admin key:

- **Thresholds** — the BIG BET / BIG WIN knobs (live `settings`).
- **DROP config + pot** — interval / house-floor / pack-tier / GDEX-min knobs, the read-only eligibility
  mint, the live `DROP_POOL` pot balance, total tipped, and recent tips.
- **Moderation** — grant/revoke MOD (by wallet **or** user id), the muted/banned lists with unmute/unban,
  and the mod-action audit log.

### Admin **Affiliates** view (operator tab)

Manage KOL / affiliate codes (a 4th operator tab). Lists every affiliate — code, wallet, **cashback %**,
**fee-discount %**, referrals, lifetime cashback paid, active — with a create-or-edit form (wallet +
optional branded code + the two %s + a label) and an activate/deactivate toggle. Percentages in the UI,
basis points over the wire; cashback is capped at the house fee share (`100% − FEE_LP_SHARE_PCT`), enforced
both client-side and in the service. Linking a code creates the wallet's account if it has never signed in.

A **Platform defaults** form (same tab) sets a baseline **cashback %** + **fee-discount %** that apply to
*every* referral code without its own active terms — so a site-wide baseline can apply without touching
each wallet. An active per-wallet row **overrides** the default (set one to **0%** to zero a specific wallet
out); a **deactivated** row reverts to the platform default, not to zero. Both default to **0** (the feature
is dormant — no behavior change until set), stored as live knobs (`platform_cashback_bps` /
`platform_fee_discount_bps`), so they tune without a deploy and respect the same cashback ceiling.

---

## Classic Gacha — Collector Crypt real-NFT packs (real-funds, LIVE)

A Games-page surface that resells **Collector Crypt (CC)** graded-card gacha packs. Buy a pack with your
GachaDex balance → GDEX pays CC on-chain → **CC's draw (its own VRF — we don't run the RNG)** reveals and
delivers a **real graded-card NFT** into your GDEX custody wallet. Then **sell it back** (GDEX keeps **5%**,
or **10%** on an instant sell-on-reveal), **withdraw** the real NFT to an external wallet (step-up signed),
**convert** it (sell-back → open a perp on that card's market with the proceeds), or **trade** the matched
market. **Live in prod** behind `CLASSIC_GACHA_ENABLED` (on) and **real-funds-gated** (the open/sell/withdraw
routes 403 in play-money). Held NFTs live in **Portfolio → Inventory** and in the lobby's "Your pulls". Spec:
`docs/classic-gacha-cc-packs-spec.md`.

### Economics & EV calibration

Because the draw is CC's, **GDEX does not design the prize odds or house edge** — this is a margin business,
not a prize-table business. "EV calibration" here means two things:

1. **Read CC's per-machine numbers.** `/api/machines` returns, per machine, CC's expected insured value
   (`ev`), the rarity `tierRanges` ($ bands), per-tier `odds`, `instantBuyback` % (what CC pays to buy a card
   back), and current `stock` per tier. You don't change these — you use them to pick which machines to
   feature/enable and to understand the sell-back economics per price tier ($25/$50/$100/$250/$1000).
2. **Set GDEX's margin knobs so the house nets positive.** Three live-tunable knobs (admin **Gacha** tab):
   the **sell-back cut** (5% manual / 10% instant), an optional **purchase markup** (default 0), and the
   **free-pack rebate** (**Gold** loyalty, flag `GOLD_ENABLED`: ~**2.5%** of every paid open accrues as
   **Gold** toward a free `$25` pack at the `$1000`-spend threshold — valued `1,000 Gold ≈ $1`, so
   `25,000 Gold = a free $25 pack`; earned via the `PACK_OPEN_EARN` ledger reason into `gold_balances` /
   `gold_ledger`, non-withdrawable, funded as real USDC from the `GACHA_REWARDS_BUDGET` account).

   The tension: **the rebate is paid on _every_ open, but the cut is earned only on _sold-back_ opens.** So
   there's a break-even sell-back rate — at the default 5% cut and ~2.5% rebate (≈ `$1.10` cut on a ~`$22`
   buyback vs ~`$0.63` rebate on a `$25` pack): **break-even ≈ 57% sell-back**. The operator's CC data shows
   ~90% sell back, so the spec concludes **no markup is required** — but if real players _hold or withdraw_
   more than expected (especially grail buyers on the `$1000` machine), the rebate can outrun the cut and the
   house bleeds; the markup knob is the backstop. With `GOLD_ENABLED` **off** there is **no rebate liability**
   at all — the cut + markup is pure margin and the 57% figure doesn't apply.

   **Calibrating concretely:** decide on Gold, set the knobs for the expected sell-back behavior, **pre-fund
   `GACHA_REWARDS_BUDGET`** to cover the free-pack liability, then watch the monitoring readout (below) — the
   live sell-back rate vs the 57% break-even, and the **per-machine net** — and adjust the knobs live (or
   disable / mark-up a tier that's net-negative).

### Operations — the `/api/machines` feed, monitoring, and recovery

- **Call cadence.** `GET /gacha/machines` is **server-side cached** — CC's `/api/machines` is hit at most
  **once per a global interval** (the admin `stockRefreshSecs` knob, default **30s** / floor **15s**) for all
  customers, with an admin global **pause** and **refresh-now**. The customer lobby fetches once per page load
  (no client polling); the admin Gacha tab re-fetches every 30s while open.
- **What the feed carries vs what's shown today.** The payload already includes per-tier **stock**, **odds %**,
  **$ ranges**, **EV**, and **buyback %**. The **player lobby** shows EV, buyback %, and the per-tier odds bars
  for the selected machine. The **admin tab** currently shows only the machine name/price + enable toggle —
  **there is no operator stock / restock / cross-machine-odds view yet** (the data is fetched but not
  surfaced; a per-machine live stock+odds panel with restock highlighting is a planned add).
- **Monitoring readout** (admin Gacha tab): the §6 economics (sell-back cut + markup revenue vs Gold-rebate
  cost, the operator net, and the live sell-back rate vs the ~57% break-even); activity (packs opened all-time
  + 24h, USDC volume, prize value, biggest pull, players, withdraws, realized rarity odds); **per-machine**
  opens, net, and realized odds; and **stuck-row counts**.
- **Crash recovery & money-safety (unattended).** Every charged-but-undelivered outcome self-heals; the live
  fixes are status-guarded + idempotent, so they're safe on boot, on a timer, and on any number of instances:
  - **Stuck pack-buys → auto-refund.** A buy whose pack crashed before delivering sits `paid`. `reconcileAllPending`
    (boot + every 2 min, **all users** — not just the on-demand per-user `reconcilePending`, which only ran when
    that customer reopened the lobby) refunds it and claws back any loyalty Gold earned on it.
  - **Stuck NFT ops → reconcile on-chain.** `reconcileStuckPrizes` (boot + admin **Reconcile**) reads each NFT's
    DAS owner: in custody → `held`; gone for a withdraw → `withdrawn`; **sold-but-unsettled → auto-credits the
    seller** from CC's confirmed buyback (was: flag for a manual credit). Grace window (default 300s).
  - **DAS-gated reverts.** A sell-back/withdraw whose submit times out *after* the on-chain move no longer reverts
    to `held` (which stranded the seller's money) — it reverts only when DAS confirms the NFT is still in custody,
    else it's left for the reconciler.
  - **Re-circulated NFTs.** CC recycles a sold-back card and re-rolls it to a new buyer; the inventory write keys
    on a **partial unique** (one *active* holder per mint) + the open id, so a re-roll records correctly instead of
    being silently dropped against the prior holder's stale `sold` row.
  - **Stranded custody USDC → swept to hot.** A crash between fund-custody and the CC payment parks the pack price
    in a custody wallet (uncounted in PoR). With `GACHA_AUTO_SWEEP_ENABLED=true` the reconcile loop returns it to
    hot automatically (custody→hot, our own wallets, skips any wallet with a live open); **OFF by default**.
  - **Admin surfacing.** The Gacha tab shows stuck `selling`/`withdrawing`, **paid-but-undelivered** opens, and a
    **Scan custody wallets** button (on-demand on-chain scan of stranded USDC).
  - **Operator scripts** (`railway run`, dry-run first): `scripts/sweep-custody-leftovers.ts` (custody→hot sweep,
    the manual backstop to the auto-sweep) and `scripts/backfill-recirculated-nfts.ts` (re-checks each NFT's
    on-chain owner and writes the missing `held` row for a delivered-but-unrecorded NFT).
  - **Known issues (CC-API audit, 2026-06-29)** — a doc-vs-code pass ([docs.collectorcrypt.com/gacha/api](https://docs.collectorcrypt.com/gacha/api))
    surfaced (status tagged):
    - **#7 — sell-back UI overstates the payout (display only; ledger is correct). DEFERRED.** The "Sell back $X"
      button and the post-sale "+$X added to your balance" show `insured_value × (1 − our cut)`, but CC pays a
      buyback **percentage** (`instantBuyback`, ~85%) capped at $40k, so the real credit is
      `min(insured × buyback%, $40k) × (1 − cut)` — e.g. a card shown as $90 credits ~$76.50. The post-sale line
      is the worst part (a wrong number for a *completed* sale). The API already returns the true `payoutE6`; the
      web discards it. Web-only fix (use `payoutE6` for the confirmation; apply buyback% + cap to the estimate);
      reveal + multi-pull summary only (the inventory list shows no quote).
    - **#8 — operator-disabled machines were still buyable via `POST /gacha/open`. FIXED — merged to `master`, live.**
      `openPack` didn't consult `gachaConfig.disabledMachines` (enforced only in the lobby list + admin display),
      so the default-disabled `pokemon_2500` / `pokemon_5000` / `pokemon_151` packs could be opened by a direct
      call. `openPack` now rejects a disabled code (403 `machine_disabled`) before charging.
    - **Secondary.** `insured_value` is read from an undocumented `openPack` attribute with no fallback (verify it's
      populated in prod, else cards store `$0`); a `'submitted'` payment makes the immediate reveal `404` → a raw
      error on a *paid* pack (the reconciler heals it); transient `generatePack` errors ("retry shortly", 503)
      become a terminal refund; CC's `public` / `/api/status` (closed/stopped) flags aren't consulted; the 72h
      buyback window + $40k cap aren't surfaced pre-sale. (#4 phantom/non-deliverable refund + #5 a crashed
      instant-sell settling at 5% not 10% were reviewed as defensive / intentional, not defects.)

---

## Architecture

```
  Scrydex (raw TCGplayer + graded ladder; primary)  +  tcgpricelookup (eBay cross-check + fallback)
                          │                              [pokemontcg.io = legacy feed · ORACLE_PRIMARY picks]
              ┌───────────▼─────────────┐
              │  oracle (timer, 6h       │  Scrydex-anchored price + eBay confidence gate + §6a mark guard,
              │  + Scrydex webhook)      │  hybrid dedup, staleness halt, GJ/G&P/Pokedaq index series over
              │  src/services/oracle.ts  │  Top-100/250 + Graded baskets, recompute marks
              └───────────┬─────────────┘
                          │ publishes mark/stats/oi/funding
   apps/web (React SPA)   │            ┌──────────────────────────────────────┐
   ── REST ───────────────┼───────────▶│  apps/api (Fastify + ws)             │
   ── WebSocket ◀─────────┼────────────│  auth · markets · orders · account · │
                          │            │  lp · social · /ws hub               │
                          │            └───────────┬──────────────────────────┘
                          │                        │ commands (single-writer / market)
                          │            ┌───────────▼──────────────────────────┐
                          │            │  engine  src/services/engine.ts       │
                          │            │  open/close · mark · funding · liquidations
                          │            └───────────┬──────────────────────────┘
              ┌───────────▼─────────────┐  ┌───────▼─────────┐  ┌──────────────────┐
              │ Postgres / PGlite        │  │ in-process bus  │  │ reconciler       │
              │ ledger, balances,        │  │ → WebSocket hub │  │ balances==Σledger│
              │ markets, positions, lp…  │  │ (src/services/  │  │ src/services/    │
              └──────────────────────────┘  │  bus.ts, ws.ts) │  │ reconcile.ts     │
                                            └─────────────────┘  └──────────────────┘
```

The browser holds no money state. Money-critical state is re-hydrated via REST on (re)connect, then
kept live over WebSocket. Public channels (`mark`, `stats`, `oi`, `funding`) are open; private
channels (`positions`, `orders`, `balance`, `liquidations`, `lp`) require an authed socket and only
deliver the caller's own data.

### Monorepo layout

```
gachadex/                   (pnpm workspaces + Turborepo)
  apps/web                  React 19 + Vite SPA — Vercel (8 selectable skins; default "gachadex" modern, arcade = retro pixel)
  apps/api                  Fastify + WebSocket backend: ledger, engine, oracle, liquidations, custody
  packages/pricing          Shared money math (price/PnL/margin/liq/mark) — FE previews must equal the engine
  packages/shared-types     Shared zod schemas + constants for the REST + WebSocket contracts
```

`packages/pricing` is the single source of truth for money math, imported by **both** the API and
the web app, so the liquidation price / fees the user previews are exactly what the engine computes.

### Data model (Postgres / PGlite)

`users · sessions · auth_nonces · delegated_keys` (auth: SIWS sessions + scoped trading keys) ·
`accounts · ledger_entries · balances` (double-entry core) ·
`markets · oracle_prices · marks · index_constituents · index_divisors · market_restriction_events`
(pricing; `markets.game` ∈ pokemon / onepiece / mtg) ·
`orders · fills · positions · funding_rates · liquidations` (trading) ·
`lp_pool · lp_positions` (liquidity) · `deposit_addresses · deposits · withdrawals · system_flags ·
settings · worker_leases · provider_rate` (real-funds custody + operator config + provider rate-limit) ·
`chat_messages · chat_reactions · chat_mod_actions · drop_tips` + mod flags on `users` (chat & social) ·
`gold_balances · gold_ledger` (loyalty **Gold**) · `gacha_pack_opens · gacha_nft_inventory ·
gacha_machine_stock · gacha_restock_events` (**Classic Gacha** — CC real-NFT packs).
The same `schema.sql` runs on PGlite locally and on managed Postgres in prod; it's idempotent and
applied on boot (`db/migrate.ts`).

---

## API surface

**REST** (`apps/api/src/routes`):

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /auth/nonce` · `POST /auth/verify` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` | mixed | SIWS login + session rotation |
| `POST /auth/delegate/nonce` · `POST /auth/delegate` · `GET /auth/delegates` · `POST /auth/delegates/:pubkey/revoke` | full | Mint / list / revoke scoped **delegated trading keys** (full-scope only) |
| `GET /markets` · `GET /markets/:id/candles` · `GET /markets/:id/details` | public | Market list, chart series, card metadata + graded price |
| `GET /catalog/search` · `POST /markets/ensure` | trade | Search-and-bet: browse the provider catalogue, list a market on demand (gated; real-funds listing needs the NAV caps armed) |
| `GET /account/balance` · `POST /faucet` | yes | Balance/equity; claim play USDC |
| `GET /positions` · `POST /orders` · `POST /positions/:id/close` | yes | Open positions; place/close perps |
| `GET /lp/pool` · `GET /lp/position` · `POST /lp/deposit` · `POST /lp/withdraw` | mixed | LP pool state + provide/withdraw liquidity |
| `GET /leaderboard` · `GET /referral/me` · `POST /referral/redeem` | mixed | Leaderboard (public, optional viewer); referral code + redeem |
| `GET /wallet/deposit-address` · `POST /wallet/withdraw/nonce` · `POST /wallet/withdraw` · `GET /wallet/transactions` | yes | Real-funds custody: deposit address, withdraw (wallet step-up), wallet history |
| `/admin/markets/:id/price` · `/admin/treasury` · `/admin/insurance/*` · `/admin/custody-limits` · `/admin/withdrawals/*` · `/admin/freeze` · `/admin/customers` · `/admin/customers/:id/{positions,history}` · `/admin/chat/*` · `GET/POST /admin/affiliates` · `/admin/perks/signup-credit{,/config,/fund,/review/:userId}` · live knobs `/admin/{fee,liq-fee,funding-factor,mark-clamp,withdrawal-auto-process}` · `/admin/{restrictions,mark-guards}` | admin key | Operator ops (manual pricing always; custody ops under real funds) + Customers / CHAT / Affiliates / **Perks** (free signup credit) views, the live-tunable engine knobs, and the price-confidence / mark-guard panels — see [docs/ops-runbook.md](docs/ops-runbook.md) |
| `GET /chat` · `POST /chat` · `/chat/messages/:id/react` · `/chat/ranks` · `/chat/profile/:id` · `GET /chat/drop/pot` · `POST /chat/drop/tip` · mod routes | mixed | Live chat: read/post, reactions, rank map, profile card, DROP pot tips (real USDC), mod actions |
| `POST /webhooks/scrydex` | HMAC | Scrydex push re-pricing (Stripe-style `t=,v1=` signature over the raw body); active only under `ORACLE_PRIMARY=scrydex` |
| `GET /health` | public | Health check |

**WebSocket** `GET /ws` — subscribe to `mark:{id}`, `stats:{id}`, `oi:{id}`, `funding:{id}` and the
`chat` channel (messages, action bars, reactions, deletes, presence) — all public — and
`positions:{userId}`, `orders:{userId}`, `balance:{userId}`, `liquidations:{userId}`, `lp:{userId}`
(after sending `{op:'auth', token}`).

---

## Configuration

All config is read from the environment in `apps/api/src/config.ts` (never hardcoded, never shipped
to the browser). Copy `apps/api/.env.example` → `apps/api/.env`; every key has a safe default. Key ones:

| Var | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `4000` / `0.0.0.0` | API bind |
| `WEB_ORIGINS` | `localhost:5173,4173` | CORS allow-list (set to your Vercel URL in prod) |
| `DATABASE_URL` | _(empty)_ | Empty → embedded PGlite; set to managed Postgres in prod |
| `PGLITE_DIR` | `./.pglite` | Local embedded-DB dir (use `memory://` for ephemeral) |
| `JWT_SECRET` | dev default | **Must** be a strong ≥32-char value in production (boot refuses otherwise) |
| `MAX_DELEGATED_KEYS` / `DELEGATE_MAX_TTL_DAYS` | `4` / `180` | Per-account cap + max lifetime for delegated trading keys |
| `ORACLE_PRIMARY` | `pokemontcg` | Active price feed: `pokemontcg`, `tcgpricelookup`, or `scrydex`. **Prod runs `scrydex`** (cutover complete) — Scrydex anchors the price, tcgpl is the eBay cross-check + fallback. Flip at boot, no deploy |
| `TCGPRICELOOKUP_API_KEY` | _(empty)_ | Trader-plan key for the multi-game raw+graded feed; a DB-backed limiter paces 1 req/s + `TCGPRICELOOKUP_DAILY_CAP` (10k/day) across instances |
| `POKEMONTCG_API_KEY` | _(empty)_ | Legacy fallback feed; optional, keyless works at lower rate limits |
| `SCRYDEX_API_KEY` · `SCRYDEX_TEAM_ID` | _(empty)_ | Scrydex auth (`X-Api-Key` + `X-Team-ID`) — the **live** TCGplayer-anchored raw + graded feed under `ORACLE_PRIMARY=scrydex` |
| `SCRYDEX_WEBHOOK_SECRET` · `SCRYDEX_DAILY_CAP` | _(empty)_ / `1600` | `whsec_…` HMAC secret for `POST /webhooks/scrydex` push re-pricing · daily Scrydex request guard |
| `FX_BASE` | `https://api.frankfurter.dev` | ECB FX source (Frankfurter) for JPY→USD on Japan-priced cards (Scrydex path) |
| `ORACLE_REFRESH_MS` / `ORACLE_PAGE_SIZE` | `6h` / `250` | Ingest cadence; page size (pokemontcg caps at 250 upstream) |
| `DISCOVERY_INTERVAL_MS` / `RETIRE_AFTER_DAYS` | `7d` / `30` | Weekly featured-set rebalance; cull dead long-tail markets (no OI/volume) |
| `SEARCH_AND_BET` | `true` | Catalogue search + on-demand listing (tcgpricelookup only; real-funds listing also needs the NAV caps) |
| `JUSTTCG_API_KEY` / `GRADED_CONSTITUENTS` | _(empty)_ / `100` | Graded prices come from **Scrydex first** (full PSA/BGS/CGC ladder), tcgpl eBay as fallback; JustTCG is a last-resort PSA-10 fallback for cards neither covers (key enables it) |
| `REAL_FUNDS` | `false` | `false` = play-money (faucet). `true` = real custody (deposits/withdrawals); requires the custody vars below |
| `ALLOW_MAINNET_FUNDS` | `false` | Must be `true` to run real funds on **mainnet** (the audit/KYC/geofence acknowledgement) |
| `SOLANA_RPC_URL` | devnet | Backend Solana RPC — point at a **mainnet** provider for real funds |
| `USDC_MINT` · `TREASURY_PUBKEY` | _(empty)_ | USDC SPL mint (mainnet `EPjF…Dt1v`) · cold treasury (Squads multisig) address |
| `DEPOSIT_MASTER_SEED` · `HOT_WALLET_SECRET` | _(empty)_ | Custody keys (real-funds) — set in the host's secret store, never committed |
| `ADMIN_API_KEY` | _(empty)_ | ≥32 chars; enables the `/admin` operator routes |
| `HOT_WALLET_MAX_USD` · `WITHDRAWAL_DAILY_CAP_USD` · … | see config.ts | Custody limits — defaults here, **live-editable in the admin panel** |
| `WITHDRAWAL_AUTO_PROCESS` | `false` | Boot default for the auto-withdrawal-approval toggle; flip it live from the admin panel (OFF = all withdrawals need manual approval) |
| `OI_CAP_NAV_BPS` · `MAX_PNL_FACTOR_BPS` · `ADL_PNL_FACTOR_BPS` | `0` (off) | Pool-risk caps (NAV-relative OI · open-gate · ADL); turn on for real funds |
| `FAUCET_DEFAULT_USD` | `10000` | Per-claim play USDC (balance capped at $1M) |
| `REFERRAL_BONUS_USD` / `MAX_REFERRALS_PAID` | `1000` / `50` | Referral payout (both parties) + per-referrer cap |
| `FEE_BPS` / `FEE_LP_SHARE_PCT` | `0` / `50` | Trading commission (bps; **default off**, charged on both open + close) + the LP share of it; live-editable in admin. `FEE_LP_SHARE_PCT` also caps affiliate cashback at `100 − it`% (the house keeps the rest) |
| `LP_FUNDING_SHARE_PCT` / `LP_LIQ_SHARE_PCT` | `80` / `60` | LP's share of **funding** + the **liquidation penalty** (the rest → house `FEE_REVENUE`). All three LP shares are live-editable in the admin **"LP Fee Sources"** panel; the pool page shows a separately-published snapshot (operator "Refresh pool numbers") |
| `FUNDING_SKEW_FACTOR_BPS` / `FUNDING_INTERVAL_MS` | `30` / `1h` | Funding rate cap + cadence (each settlement splits LP/house per `LP_FUNDING_SHARE_PCT`) |
| `LIQ_FEE_BPS` / `LIQUIDATION_SWEEP_MS` / `ORACLE_STALE_MS` | `100` / `5s` / `36h` | Liquidation penalty (split LP/house per `LP_LIQ_SHARE_PCT` — it **no longer auto-funds insurance**), sweep, staleness halt |
| `CHAT_BIG_BET_USD` / `CHAT_BIG_WIN_USD` | `500` / `100` | Chat action-bar thresholds (USD; live-editable in the admin CHAT view) |
| `DROP_TIPS_ENABLED` | `false` | Opens **real-USDC** player tipping into the DROP pot — keep off until the draw/payout ships |
| `DROP_TIP_MIN_USD` / `DROP_TIP_MAX_USD` | `1` / `10000` | Per-tip bounds (USD) |
| `DROP_INTERVAL_MIN` / `DROP_HOUSE_FLOOR_USD` / `DROP_GDEX_MIN` | `60` / `250` / `500000` | DROP round knobs (Phase 2 mechanic) |
| `RESTING_ORDERS_ENABLED` | `false` | Gates **Limit / Stop-Loss / Take-Profit** resting orders (all fill at the mark; SL/TP are reduce-only position brackets = a free OCO). Ships **dark** — the routes 404 + the sweep no-ops until `true` |
| `GAMES_ENABLED` | `false` | Gates the **Games** surface (provably-fair USDC games). One switch — reveals the customer Games tab/page **and** enables the game APIs together. Ships **dark** |
| `CLASSIC_GACHA_ENABLED` | `false` | Gates **Classic Gacha** (Collector Crypt real-NFT packs). **On in prod** — open/sell/withdraw routes also require real-funds (403 in play-money) |
| `GOLD_ENABLED` | `false` | Loyalty **Gold** — pay-with-Gold + the ~2.5% free-pack rebate earn (the `gold_balances`/`gold_ledger` ledger). **On in prod**. The free-pack liability is pre-funded into the `GACHA_REWARDS_BUDGET` account (not an env var) |
| `GACHA_AUTO_SWEEP_ENABLED` | `false` | Lets the reconcile loop auto-sweep stranded custody USDC (pack price parked by a crash between fund-custody and CC payment) back to hot. **On in prod** |

---

## Develop

Requires **Node ≥ 20** and **pnpm**.

```bash
pnpm install

pnpm dev            # run web + api together (turbo)
# or individually:
pnpm dev:web        # Vite SPA   → http://localhost:5173
pnpm dev:api        # Fastify api → http://localhost:4000  (ingests live data ~1.5s after boot)
```

The web app reads `VITE_API_URL` (default `http://localhost:4000`) and derives the WebSocket URL
from it. If you run the API on a different port, start the web with
`VITE_API_URL=http://localhost:<port>` and make sure that web origin is in the API's `WEB_ORIGINS`.

With no `DATABASE_URL`, the API uses an embedded **PGlite** database under `apps/api/.pglite/`
(zero system deps). On first boot the oracle ingests live prices, so the markets populate on their own.

```bash
pnpm build          # build/typecheck all workspaces
pnpm lint           # lint (web) + tsc typecheck (api)
pnpm test           # api (node:test on PGlite) + pricing property tests
```

The default run mode is **play money** (`REAL_FUNDS` unset → faucet, no custody). `pnpm dev:api` boots on
PGlite and ingests live prices a moment after boot, so markets self-populate — no setup. To run a single
test file: `cd apps/api && npx tsx --test src/services/<name>.test.ts`.

### Codebase conventions & how to add a feature

**Invariants every change must respect:**

- **Money is `BIGINT` micro-USDC (`*_e6`)** — never floats; JSON encodes them as decimal strings. The
  shared math lives in **`packages/pricing`** and is imported by **both** the api and the web app, so the
  liquidation price / fee / PnL the UI previews is exactly what the engine computes. Don't recompute money
  math in a component — call `@pokex/pricing`.
- **Double-entry ledger.** Every value movement is a balanced `ledger_entries` transaction (Σ per `txn_id`
  = 0); `balances` is a cache. Move money through `services/ledger.ts`, never by writing `balances`
  directly — the reconciler (`services/reconcile.ts`) asserts it stays balanced.
- **Server-authoritative.** The browser renders; all money state arrives from the api over REST (hydrate)
  + WebSocket (live). Never trust client-supplied prices/amounts.
- **Single-writer per market + idempotency.** Engine operations take an in-process lock **and** a Postgres
  advisory lock, and carry a client idempotency key — replays return the prior result.

**The wiring patterns you'll reuse:**

- **A REST endpoint** is a Fastify plugin in `apps/api/src/routes/*.ts`, registered in `src/server.ts`
  (`buildServer`). Authed routes declare `{ preHandler: authenticate, config: { scope: 'trade' | 'full' } }`
  — a route-walk test fails any authed route missing an explicit scope (fail-closed → `full`). Wrap
  abuse-prone routes with `rl(config.routeRateLimits.<x>, …)` (`routes/_ratelimit.ts`). Throw
  `HttpError(status, message, code?)` for errors. Request/response shapes are **zod schemas in
  `packages/shared-types`** — the REST/WS contract the SDK consumes; additive changes are free, breaking
  ones bump `API_VERSION` (`server.ts`).
- **Business logic** goes in `apps/api/src/services/*.ts` (the route stays a thin handler; the service does
  the work and posts the ledger transactions).
- **A DB change** is idempotent DDL appended to `apps/api/src/db/schema.sql` (`CREATE TABLE/INDEX IF NOT
  EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`) — there are no separate migration files; the whole
  schema is re-applied on every boot (`db/migrate.ts` → `db.exec`). `pnpm --filter @pokex/api db:reset`
  wipes the local PGlite DB.
- **A live-tunable operator knob** uses `liveKnob(settingKey, default, validate)` (`services/live-knob.ts`):
  the config value is the default, an operator override in the `settings` table overlays it, and it's
  cached for synchronous hot-path reads (boot-loaded + refreshed ~30s in `index.ts`). Surface it in the
  admin panel. Examples: `services/fees.ts`, `chat-config.ts`, `drop-config.ts`, `signup-credit-config.ts`.
- **Pushing to the client over WebSocket** is `publish(channel, type, data)` (`services/bus.ts`); the WS
  hub (`plugins/ws.ts`) forwards to subscribers. Public channels are `mark|stats|oi|funding:{marketId}`
  and `chat`; private channels `positions|orders|balance|liquidations|lp:{userId}` require an authed
  socket. The web side subscribes and handles frames in a zustand store (`apps/web/src/store/*` +
  `lib/ws.js`).
- **Frontend** is React 19 + zustand + plain CSS under `apps/web/src` (`components/`, `store/`, `lib/api.js`,
  `lib/ws.js`). Theming is token-driven (`index.css` + `themes.css`, `store/theme.js`); a feature renders
  across all 8 skins by using the CSS tokens (`--bg`, `--gold`, `--accent`, …) rather than hardcoded
  colors/fonts. Check `mockups/*.html` + `references/*.png` for the approved design before building a UI
  control.

**Testing.** Tests are `node:test` on an in-memory PGlite. The setup pattern: set `PGLITE_DIR=memory://`,
`DATABASE_URL=''`, and a ≥32-char `JWT_SECRET`, then `await initDb()` and dynamically `import` the service
under test (see any `services/*.test.ts`). The reconciler runs in tests, so a money bug usually surfaces as
an unbalanced-ledger assertion. Run the full suite (`pnpm test`) before committing.

### Deployment topology (hybrid)

- **Frontend → Vercel** (static SPA). Set the project **Root Directory** to `apps/web` and
  `VITE_API_URL` to your backend URL.
- **Backend → a long-running host** (Railway / Render / Fly.io). The engine, WebSocket hub, and the
  funding/liquidation/oracle loops need a persistent process — Vercel's serverless model can't host them.
- **Database → managed Postgres** (Neon / Supabase) via `DATABASE_URL`. The same SQL runs locally on PGlite.

See **[DEPLOY.md](DEPLOY.md)** for the step-by-step deploy + the per-host env checklist (including the
real-funds / custody variables).

---

## Testing

- **API** (`apps/api/src/**/*.test.ts`, run with `node:test` on an in-memory PGlite): ledger
  conservation, SIWS auth, oracle ingest + median price/dedup + index NAV, the trading engine
  (open/increase/close, margin, liq price, idempotency under contention), LP deposit/withdraw,
  funding, liquidations + bad-debt socialization, leaderboard + referrals, and a chaos test of
  concurrent activity. The reconciler asserts the ledger stays balanced after every scenario.
- **pricing** (`packages/pricing`): property tests for NAV, margin, liquidation price, PnL, fees, and
  the synthetic mark (conservation + rounding-against-the-user).

---

## Status & what's deferred

The engine is complete end to end — ledger → SIWS auth → oracle/marks → trading → LP + fees + funding
→ liquidations → UI, plus the leaderboard and referral system. **Real-funds custody is built**:
per-user deposit addresses + sweeps, hot/cold treasury with proof-of-reserves + auto-freeze,
withdrawals (manual + capped auto-approve), the insurance fund, and live-editable custody limits. The
pool-protection engine (adaptive depth, NAV-relative OI caps, pool-health gate, ADL) ships too, and a
marketing landing page is the public entry point. The platform is **multi-game and live across all
three** — `markets.game` (Pokémon / One Piece / Magic), a per-game index catalogue in **three weighting
series** (GJ / G&P / Pokedaq), the **Scrydex-primary** feed (tcgpl eBay cross-check + One Piece fallback)
with a **Scrydex graded** ladder, a sidebar **game switcher**, a Markets page with an **Indices | Cards**
toggle (a financial **Index Overview** table — per-game, per-series, with 1D/1W/1M/YTD + 52W — alongside a
sortable card screener with a JPY toggle), and **8 UI skins**. **Delegated trading keys** (scoped, revocable) back the official
`gachadex` CLI / SDK and **search-and-bet** (on-demand market listing). A **chat & social layer** ships
alongside — live chat with reactions, **profile avatars** + a Portfolio identity banner, leaderboard rank
badges, presence, and moderation, plus the **DROP** giveaway-pot teaser with real-USDC player tipping
(flag-gated, **off by default**).

Two **flag-gated surfaces** ship **dark** alongside the live engine: **Limit / Stop-Loss / Take-Profit**
resting orders (`RESTING_ORDERS_ENABLED` — all fill at the mark; SL/TP are reduce-only position brackets,
a free OCO) and a **Games** surface of provably-fair USDC games (`GAMES_ENABLED`). The LP's cut of every
revenue stream — **trading fees / funding / liquidation penalties** — is **operator-configurable** (admin
**"LP Fee Sources"**), and the pool page surfaces LP **earnings + APY** from an operator-published snapshot.

**Operator responsibility before real money on mainnet:** the security audit, KYC/AML, and geofencing
are yours to put in place — the code only gates on `ALLOW_MAINNET_FUNDS=true`, it does not verify them.

**Classic Gacha** (Collector Crypt real-NFT packs, section above) is **merged and LIVE in prod** —
`CLASSIC_GACHA_ENABLED` is **on** (the flag still defaults off in code) + real-funds-gated, and customers
are pulling real packs. The unattended money-safety + CC-API-audit fixes (auto-refund / sweep / reconcile,
plus the #1/#2/#3/#6/#8 fixes + affiliate-on-delivery) are all merged + live; the remaining deferred/open
items (#7 sell-back display, the secondary list) are tracked in the Classic Gacha section above. An
operator **per-machine stock + odds + restock** panel is still planned (the data is already in the feed,
just not yet surfaced in the admin tab).

Still deferred: the full **DROP** round mechanic (the scheduled draw, the rare.win pack-open, and the
on-chain NFT prize — needs rare.win API access), the **Sealed** price feed (the Sealed index stays gated
until a sealed-product source is wired), Scrydex **population reports** + full JustTCG retirement, a Go
engine rewrite, and the **KMS-held deposit seed** (`DEPOSIT_SEED_KMS_REF` is recognized but throws "not
implemented" — use `DEPOSIT_MASTER_SEED` for now).
