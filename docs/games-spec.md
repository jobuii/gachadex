# GachaDex Games — design spec

> **Status:** exploratory / concept. No code committed yet. This doc captures the chosen
> direction, the verified market research behind it, how it maps onto the existing GachaDex
> codebase, and a ranked set of concrete game concepts. Part 1 (the first 5 concepts) is
> complete; Part 2 (10 additional concepts) is appended after a second, deeper research pass.

A **Games** surface for GachaDex: provably-fair, real-money USDC games where the prize is a
**tokenized trading card** the player can instantly **sell back for USDC** (or keep / trade).
It rides the same wallet, ledger, oracle, and chat infrastructure the exchange already runs, and
acts as a top-of-funnel that graduates players into the core **perps** product.

---

## 1. Direction & decisions

Locked with the product owner (2026-06-22):

| Decision | Choice | Implication |
|---|---|---|
| **Perps tie-in depth** | **Light touch** | The game is a standalone provably-fair casino; perps are an optional side path. Shared wallet/USDC balance + DROP pot, plus a "graduate to perps" CTA. Perps are **not** the core mechanic. |
| **Prize payout** | **NFT card → sell for USDC** | The rare.win model: win a tokenized card, one-tap sell back for USDC at oracle value, or keep / trade. No shipping logistics in the default path. |
| **Economic / regulatory model** | **Provably-fair casino** | Real-money USDC wager, defined house edge, on-chain-verifiable fairness (server-seed / client-seed / nonce, or Solana VRF). |

---

## 2. Research grounding (verified, cited)

The direction is **not speculative** — it is a live, nine-figure model on Solana. Two platforms
validate the full loop end to end; one validates the underlying custody primitive; and provable
fairness is a solved, documented pattern. (All claims below survived 3-vote adversarial
verification; see the deep-research run for the full claim set.)

### Direct precedents

- **Collector Crypt** — *the blueprint.* Solana; **$150M+ volume, $1B+ all-time, 130K+ cards
  vaulted.** A fixed-price **"Gacha" pack-opening** is its dominant product: buy a fixed-price
  digital pack → reveal a random **pNFT linked to a real PSA/BGS/CGC-graded vaulted card** →
  **keep / redeem (burn-to-ship, ~2% of insured value + shipping) / instant sell-back.** The
  sell-back is a **standing on-chain buyback at 85–90% of a real-time indexed value** (eBay/ALT
  oracle), with the physical card staying vaulted for later resale. **That 10–15% spread *is* the
  house edge.** Tiers cited: Elite $50–60 (~20% big-win odds, 85% buyback); Legendary $250 (~25%,
  90% buyback). Sources: The Block, CoinGecko, CoinMarketCap, Bitget. *(One circulating figure —
  "$89M Gacha revenue in 2025" — was refuted and is not used.)*
- **Gym Showdown** (the reference link) — Solana; **$10/side 1v1 50/50 VRF coin-flip → weighted
  vault draw → graded Pokémon-card NFT airdropped instantly → 12-hour buyback at 80% of insured
  value** (~20% take). Insured-value tiers: Mythic $2k+, Legendary $1–2k, Rare $300–1k, Common
  <$300. Both the flip and the card draw use **Solana VRF**. *Caveat: evidence is the project's
  own site — no third-party audit or published program ID; treat as self-reported.*
- **Courtyard.io** — validates the RWA custody primitive: **1:1 physical-backed NFTs** in a
  Brink's vault, **free vaulted/insured custody, 24/7 redemption**, "digital packs, physical
  cards." Lets tokenized cards trade instantly without moving the physical. *Caveat: it's on
  **Polygon, not Solana** — a custody precedent, not a Solana implementation reference.*

### Provable fairness (solved pattern)

Two valid designs, both verified:

1. **Off-chain commit-reveal** (Boxed.GG / Stake-style, industry standard): a **hashed server
   seed** is committed/shown *before* the play and the real seed revealed on a 24h rotation; a
   **user-controllable client seed** the operator never touches; a **per-account nonce** that
   increments each play so a seed pair never repeats; combine (HMAC-SHA256) → hex → number
   **0–999,999** = the result ticket that selects the outcome. Sources: Boxed.GG helpdesk,
   Chainlink.
