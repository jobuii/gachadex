# GachaDex — Roadmap & Deferred Decisions

Living doc for design decisions we've deliberately deferred, with the reasoning so we don't
re-litigate them from scratch later.

---

## 1. Margin model: isolated → cross (deferred)

**Decision (2026-06-09): stay ISOLATED for now.** Revisit before mainnet, or whenever the product
explicitly targets Aster-style cross-margin.

**Current behaviour (isolated margin):** a position's loss is **capped at that position's margin**.
If a price gap pushes the loss past the margin, the excess is "bad debt" → drawn from the
**insurance fund** → any remainder **socialized to the LP pool**. A trader can never lose more than
the margin they put on a position; their other balance is never at risk.

**Why we'd change it:** real futures (and our reference exchange, Aster, which shows **"Cross"** in
the Margin column) let a position draw on the trader's **whole account equity** — so a volatile gap
can cost more than the position's margin, up to the full balance, before insurance / auto-deleverage
kick in. With our **daily** price feed (see §3), large overnight gaps are realistic, so isolated mode
pushes more gap-risk onto the insurance fund / LPs than a cross model would.

**Isolated (now) vs Cross (if implemented):**

| | Isolated (current) | Cross (future) |
|---|---|---|
| Max loss on a position | the position's margin | the whole account balance (then insurance/ADL) |
| Liquidation price | from the position's margin only | from **total account equity** |
| Withdrawable balance | collateral − locked margin | collateral − margin − **unrealized losses** |
| Insurance fund | hit on any gap past a position's margin | only hit when the **whole account** is wiped |

**Scope to switch:** liquidation logic (debit up to full collateral, not capped at margin), the
liq-price formula (account-equity based), the free-balance / withdrawal check (must reserve for
unrealized losses — directly affects the custody↔trading withdrawal boundary), and the UI
(show "Cross", break-even price, etc.).

**Options when we revisit:**
1. Cross-margin globally (matches Aster; biggest change).
2. Isolated + cross toggle per position (Binance/Bybit style; most work).
3. Keep isolated, mitigate gap-risk via tighter maintenance margin / lower max leverage.

---

## 2. Manual price override (admin) — planned

**Why:** the only automated feed is pokemontcg.io (TCGplayer market price), which updates **~once a
day** and covers **Pokémon only**. Many real price sources — eBay sold listings, other marketplaces —
have **no API**. Operators need to set/override a market's price manually as they check those sources.

**Proposed approach:** a manual price is recorded through the **same path as the oracle** — write an
accepted oracle print, then recompute the mark — so it flows consistently into mark price, liquidation
checks, and the staleness circuit-breaker (a manual print also refreshes the "fresh price" timestamp).
Per-market (card or index).

**Open considerations:**
- Admin routes are currently gated behind `REAL_FUNDS`; manual pricing must also work in **play-money
  mode**, so admin-key auth needs decoupling from `REAL_FUNDS` (or a separate ops route group).
- **Audit trail:** record who set what price and when.
- **Sanity bounds:** optionally reject absurd deviations from the last price to prevent fat-finger
  liquidations.
- **Index markets:** decide whether a manual override sets the basket value directly or is card-only.
- **Surface:** HTTP admin endpoint + runbook first; a web admin panel later.

---

## 3. Price cadence (context for the above)

- Source updates **~once a day** — verified: `tcgplayer.updatedAt` is a date, not a timestamp.
- We re-pull every 6h (`ORACLE_REFRESH_MS`); the liquidation sweep runs every 5s
  (`LIQUIDATION_SWEEP_MS`) — cheap (local DB), mainly catches trade-driven mark moves and reacts
  promptly after each ingest. **5s stays.**
- The **daily feed is the real constraint.** Manual override (§2) is the near-term mitigation; a
  higher-frequency price source is a longer-term option.

---

## 4. Liquidity bootstrapping (researched, decision pending)

**Problem:** today a market needs LP seeded (by us or players) or trading doesn't work — but we want
**every market tradeable from day one** with little capital and **bounded real-USDC risk**.

**Researched 2026-06-09** — full write-up in [`docs/liquidity-research.md`](docs/liquidity-research.md).
Short version of the options (they stack; A/B is the near-term fork):

1. **A — Capped global vault** *(recommended primary)*: keep our single global LP vault, add GMX-style
   hard caps + auto-deleverage + Drift-style widening spread. Live everywhere now, risk bounded by caps.
2. **B — LS-LMSR formula quoter**: a formula is the counterparty for thin/long-tail markets; near-zero
   capital, pre-known worst-case loss per market. (Adapting prediction-market math to a leveraged perp
   is non-trivial — see doc.)
