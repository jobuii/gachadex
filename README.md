# GachaDex

A **leveraged perpetual-futures exchange on Pokémon-card prices**, settled in USDC. Trade
perps on individual cards **and** on basket **indices** (Top 100 / Top 250, with Graded and
Sealed planned), with an index-anchored synthetic mark, a pooled-LP counterparty, funding,
and liquidations — plus a leaderboard, referrals, and a **live chat & social layer** (reactions,
rank badges, presence, moderation, and a **DROP** giveaway pot).

> **Two run modes.** The same engine runs on **play money** (a faucet, for demo/testing) or on **real
> funds** — USDC custody with on-chain deposits/withdrawals on **Solana mainnet** — selected by the
> `REAL_FUNDS` flag. Real-funds mode needs the full custody config and, on mainnet, an explicit
> `ALLOW_MAINNET_FUNDS=true`: the boot gate that acknowledges the operator has handled the audit /
> KYC-AML / geofence prerequisites for holding customer money. See
> [Custody & wallets](#custody--wallets-real-funds-mode).
>
> A fan project built on public Pokémon-TCG price data (via [pokemontcg.io](https://pokemontcg.io));
> **not** affiliated with Nintendo, The Pokémon Company, or TCGFish, and **not financial advice**.

---

## What you can do (V1)

- **Sign in with your Solana wallet** (Sign-In-With-Solana) — no passwords, no email.
- **Fund your account** — claim **faucet** play-USDC (play-money mode), or **deposit real USDC** to a
  per-user Solana deposit address and **withdraw** back out (real-funds mode).
- **Open leveraged perps**, long or short, up to **20×**, on any card market or on the Top
  100 / Top 250 index.
- **Manage positions** — partial or full close, live unrealized PnL, liquidation price.
- **Provide liquidity** to the LP pool (the counterparty to all trades) and earn fees + trader PnL.
- **Leaderboard** — traders ranked by net realized PnL (with equity + volume).
- **Referrals** — every account gets a shareable code; redeeming one pays both sides a play-USDC bonus.
- **Chat & socialize** — a live chat rail with emoji reactions, leaderboard **rank badges**, an
  online-presence count, and **BIG BET / BIG WIN** action bars that broadcast notable trades; moderated
  (mods + operator can delete / mute / ban).
- **DROP** — a timed TCG-pack giveaway: tip USDC into the pot. (Teaser shipped; the draw/prize mechanic
  is in progress — see [Chat, social & DROP](#chat-social--drop).)
- Everything is **server-authoritative** and streamed live over WebSocket; the browser is a renderer.

---

## Where the data comes from

This is the part most people ask about, so it's spelled out explicitly.

### Card prices and the live indices — one feed

There is **one** price feed: **[pokemontcg.io](https://pokemontcg.io) v2 `/cards`** (which itself
surfaces **TCGplayer** market prices). The oracle makes a single request per cycle:

```
GET https://api.pokemontcg.io/v2/cards
      ?q=supertype:Pokémon
      &orderBy=-tcgplayer.prices.holofoil.market
      &pageSize=250
```

That one response is reused two ways (`apps/api/src/services/oracle.ts`):

1. **Individual card markets** — each returned card becomes a tradeable market, priced from
   `tcgplayer.prices` (`getCardPrice` picks the best available variant).
2. **The Top 100 / Top 250 indices** — the *same* cards are sorted by price and the top-N slice
   becomes the index basket. The index value is a **divisor-based basket NAV** (S&P-style):
   `value = Σ(prices) · SCALE / divisor`, with the divisor chosen so the index starts at a base
   of 1000 and re-anchored on a constituent change so the print stays continuous.

So the indices are **not a separate API** — they're computed in-house from the exact dataset
that powers the card markets. The price *origin* is TCGplayer; pokemontcg.io is the delivery API.

> Note: pokemontcg.io v2 caps `pageSize` at 250, so the tracked universe is the ~250 highest-priced
> Pokémon cards. Top 250 ≈ that whole set; Top 100 ≈ its top 100; the card markets are that same set.

### The four indices

| Index | Source | Status in this build |
|---|---|---|
| **Top 100** | In-house basket NAV from pokemontcg.io card prices | ✅ Live |
| **Top 250** | In-house basket NAV from pokemontcg.io card prices | ✅ Live |
| **Graded (PSA 10)** | [JustTCG](https://justtcg.com) PSA-10 prices → in-house basket | 🔒 Gated — becomes tradeable only when `JUSTTCG_API_KEY` is set |
| **Sealed** | needs a sealed-product price feed (e.g. TCGplayer Sealed / PriceCharting) | 🔒 Gated — no source wired; shows "Soon" |

Graded/Sealed are **listed but not tradeable** until a real feed exists. We deliberately do **not**
scrape TCGFish: their pages and embed badges are Cloudflare bot-challenged and the badges are
rendered images, not an API, so they can't be ingested server-side. Enabling those indices for
real is a data decision (a licensed graded/sealed feed, or a TCGFish data partnership), not a hack.

### The oracle pipeline

`oracle.ts` re-prices the tracked universe on a timer (`ORACLE_REFRESH_MS`, default 6h; the upstream
re-prices each card every few days). Each pass:

1. **Fetch** the per-card signals from the price feed (tcgpricelookup live; the pokemontcg path is the
   legacy fallback): the TCGplayer **market** price plus eBay **1-day / 7-day / 30-day** average sale
   prices, per condition (Near Mint preferred, Lightly Played fallback).
2. **Price** each card with `priceCard` — one definition of "the price"
   (`services/providers/tcgpricelookup.ts`):
   - **Anchor = `median(TCGplayer market, eBay 7d, eBay 30d)`** — an outlier-proof fair value; any one
     source printing garbage is outvoted by the other two.
   - **Confidence gate** (a stand-in for volume — the provider gives no sale counts): the anchor needs
     **≥2 signals that agree within 3×**. If not, the card is **low-confidence** → priced at the anchor
     and the market is **restricted to reduce-only** (no new positions against a price we can't trust).
   - **Live price = the eBay 1-day average (moves daily) clamped to anchor ±25%** — so it tracks real
     sales, but no single sale or listing can swing the market beyond the band. Rounds to the $0.01 tick.
3. **Outlier guard** — still reject a print that jumps > 60% from the last accepted value (with an
   escape hatch for a sustained genuine move).
4. **Record** the accepted print to `oracle_prices`, **recompute the synthetic mark**, and publish on
   the `mark:{id}` channel.
5. **Apply the gate** — set `markets.low_confidence`, and on a *transition* append a
   `market_restriction_events` row (powers the admin "restricted now" + "flipped today" views).
6. **Staleness halt** — a market with no fresh print within `ORACLE_STALE_MS` (36h) goes reduce-only.

Worked examples (anchor = median of the three; live = the 1-day avg clamped to ±25%):

| Signals — spot / 7d / 30d / 1d | Anchor | Price | Tradeable? |
|---|---|---|---|
| 9.80 / 10.10 / 9.96 / 10.80 | 9.96 | **10.80** (1d inside the band) | ✅ |
| 10 / 10 / 10 / 13 | 10 | **12.50** (1d clamped to +25%) | ✅ |
| 4699 / 7.75 / 9.96 / — | 9.96 | **9.96** | ❌ restricted — spot is garbage, outvoted |
| 1.05 / 6449 / 1.79 / — | 1.79 | **1.79** | ❌ restricted — eBay 7d is garbage, outvoted |
| 50 / — / — / — | 50 | **50** | ❌ restricted — one signal, can't cross-check |

A restricted market is **close-only** until its signals recover — or until an operator sets a manual
price, which is treated as trusted and clears the gate. Indices aggregate many cards, so they're robust
by construction and never gated.

### How a card's price is calculated (the customer explanation)

> Every market settles against a **fair value** we compute for each card from multiple real markets —
> never a single listing.
>
> **A cross-checked anchor.** We start from the median of three independent reads: TCGplayer's market
> price, eBay's 7-day average sale price, and eBay's 30-day average. Taking the *median* means if any one
> source prints a nonsense number, it's automatically outvoted and ignored.
>
> **It moves with the market.** The live price then tracks the most recent real sales — eBay's latest
> daily data — so your chart moves day to day instead of sitting still.
>
> **On a leash.** That daily price can't stray more than ~25% from the cross-checked anchor. Genuine
> moves come through; no freak sale or listing can yank your market.
>
> **Thin cards are limited.** Some cards trade too rarely to price safely. Where our sources disagree,
> we hold the card at its stable fair value and make it close-only (no new positions). Our **indices** —
> baskets of many cards — are the most robust markets and a great default.
>
> **What you actually trade.** Your mark price is this fair value plus a small premium reflecting live
> buying vs. selling pressure on the venue (standard for perpetuals). With no open positions, it's
> exactly the fair value.
>
> **Why it may differ from a price you see elsewhere.** We won't quote a lone $4,699 listing on a card
> that sells for $10 — our number is the corroborated, bounded consensus.

---

## How trading works

- **Synthetic mark.** The tradeable price is `mark = clamp(index · (1 + premium), ±maxDev)`, where
  the `premium` comes from the LP pool's long/short skew (scaled by a per-market `k`, capped). The
  oracle/index value is a hard anchor; skew adds bounded intraday motion. Same model for cards and
  indices. (`packages/pricing/src/index.js` → `syntheticMark`.)
- **Isolated margin, up to 20×.** Each position locks its own margin; leverage is capped per market.
- **Pooled-LP counterparty.** There is no order book. Trades fill against the LP pool at the mark;
  the pool books trader PnL (LPs win when traders lose, and vice-versa).
- **Fees.** Open/close fees (default 0.10% each) split between LPs and platform fee revenue.
- **Funding.** Hourly, skew-balancing: the heavier side pays the lighter side (cumulative-index lazy
  settle). Keeps the mark tethered to the index.
- **Liquidations.** A maintenance-margin sweep runs every few seconds and after every accepted print.
  Liquidations are loss-capped at the trader's margin; a 1% penalty tops up the **insurance fund**;
  any bad debt is drawn from insurance first, then socialized across LP NAV. Every leg is a ledger entry.
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
- **Chart of accounts.** `USER_COLLATERAL`, `USER_POSITION_MARGIN`, `LP_POOL`, `INSURANCE_FUND`,
  `FEE_REVENUE`, `FUNDING_POOL`, `PNL_CLEARING`, `FAUCET_SOURCE`, `TREASURY_USDC` (real-funds custody
  mirror), `DROP_POOL` (the DROP giveaway pot).

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
- **Faucet (play-money mode).** Credits play USDC from `FAUCET_SOURCE`, clamped so a user's available
  balance never exceeds $1,000,000. In real-funds mode the faucet is off — users fund via custody
  deposits instead (see [Custody & wallets](#custody--wallets-real-funds-mode)).
- **Leaderboard** (`GET /leaderboard`, public). Ranks traders by **net realized PnL**, derived from
  the ledger so it reconciles: `realized = (collateral + margin + LP-position value) − net deposits`.
  Equity and traded volume are shown as secondary columns; your own row is pinned when signed in.
- **Referrals.** Every account gets a unique `POKE-XXXXX` code at signup. Redeeming a code attributes
  the new account to the referrer (once) and, in play-money mode, pays **both** parties a bonus
  (default $1,000, clamped to the balance cap). The referrer is only paid for their first
  `MAX_REFERRALS_PAID` referrals (anti-farming). A `?ref=CODE` link is captured and offered for redeem.

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
- **Identity.** A leaderboard **rank badge** (👑#1 / 🥈 / 🥉 / TOP 10 / TOP 100) sits next to each handle,
  from a ~60s-cached rank map; cumulative-volume **levels** back it (L1–L6).
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

### Admin **CHAT** view (3rd operator tab)

A dedicated operator tab alongside Main + Customers, all under the admin key:

- **Thresholds** — the BIG BET / BIG WIN knobs (live `settings`).
- **DROP config + pot** — interval / house-floor / pack-tier / GDEX-min knobs, the read-only eligibility
  mint, the live `DROP_POOL` pot balance, total tipped, and recent tips.
- **Moderation** — grant/revoke MOD (by wallet **or** user id), the muted/banned lists with unmute/unban,
  and the mod-action audit log.

---

## Architecture

```
        pokemontcg.io v2  (TCGplayer prices; ~daily)        [+ optional JustTCG for Graded]
                          │
              ┌───────────▼─────────────┐
              │  oracle (timer, 6h)      │  normalize → e6, outlier + staleness guard,
              │  src/services/oracle.ts  │  build Top-100/250 basket NAVs, recompute marks
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
  apps/web                  React 19 + Vite SPA — Vercel (retro "Press Start 2P" theme)
  apps/api                  Fastify + WebSocket backend: ledger, engine, oracle, liquidations, custody
  packages/pricing          Shared money math (price/PnL/margin/liq/mark) — FE previews must equal the engine
  packages/shared-types     Shared zod schemas + constants for the REST + WebSocket contracts
```

`packages/pricing` is the single source of truth for money math, imported by **both** the API and
the web app, so the liquidation price / fees the user previews are exactly what the engine computes.

### Data model (Postgres / PGlite)

`users · sessions · auth_nonces` · `accounts · ledger_entries · balances` (double-entry core) ·
`markets · oracle_prices · marks · index_constituents · index_divisors` (pricing) ·
`orders · fills · positions · funding_rates · liquidations` (trading) ·
`lp_pool · lp_positions` (liquidity) · `deposit_addresses · withdrawals · system_flags · settings ·
worker_leases` (real-funds custody + operator config) · `chat_messages · chat_reactions ·
chat_mod_actions · drop_tips` + mod flags on `users` (chat & social). The same `schema.sql` runs on
PGlite locally and on managed Postgres in prod; it's idempotent and applied on boot (`db/migrate.ts`).

---

## API surface

**REST** (`apps/api/src/routes`):

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /auth/nonce` · `POST /auth/verify` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` | mixed | SIWS login + session rotation |
| `GET /markets` · `GET /markets/:id/candles` · `GET /markets/:id/details` | public | Market list, chart series, card metadata + graded price |
| `GET /account/balance` · `POST /faucet` | yes | Balance/equity; claim play USDC |
| `GET /positions` · `POST /orders` · `POST /positions/:id/close` | yes | Open positions; place/close perps |
| `GET /lp/pool` · `GET /lp/position` · `POST /lp/deposit` · `POST /lp/withdraw` | mixed | LP pool state + provide/withdraw liquidity |
| `GET /leaderboard` · `GET /referral/me` · `POST /referral/redeem` | mixed | Leaderboard (public, optional viewer); referral code + redeem |
| `GET /wallet/deposit-address` · `POST /wallet/withdraw/nonce` · `POST /wallet/withdraw` · `GET /wallet/transactions` | yes | Real-funds custody: deposit address, withdraw (wallet step-up), wallet history |
| `/admin/markets/:id/price` · `/admin/treasury` · `/admin/insurance/*` · `/admin/custody-limits` · `/admin/withdrawals/*` · `/admin/freeze` · `/admin/customers` · `/admin/chat/*` | admin key | Operator ops (manual pricing always; custody ops under real funds) + Customers & CHAT view — see [docs/ops-runbook.md](docs/ops-runbook.md) |
| `GET /chat` · `POST /chat` · `/chat/messages/:id/react` · `/chat/ranks` · `/chat/profile/:id` · `GET /chat/drop/pot` · `POST /chat/drop/tip` · mod routes | mixed | Live chat: read/post, reactions, rank map, profile card, DROP pot tips (real USDC), mod actions |
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
| `POKEMONTCG_API_KEY` | _(empty)_ | Optional; keyless works at lower rate limits |
| `ORACLE_REFRESH_MS` / `ORACLE_PAGE_SIZE` | `6h` / `250` | Ingest cadence; page size (capped at 250 upstream) |
| `JUSTTCG_API_KEY` / `GRADED_CONSTITUENTS` | _(empty)_ / `100` | Set the key to make the **Graded** index live |
| `REAL_FUNDS` | `false` | `false` = play-money (faucet). `true` = real custody (deposits/withdrawals); requires the custody vars below |
| `ALLOW_MAINNET_FUNDS` | `false` | Must be `true` to run real funds on **mainnet** (the audit/KYC/geofence acknowledgement) |
| `SOLANA_RPC_URL` | devnet | Backend Solana RPC — point at a **mainnet** provider for real funds |
| `USDC_MINT` · `TREASURY_PUBKEY` | _(empty)_ | USDC SPL mint (mainnet `EPjF…Dt1v`) · cold treasury (Squads multisig) address |
| `DEPOSIT_MASTER_SEED` · `HOT_WALLET_SECRET` | _(empty)_ | Custody keys (real-funds) — set in the host's secret store, never committed |
| `ADMIN_API_KEY` | _(empty)_ | ≥32 chars; enables the `/admin` operator routes |
| `HOT_WALLET_MAX_USD` · `WITHDRAWAL_DAILY_CAP_USD` · … | see config.ts | Custody limits — defaults here, **live-editable in the admin panel** |
| `OI_CAP_NAV_BPS` · `MAX_PNL_FACTOR_BPS` · `ADL_PNL_FACTOR_BPS` | `0` (off) | Pool-risk caps (NAV-relative OI · open-gate · ADL); turn on for real funds |
| `FAUCET_DEFAULT_USD` | `10000` | Per-claim play USDC (balance capped at $1M) |
| `REFERRAL_BONUS_USD` / `MAX_REFERRALS_PAID` | `1000` / `50` | Referral payout (both parties) + per-referrer cap |
| `OPEN_FEE_BPS` / `CLOSE_FEE_BPS` / `FEE_LP_SHARE_PCT` | `10` / `10` / `50` | Trading fees + LP share |
| `FUNDING_SKEW_FACTOR_BPS` / `FUNDING_INTERVAL_MS` | `30` / `1h` | Funding rate cap + cadence |
| `LIQ_FEE_BPS` / `LIQUIDATION_SWEEP_MS` / `ORACLE_STALE_MS` | `100` / `5s` / `36h` | Liquidation penalty, sweep, staleness halt |
| `CHAT_BIG_BET_USD` / `CHAT_BIG_WIN_USD` | `500` / `100` | Chat action-bar thresholds (USD; live-editable in the admin CHAT view) |
| `DROP_TIPS_ENABLED` | `false` | Opens **real-USDC** player tipping into the DROP pot — keep off until the draw/payout ships |
| `DROP_TIP_MIN_USD` / `DROP_TIP_MAX_USD` | `1` / `10000` | Per-tip bounds (USD) |
| `DROP_INTERVAL_MIN` / `DROP_HOUSE_FLOOR_USD` / `DROP_GDEX_MIN` | `60` / `250` / `500000` | DROP round knobs (Phase 2 mechanic) |

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
  conservation, SIWS auth, oracle ingest + outlier guard + index NAV, the trading engine
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
marketing landing page is the public entry point. A **chat & social layer** ships alongside — live chat
with reactions, leaderboard rank badges, presence, and moderation, plus the **DROP** giveaway-pot teaser
with real-USDC player tipping (flag-gated, **off by default**).

**Operator responsibility before real money on mainnet:** the security audit, KYC/AML, and geofencing
are yours to put in place — the code only gates on `ALLOW_MAINNET_FUNDS=true`, it does not verify them.

Still deferred: the full **DROP** round mechanic (the scheduled draw, the rare.win pack-open, and the
on-chain NFT prize — needs rare.win API access), a real **Graded / Sealed** price feed (needs a licensed
source), **multi-game** markets (One Piece / MTG), **limit / stop** orders, a Go engine rewrite, and the
**KMS-held deposit seed** (`DEPOSIT_SEED_KMS_REF` is recognized but not yet implemented — use
`DEPOSIT_MASTER_SEED` for now).