2. **On-chain Solana VRF** (Gym Showdown-style) — verifiable randomness settled on-chain.

GachaDex (Solana-native) can use either or both. Off-chain commit-reveal is cheaper/faster and
needs **no new dependencies** (Node `crypto` already provides `createHmac`/`createHash`/
`randomBytes`/`timingSafeEqual`); VRF gives a stronger trust story for marquee/high-stakes draws.

---

## 3. The GachaDex unlock (what the precedents don't have)

**Collector Crypt has to buy an external eBay/ALT oracle to price its buybacks. GachaDex already
computes a canonical USDC price for ~700+ cards — it *is* the perp mark** (Scrydex oracle + the
~26k-card `price_index` lake). Therefore:

> **The GachaDex oracle is the internal buyback oracle.** "Standing buyback at X% of indexed
> value" — the exact mechanic that built Collector Crypt — runs natively here, no external feed,
> with the spread as a tunable house-edge `liveKnob`.

Two more native advantages:

- **Won card → live perp market.** Win a Charizard → GachaDex already lists a Charizard *perp*.
  "You won it — now trade it" is the lightest, most natural graduate-to-perps CTA possible.
- **Prize-settlement abstraction (the key build decision).** `rare.win` is **unbuilt and blocked
  on their API** (see `outstanding-work` memory / DROP Phase 2). So abstract the prize layer:
  - **Ships now (no external dependency):** a won card resolves to **USDC at the GachaDex oracle
    value**, plus an optional cosmetic card-NFT receipt.
  - **Later:** a **real rare.win / vaulted NFT** when that integration lands.

  The game mechanic is **byte-identical** either way; only the payout backend swaps. This lets
  every concept below ship on infrastructure that already exists.

---

## 4. Codebase integration map

What the games reuse vs. what is genuinely new (verified by a read-through of the API):

**Reuse (already built):**
- **Ledger money-movement** — `postTxn(q, { reason, refType, refId, entries: [{accountId, amount}] })`
  with balanced double-entry (`services/ledger.ts`). A wager is `USER_COLLATERAL → GAME_POOL`; a
  payout is the reverse. The `DROP_POOL` tip flow (`services/drop.ts:50`) is a working template,
  including the **`SELECT … FOR UPDATE` row-lock balance check** before debit.
- **liveKnob** (`services/live-knob.ts`) — drop-in for house-edge bps / prize tiers / RTP, surfaced
  in the admin panel exactly like `drop-config.ts`.
- **WebSocket broadcast** — `publish('chat', type, data)` (`services/bus.ts` → `plugins/ws.ts`)
  already streams the DROP bar and BIG WIN action bars; a live game feed reuses it.
- **Crypto primitives** — `randomBytes`, `createHash('sha256')`, `createHmac`, `timingSafeEqual`
  already imported (auth + Scrydex webhook). Enough to build commit-reveal with no new deps.
- **Oracle price** — the per-card mark already exists for every featured market (the buyback value).

**Build fresh:**
- **Provable-fairness module** — server-seed commit/reveal + client seed + per-account nonce →
  result ticket. No such code today (`drop_rounds.rng_seed` column exists but is never populated).
- **`GAME_POOL` ledger account** + per-game round/result tables (audit + replay).
- **Prize settlement** — oracle-synthetic now; **rare.win client later** (zero code today; only a
  deferred reference in `docs/chat-social-spec.md`).

**Build-cost consequence:** math-settled games (crash/plinko/mines) that pay USDC and award a card
only at a top prize tier ship on the **existing ledger alone**. A full gacha that mints a real card
on every play needs the prize backend (oracle-synthetic, or rare.win/vault) wired first.

---

## 5. The 5 concepts (Part 1)