3. **C — Rent outside MMs** (Kalshi designated-MM + Polymarket per-market rewards): house-neutral, layer
   on as volume grows.
4. **D — JIT auction** (Drift-style): outside MMs take over from the backstop; long-term target.

**Cautionary tale:** a naive fixed virtual pool (Perp v1 vAMM) structurally drains under trending,
one-sided, thin markets — exactly our profile (daily price + long-tail cards). Caps are mandatory.

**Decision (2026-06-09): A + B hybrid.** Capped global vault (A) backs liquid markets; an LS-LMSR
formula quoter (B) is the counterparty for thin/long-tail cards (the common case — most cards are
thin + daily-priced). C and D layer on as volume grows.

**Math spike (2026-06-09) — settled:** LS-LMSR's bounded-loss proof does **NOT** transfer to a
leveraged perp (HIGH confidence; over-determined + an impossibility theorem). So **B is "adaptive
depth" only (B′)** — the hard USDC loss cap comes from caps + maintenance margin + ADL + oracle-
staleness halts, with per-market worst case `≈ (max OI) × (adverse oracle gap) × leverage − margin/
funding`. Full reports: [`docs/liquidity-hybrid-spec.md`](docs/liquidity-hybrid-spec.md),
[`docs/liquidity-lmsr-spike.md`](docs/liquidity-lmsr-spike.md).

**Build sequence:** Phase 1 — pool-health gate (MAX_PNL_FACTOR), **✅ done** (off by default); Phase 2 —
per-market adaptive depth `max(NAV, floor, α·cumVolume)`, **✅ done** (linear curve, no `exp()`, so the
Augur fixed-point issue doesn't apply); Phase 3 — auto-deleverage (ADL), **✅ done** (`adlPnlFactorBps`,
force-closes top winners pool-wide each sweep, off by default); Phase 4 (later) — rent house-neutral MMs
(C/D). **Calibration (2026-06-09):** proposed STARTING values in [`docs/liquidity-calibration.md`](docs/liquidity-calibration.md)
— cards 2–3x / index 5–8x leverage, ~15% / ~7% maint margin, per-market OI cap ≈ 0.3–0.5×NAV, open-gate
50–60% / ADL 70–80% of NAV (ADL stays **above** the gate — our open-gate isn't GMX's profit hard-cap, see
doc §4), α calibrated to volume. ADL web toast: **✅ done**.

**Phase 4a — NAV-relative OI cap: ✅ done.** `OI_CAP_NAV_BPS` caps each side's OI at a fraction of LP NAV
(on top of the static per-market cap), so one position can't outgrow the pool — the fix for the
negative-NAV finding the live exercise surfaced. Off by default; ~3000–5000 for real funds. (`oi-cap-nav.test.ts`.)

**Still to validate before real-funds launch (doc §7):** measure the actual DAILY single-card price gap
`g` (the governing input — verified data is only monthly); size the insurance fund for the liquidation→
next-print slippage (no daily-oracle precedent); backtest the caps; re-pull venue params at build time.

## 5. Real-money referral program (post-launch, deferred)

Today's referral bonus is **play-money only**: `redeemReferral` credits from `FAUCET_SOURCE` and is
hard-gated `!config.realFunds` (`referral.ts:142`), and the panel blurb hides when `rewardsEnabled`
is false. So at the real-funds launch there is **no referral incentive** — the bonus and the
"$X play-USDC" copy both turn off automatically. (Same gate as the faucet.)

A real-money referral program is a deliberate feature, not a flag flip, because real payouts change
the risk:
- **Cost:** every referral pays real USDC out of the house. `FAUCET_SOURCE` doesn't exist for real
  funds — a real bonus needs a funded budget bucket (e.g. `FEE_REVENUE` or an operator allocation,
  mirroring the insurance-fund pattern). Never credit unbacked USDC into `USER_COLLATERAL` — that
  breaks proof-of-reserves, exactly what the current gate prevents.
- **Abuse:** a flat signup bonus is sybil-farmed (one person, many wallets). `MAX_REFERRALS_PAID`
  caps per-referrer count, but real money raises the incentive — tie rewards to *real activity*, not
  a flat signup credit.
- **Compliance:** paying real value sits on the same KYC/AML surface as deposits/withdrawals.

**Options (decision pending):**
1. **No real referral program** — simplest; launch without one.
2. **Fee rev-share** *(recommended if any)* — referrer earns a % of the referred user's trading fees.
   Real activity → real reward, low farming risk, self-funding from fees. Common in crypto.
3. **Deposit-matched / volume-milestone bonus** — pay after the referred user deposits or trades $N.
   Cuts signup farming; still a marketing cost.
4. **Flat signup bonus** — highest abuse risk; only with strong KYC + tight caps.