### 🥇 1. "Pack Rip" — case-opening / gacha
**Hook:** Rip a digital booster; the weighted reveal is a real card you can cash out or keep.
- **Loop:** Pick a pack tier (e.g. $5 / $25 / $100) → animated rip → provably-fair weighted reveal
  of one card from that tier's table → **Sell back** (instant USDC at oracle value) / **Keep**
  (NFT) / **Trade it** (→ perp market).
- **Fairness + edge:** Commit-reveal (server-seed-hash + client seed + nonce → 0–999,999 ticket maps
  to the weighted table). **House edge = the buyback spread**, a `liveKnob` anchored to the verified
  precedent (**10–15%**, Collector Crypt; up to ~20%, Gym Showdown). Fully internal.
- **Card→USDC:** Sell-back at `oracle_value × (1 − edge)`; liquidity from a `GAME_POOL`/treasury
  account (identical plumbing to `DROP_POOL`). Real vaulted card later via rare.win.
- **Perps tie-in:** "Trade this card" CTA on every reveal; a slice of edge feeds `DROP_POOL`.
- **Sticky:** The single most proven card-prize mechanic on Solana ($1B+). Variable-ratio reward + near-miss.
- **Build/risk:** Medium. Needs the fairness module + prize tables + a card-value snapshot at open
  (oracle already provides it). **Most authentic** "win a real card." Highest regulatory exposure.

### 🥈 2. "Pump or Dump" — crash, card-themed *(best perps bridge)*
**Hook:** A card's hype-line pumps live; cash out before it dumps — the whole GachaDex thesis as a 20-second game.
- **Loop:** Ante USDC on a featured card → a multiplier curve climbs (the card "pumping") → cash out
  anytime → it **rugs at a provably-fair random point**. Cash out past a threshold multiplier → win
  the **card NFT** (not just USDC).
- **Fairness + edge:** Provably-fair crash point from the seed triple; the instant-rug probability
  sets the edge — operator-set via `liveKnob`.
- **Card→USDC:** Same buyback path; the card is the high-multiplier jackpot tier.
- **Perps tie-in:** **Strongest of all five** — it literally teaches leverage/liquidation intuition
  (cash-out = take profit, rug = liquidation). "Liked that? The real Charizard does this with 20×."
- **Sticky:** Crash is the most retention-heavy crypto-casino format (social cash-out race, near-miss).
- **Build/risk:** Medium. Pure-ledger USDC settlement (card only at the top tier) = cheaper than Pack Rip.

### 🥉 3. "Pack Wars" — PvP case battles *(best virality)*
**Hook:** 2–4 players rip simultaneously; highest total card value sweeps the table.
- **Loop:** Players ante into a battle → all open the same pack tier at once (synchronized
  provably-fair reveals) → **highest combined oracle value wins everyone's cards/USDC.**
- **Fairness + edge:** Same commit-reveal, one nonce sequence per battle; rake (`liveKnob`) on the pot = edge.
- **Card→USDC:** Winner sweeps the NFTs; sell-back or keep.
- **Perps tie-in:** Reuses the **existing chat/presence/social layer** — battles broadcast like BIG WIN bars already do.
- **Sticky:** flip.gg/CSGO's documented growth engine — PvP + spectate + social. Chat infra is already built.
- **Build/risk:** Medium-high (matchmaking/lobby + synchronized settlement). Highest engagement-per-build.

### 4. "Plinko Binder" — plinko *(best frequency / mobile)*
**Hook:** Drop a card down the pegs; the bucket it lands in is your payout — edges are chase cards.
- **Loop:** Stake → card chip falls through provably-fair pegs → lands in a multiplier bucket
  (center = sub-1× loss, far edges = card-NFT jackpot). Risk tiers (rows/volatility) selectable.
- **Fairness + edge:** Seed triple picks the path; edge baked into the bucket multiplier table (`liveKnob`).
- **Card→USDC:** Edge buckets award a card NFT; center buckets pay USDC.
- **Perps tie-in:** Lowest-friction on-ramp; "graduate to perps" after N drops. Feeds `DROP_POOL`.
- **Sticky:** Lowest stakes → highest play *frequency*; dopamine-dense, best mobile fit (existing `mobile.css` row-cards).
- **Build/risk:** **Lowest** — pure-ledger, deterministic-from-seed. Good first build to prove the fairness module.

### 5. "Booster Mines" — mines *(best skill-feel / agency)*
**Hook:** Reveal cards across a grid; dodge the "bulk pull" duds; bank a rising multiplier or risk it for the chase card.
- **Loop:** Set bomb count (variance dial) → flip tiles revealing cards; each safe flip raises the
  multiplier; hit a "dud" → bust. Cash out for USDC, or push the streak to the **card-NFT tier**.
- **Fairness + edge:** Seed triple places the bombs; edge from the multiplier schedule (`liveKnob`).
- **Card→USDC / perps / sticky:** As above; player-chosen variance = high agency, long sessions.
- **Build/risk:** Low-medium, pure-ledger.

*Honorable mentions (not prioritized):* **"Card Clash"** (a near-1:1 Gym Showdown coin-flip clone —
proven but unoriginal); **"Binder Jackpot"** (basically the existing DROP lottery).

---

## 6. Ranked summary (Part 1)

| # | Game | Mechanic | Card theming | Stickiness | Perps bridge | Build cost | Ships w/o rare.win? |
|---|------|----------|--------------|------------|--------------|-----------|---------------------|
| 🥇 | **Pack Rip** | Gacha/case-open | ★★★★★ | ★★★★★ | ★★★ | Med | ✅ (oracle-settled) |
| 🥈 | **Pump or Dump** | Crash | ★★★ | ★★★★★ | ★★★★★ | Med | ✅ |
| 🥉 | **Pack Wars** | PvP battles | ★★★★ | ★★★★★ | ★★★ | Med-High | ✅ |
| 4 | **Plinko Binder** | Plinko | ★★★ | ★★★★ | ★★ | **Low** | ✅ |
| 5 | **Booster Mines** | Mines | ★★ | ★★★★ | ★★ | Low-Med | ✅ |

**Recommendation:** Ship **Plinko Binder or Booster Mines first** as the cheap vehicle to build and
battle-test the shared **provable-fairness module + `GAME_POOL` ledger account** (the only genuinely
new pieces). Then land **Pack Rip** as the flagship (the proven $1B model, most authentic). Hold
**Pump or Dump** as the marquee perps-funnel feature once the engine is proven. Pack Wars last (needs
matchmaking, but pays off the existing social layer).

---

## 7. Cross-cutting risks

1. **⚠️ Regulatory.** A real-money USDC casino-prize game is **clearly gambling-regulatory
   exposed.** Collector Crypt's Gacha is **restricted in US/UK/China**; the "positive-EV / not
   gambling" framing is *contested marketing, not legal cover*. This rides on the same operator
   obligations the README already gates behind `ALLOW_MAINNET_FUNDS` (audit / KYC / geofence) — but a
   wagering game raises the bar. **This is the real gate, not the code.**
2. **The authentic prize is the one true external dependency.** Everything ships today on
   oracle-settled USDC + cosmetic NFT receipts. A genuinely *vaulted physical card* needs rare.win
   (blocked) or a Collector-Crypt-style vault partnership — a business deal, not a sprint.

---

## 8. Provable-fairness module (design sketch)

A single shared module powers every game (off-chain commit-reveal; VRF optional for marquee draws):

- **Server seed:** random 32 bytes per (user, rotation). Store `sha256(serverSeed)` and expose the
  **hash** before any play; reveal the raw seed on rotation so past plays are verifiable.
- **Client seed:** user-supplied string, changeable anytime via a "provably fair" control; the server
  never modifies it.
- **Nonce:** per-(user, serverSeed) counter, increments on every play.
- **Result:** `HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`)` → take hex → map to `0…999,999` (or
  a float in `[0,1)`), then into the game's outcome space (weighted table / crash point / peg path /
  bomb layout). Persist `{serverSeedHash, clientSeed, nonce, ticket, outcome}` per round for replay.
- **Verification page:** given the revealed server seed + client seed + nonce, anyone recomputes the
  ticket and confirms the outcome.

`GAME_POOL` is a new system ledger account (mirror of `DROP_POOL`): wagers credit it, payouts debit
it, the retained edge accrues there, and a slice can sweep to `DROP_POOL` or `FEE_REVENUE`.

---

## 9. Open questions / next steps

- **Sell-back liquidity source:** treasury vs. a dedicated game LP vs. the DROP pot vs. rare.win.
  (Precedents: Collector Crypt = standing treasury/oracle buyback at 85–90%; Gym Showdown = 80%
  vault buyback.)
- **VRF vs. off-chain commit-reveal** as the default (cost / latency / UX on Solana).
- **rare.win API surface** — does it expose pack-open / tokenize / buyback, and is its model
  identical to Collector Crypt's? No primary rare.win source surfaced in research.
- **Regulatory posture** — geofence + KYC + the skill-vs-chance line for any PvP/"proper game."

---

## Part 2 — 10 additional concepts

A second, deeper research pass grounded two new sets: **Set A** = 5 casino-style games re-themed
for TCG cards (beyond Part 1's gacha/crash/plinko/mines/battles); **Set B** = 5 *playable* "proper
games" (richer than Gym Showdown's coin-flip). Verified findings behind them:

- **TCG-native gambling = group breaks / "razz."** The dominant real-money TCG format (Whatnot,
  eBay Live, Fanatics Live): players buy "spots" in a sealed box/case; cards are distributed by
  format — **PYT** (pick-your-team/slot), **Random Team**, **Snake Draft**, **Divisional**, "rip
  and ship," spot raffles. Breakers randomize with **random.org**. **Critically: Whatnot now
  *bans* gambling / purchase-based-prize / "guess games," and there is active 2025–26 litigation
  against Whatnot *and* Fanatics Live alleging box-breaking is an illegal lottery** (the "three
  element" test: consideration + chance + prize). [Whatnot policy; ESPN/Trachok]. → **A
  provably-fair, VRF-randomized on-chain break is a wide-open lane the incumbents are vacating.**
- **Casino-canon math (Wizard of Odds, verbatim):** Blackjack **0.28%** edge (lowest card game,
  liberal rules); Baccarat **Banker 1.06% / Tie 14.36%**; full-pay **9/6 Jacks-or-Better video
  poker 0.46%** edge (**99.54%** return), and the pay-table is a clean **EV dial — 9/6 = 99.54%
  down to 6/5 = 94.99%**. Genshin-style **pity** (90-pull hard pity + 50/50) is the canonical
  retention lever. *(Refuted and NOT used: any specific PSA grade-distribution odds — no reliable
  public figure survived, so grade-betting odds must be house-set + provably-fair, not "real."*)
- **Playable-game precedents:** **MarketDraft** — a live fantasy-stock/crypto game with a
  **"Swing Trader" salary-cap draft** and a **"Streak" price-prediction** contest (skill-framed).
  **Sorare** — fantasy with **tradeable tokenized cards + cash prizes**. **Axie Infinity = the
  death-spiral lesson:** a Ponzi-like structure on an **uncapped, inflationary** reward token (SLP)
  that collapsed when new-player inflow slowed. [MarketDraft; Sorare/bitnovo; Deconstructor of Fun].
- **Skill-vs-chance legal line:** US courts apply the **Dominant Factor**, **Material Element**,
  and **Any Chance** tests; skill-predominant games (DFS-style) have a materially better posture
  than pure-chance gambling. [firstamendment.com]. PvP fairness uses **commit-reveal** for
  simultaneous hidden moves + VRF for any randomness. [Chainlink].

**Cross-cutting design rule (the Axie lesson):** every prize below is funded by a **finite real-USDC
pot / buyback spread**, never by minting an inflationary reward token. GachaDex's real-USDC ledger is
*structurally immune* to the Axie failure mode — a genuine selling point. **Set B's skill framing
also gives it a better regulatory footing than Set A's casino games.**

---

### Set A — 5 TCG-themed casino games

#### 🥇 A1. "The Break" — provably-fair digital group break *(top pick, Set A)*
**Hook:** The razz/PYT livestream break — the most addictive format in cards — rebuilt
provably-fair on-chain, exactly as Whatnot is banning it.
- **Loop:** The house lists a sealed **digital case** = a curated bundle of oracle-priced cards split
  into **N spots**. Players buy spots (Random-spot razz, or PYT pick-a-slot). When the case fills, a
  **VRF / commit-reveal draw** assigns each card to a spot → each player keeps their spot's cards
  (sell back for USDC at oracle value / keep / trade).
- **Fairness + edge:** VRF or seed-triple assigns spots; **house edge is structural** — total spot
  price > Σ(card oracle values × buyback %). Tunable via `liveKnob`.
- **Card→USDC:** Won cards settle at oracle value (synthetic now, rare.win/vault later).
- **Perps tie-in:** "You pulled a Charizard — trade it." A slice of rake → `DROP_POOL`.
- **Sticky:** The genre's proven live-social loop; **reuses the existing chat/presence layer** for the
  live "break room." Communal anticipation + per-spot reveals.
- **Build/risk:** Medium-high (lobby/fill + synchronized multi-party settlement). **Regulatory: HIGH**
  — this is *literally the format under active litigation*; provable fairness + sweepstakes/skill
  structuring + geofencing are mandatory, not optional. But also the **biggest differentiated wedge.**

#### 🥈 A2. "Higher or Lower" — card-price hi-lo ladder
**Hook:** Next card worth more or less? Call it right and climb the ladder; cash out or push for the chase card.
- **Loop:** A card is shown with its oracle price → bet the **next** card's price is higher/lower →
  correct calls chain up a **multiplier ladder** (double-or-nothing) → cash out anytime, or ride to
  the **card-NFT jackpot** rung.
- **Fairness + edge:** Seed-triple picks the next card from the universe; edge sits in the ladder
  multipliers + tie handling (`liveKnob`). (Hi-Lo / "ladder" is a verified-sticky cashout format.)
- **Card→USDC / perps tie-in:** Top rungs award a card NFT; **strongest perps bridge in Set A** — it
  *is* directional price intuition ("you're basically calling a 1-card long").
- **Sticky:** Push-your-luck ladder + near-miss; fast, repeatable, great mobile.
- **Build/risk:** **Low** (pure-ledger, deterministic-from-seed). Regulatory: medium (chance-based wager).

#### 🥉 A3. "Set Poker" — video-poker re-theme *(cleanest house-edge dial)*
**Hook:** Deal 5, hold the keepers, redraw — build a "set" and get paid by the rarity of the combo.
- **Loop:** Deal 5 cards from a themed pool → player **holds/discards** → redraw → payout by the
  combo formed (pairs/sets/full binder = poker-hand analogues).
- **Fairness + edge:** Seed-triple deals; **the pay table is the exact EV dial** — set it at **99.54%
  return (0.46% edge)** like full-pay 9/6, or tighten toward 94.99% for more hold. [Wizard of Odds].
- **Card→USDC / perps:** A "natural" top combo awards a card NFT; "trade these cards" CTA.
- **Sticky:** Skill-flavored (hold decisions) → longer sessions; the most legitimately *card-native*
  casino game. Regulatory: medium (has a skill element, which slightly helps).
- **Build/risk:** Medium (hand-evaluation + pay-table). Pure-ledger.

#### A4. "Binder Bingo" — pooled keno/bingo jackpot *(DROP-pot native)*
**Hook:** Fill a binder page before the room does — a communal lottery that pays the pooled pot.
- **Loop:** Players buy a **card "page"** (a keno/bingo grid of cards) → the house reveals a
  provably-fair sequence of cards → first to complete a line/page wins the **pooled pot** (+ a card).
- **Fairness + edge:** Seed-triple draws the sequence; **rake on the pool = edge** (low per-player, à
  la lottery). **Plugs straight into `DROP_POOL`** — the pot infra already exists.
- **Card→USDC / perps:** Pot pays USDC; jackpot tier adds a chase-card NFT.
- **Sticky:** Communal, social, low-stakes/high-frequency; the shared-jackpot dynamic is a retention
  engine and a natural marketing event ("$X binder pot drops at 8pm").
- **Build/risk:** Medium (pooled rounds + a leader worker, like the deferred DROP round worker).
  Regulatory: **lower** (lottery/sweepstakes structuring is well-trodden; can run "no-purchase" entries).

#### A5. "Grade Gamble" — provably-fair grade-reveal multiplier
**Hook:** You pulled the card — now gamble its **grade**. Raw → PSA 9 → PSA 10, each worth wildly more.
- **Loop:** After any pull/win, opt into a **grade reveal**: a provably-fair draw assigns a grade tier
  that multiplies the card's value (uses GachaDex's **graded-price** data, already in market details).
  Optional **double-or-nothing**: risk the current grade for a shot at the next tier.
- **Fairness + edge:** **House-set, provably-fair weighted grade table** (NOT real PSA odds — research
  refuted any public distribution, so the odds are transparent house parameters), edge in the table.
- **Card→USDC / perps:** Final graded value settles to USDC at the graded oracle price.
- **Sticky:** Intensely TCG-native (grading is the hobby's core dopamine); stacks on top of any other
  game as an *upsell* rather than a standalone.
- **Build/risk:** Low-medium **as a provably-fair multiplier**; **HIGH + deferred** if it ever means a
  *real* PSA submission (needs a grading pipeline — out of scope). Regulatory: medium.

**Set A ranking:** A1 The Break ≫ A2 Higher or Lower > A3 Set Poker > A4 Binder Bingo > A5 Grade Gamble.
**Top pick: The Break** — the one mechanic that's *uniquely TCG*, proven-addictive, social (reuses
chat), and strategically timed against incumbents being sued out of the format. Ship **A2/A3 first**
as cheap pure-ledger builds; **The Break** as the flagship once the pot/round-worker exists.

---

### Set B — 5 playable "proper games"

*(Skill-predominant where possible — better legal footing than Set A — and all funded by a finite
USDC pot, never an inflationary token.)*

#### 🥇 B1. "Card Fantasy League" — salary-cap draft on card prices *(top pick, Set B)*
**Hook:** Draft a roster of cards under a cap; the week's biggest price-movers win the pot. Fantasy
sports, but the players are Charizards.
- **Loop:** Each round (daily/weekly), players **draft a roster** of cards/indices under a salary cap
  → over the window, **roster %-price-change** (from the oracle) is the score → top finishers win
  **real cards + USDC** from a prize pool. Recurring leagues + leaderboards.
- **Skill / fairness:** **Skill-predominant** (you pick the cards — DFS-style, the strongest legal
  posture); the oracle settles objectively, no house RNG needed. [MarketDraft, Sorare].
- **Card→USDC / perps:** Prize pool funded by entry rake; **the most natural perps funnel of all** —
  it *teaches picking winning cards*, then "graduate: trade your picks with leverage."
- **Sticky:** Sorare/DFS-proven recurring-contest retention; **reuses the oracle as the scoreboard**
  (near-zero new pricing infra) and the chat layer for trash talk.
- **Build/risk:** Medium (rosters, cap logic, scoring worker). Regulatory: **lowest** (skill-game/DFS
  framing). **The best fit for a price exchange — recommended Set B build-first.**

#### 🥈 B2. "Price Duel" — 1v1 PvP prediction *(Gym Showdown, evolved to skill)*
**Hook:** You pick a card, I pick a card, we wager — whoever's pumps more in 24h takes the pot and the card.
- **Loop:** Two players each **secretly pick a card** (commit-reveal) + ante USDC → over a fixed
  window the higher **oracle %-move** wins the pot + a card NFT.
- **Skill / fairness:** Commit-reveal hides picks until lock (anti-copy); oracle settles. **Skill** (you
  choose) → better posture than Gym Showdown's coin-flip.
- **Card→USDC / perps:** Winner's pot + card; **it's a gamified mini-long** — the cleanest "this is
  what a perp feels like" bridge.
- **Sticky:** Head-to-head + social challenge; broadcastable like the existing BIG WIN bars.
- **Build/risk:** Low-medium (matchmaking + commit-reveal + windowed settle). Regulatory: medium-low (skill).

#### 🥉 B3. "Streak" — price-prediction ladder
**Hook:** Call the next print up or down; every right call extends your streak toward a bigger card.
- **Loop:** Predict up/down (or over/under a line) on a sequence of card prints → each correct call
  extends a **streak** → longer streak = bigger card/USDC reward → one miss resets. [MarketDraft Streak].
- **Skill / fairness:** Skill-framed directional calls; oracle settles. (PrizePicks/DFS-style.)
- **Card→USDC / perps:** Streak tiers pay USDC; top streak awards a chase card. Directional intuition → perps.
- **Sticky:** Daily-habit/"don't break the streak" loop; solo, fast, push-your-luck.
- **Build/risk:** **Low** (solo, oracle-settled). Regulatory: medium-low (skill).

#### B4. "Draft Arena" — PvP snake-draft tournament
**Hook:** Snake-draft cards from a shared pool, then your binder battles the room — bracket to a card jackpot.
- **Loop:** 4–8 players **snake-draft** cards from a shared pool → rosters compete on combined oracle
  move over a window → **bracket/tournament** → winner takes the card prize pool. (Booster-draft feel.)
- **Skill / fairness:** Drafting is skill; commit-reveal/turn-order for the draft; oracle scores.
- **Card→USDC / perps:** Tournament prize pool of cards/USDC; "trade the cards you drafted."
- **Sticky:** The richest social/competitive loop in Set B; tournaments + leaderboards; reuses chat.
- **Build/risk:** Medium-high (draft lobby, brackets). Regulatory: low (skill/tournament).

#### B5. "Card Battler" — turn-based PvP battler *(highest ceiling, highest cost)*
**Hook:** Your collection fights — a Gods-Unchained-style battler where card stats come from rarity/price, played for real-card stakes.
- **Loop:** Cards get battle stats derived from rarity/oracle price → **turn-based PvP duels** → ladder
  ranking → **seasonal card prizes** from a finite pot.
- **Skill / fairness:** Predominantly skill (deckbuilding + play); commit-reveal for simultaneous moves;
  VRF only for any minor variance.
- **Card→USDC / perps:** Seasonal prize pool (finite USDC/cards — **explicitly NOT a minted token**,
  per the Axie lesson). Weakest direct perps bridge of Set B.
- **Sticky:** The most "real game," highest engagement ceiling — *and* the highest build cost + design
  risk. **Axie warning baked in:** prizes from buyback pot, never inflationary emissions.
- **Build/risk:** **High** (a real game engine). Regulatory: low-medium (skill). Treat as a long-horizon bet.

**Set B ranking:** B1 Card Fantasy League ≫ B2 Price Duel > B3 Streak > B4 Draft Arena > B5 Card Battler.
**Top pick: Card Fantasy League** — skill-predominant (best legal footing), reuses the oracle as its
scoreboard (cheapest to power), recurring-contest retention, and the most natural "graduate to perps"
funnel a price exchange could have.

---

## Combined recommendation

1. **Cheapest first, to build the shared rails:** a pure-ledger casino game (**Higher or Lower** /
   Part 1's **Plinko/Mines**) to ship and battle-test the **provable-fairness module + `GAME_POOL`**.
2. **Best ROI playable game:** **Card Fantasy League** — skill-framed, oracle-powered, recurring,
   perps-native; the lowest regulatory risk of anything here.
3. **Flagship casino moment:** **The Break** — the differentiated TCG wedge, once the pot/round-worker
   exists and geofencing/structuring is in place.
4. **Marquee perps funnel:** Part 1's **Pump or Dump** (crash) + **Price Duel** — the two that most
   directly teach the core product.

**Two gates remain product/legal decisions, not engineering:** (a) the **authentic prize** (rare.win
or a vault partnership) for real cards vs. oracle-synthetic USDC now; (b) the **regulatory posture**
(skill-game structuring + geofence + KYC), where **Set B's skill games are materially safer than Set
A's casino games** — worth weighing in the build order.

