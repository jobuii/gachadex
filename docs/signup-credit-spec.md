# Free Signup Credit — Spec

**Status:** DRAFT → **QA'd + revised** (grounding + adversarial design review, 2026-06-30). Not built; flag-gated when built. The QA caught a **principal-leak in the earlier withdrawable formula** (old §2.4) and a headline contradiction — both fixed; §2.2 is now the single authoritative rule. Remaining product calls in §9.
**Author:** design session 2026-06-30.
**One-liner:** Give new accounts a configurable amount of **free, tradeable, non-withdrawable** USDC credit, with loss-prevention so we never give away the principal and bound the cost of withdrawable winnings.

---

## 0. The framing you must internalise first

On a real-money venue the **principal being non-withdrawable is the easy 10%**. The expensive 90%:

1. **Winnings made with free credit are real, withdrawable money.** A user who turns $50 of credit into $90 has $40 of real, cashable profit.
2. **On this platform that profit is paid out of the LP pool.** Trading PnL settles `+USER_COLLATERAL / −LP_POOL` (`engine.ts`, reason `REALIZED_PNL`). So a free-credit winner is literally paid by your liquidity providers unless the program is funded separately.
3. **Solvency.** The codebase already refuses to boot in real-funds mode if the play-money `FAUCET_SOURCE` carries any balance ("must never become withdrawable as real USDC", `db/init.ts`). Translation: *unbacked credit that can become withdrawable is forbidden.* **DECIDED (§9.2): a dedicated `CREDIT_BUDGET` account, pre-funded from `FEE_REVENUE`** (your earned fees) via an admin transfer. Grants draw from `CREDIT_BUDGET`, backed by the real custody USDC that backed those fees — solvency/PoR stays intact, and **grants can't exceed what you've funded (the budget balance is the hard cap).** The grant *principal* is CREDIT_BUDGET's; a credit user's winning **trades** are still paid by `LP_POOL` (the engine's PnL counterparty) — optional Phase-2 LP reconciliation in §9.2.
4. **Account creation is ≈ free and permissionless** (an account is just a Solana wallet — see §5). So "free money per account" is, by construction, an abuse magnet you *contain*, not *close*.

This spec therefore has two halves: the **money mechanism** (clean, low blast-radius) and the **anti-sybil stack** (the hard part).

---

## 1. How it fits the code (clean insertion)

- **One spendable balance** — `USER_COLLATERAL`. Deposits, faucet, referral, and trading PnL all land there and are fungible (`ledger.ts`, `getUserBalances` in `faucet.ts`). Trading "just works" if credit sits here — no engine changes.
- **One withdrawal chokepoint** — `requestWithdrawal` (`services/custody/withdrawals.ts:171`): `available = balance(USER_COLLATERAL); if (available < amount) throw 'insufficient balance'`. Today it's the *full* balance. Non-withdrawable credit = change that one read to a `withdrawableBalance(...)` helper.
- **Money is classified by ledger `reason`** (`EXTERNAL_CAPITAL_REASONS` in `leaderboard.ts:11`; `TXN_TYPE` in `history.ts`). A new reason `SIGNUP_CREDIT` slots straight in — no separate account for the credit itself.
- **Funding = a dedicated `CREDIT_BUDGET` account, topped up from `FEE_REVENUE` (DECIDED).** New system account `CREDIT_BUDGET` in `SYSTEM_ACCOUNT_TYPES`; the operator transfers earned fees into it from the admin Perks page (`+CREDIT_BUDGET / −FEE_REVENUE`). Grants draw from `CREDIT_BUDGET`; **its balance is the hard cap** (grants pause when exhausted). Self-funded from house profits, visible + capped, and keeps the principal off the LP pool.

---

## 2. The money mechanism

> **This model exists in the wild — Bitget's "Futures Trading Bonus" is the near-exact analog** (validated, primary source): the bonus serves as **margin to open positions and offsets fees/funding/losses up to the bonus amount, but the principal can never be withdrawn**, and *any withdrawal or transfer from the account voids the unused bonus* — **only profits earned trading the bonus are withdrawable.** Our floor model (§2.2) is a more granular version of the same idea; "any withdraw voids unused bonus" is a cruder fallback option if the floor proves fiddly.

### 2.1 Grant
At the qualifying moment (see §5 for *when* — signup vs deposit-gated), post one balanced txn:

```
reason: 'SIGNUP_CREDIT'
+ USER_COLLATERAL  (user)      +grantE6
− CREDIT_BUDGET    (system)    −grantE6
```

**Funding = `CREDIT_BUDGET`, topped up from `FEE_REVENUE` (DECIDED, §9.2).** The operator funds the program by transferring earned fees into the budget (admin Perks page): `+CREDIT_BUDGET / −FEE_REVENUE`. Each grant then debits `CREDIT_BUDGET`; **clamp so a grant can't exceed the CREDIT_BUDGET balance** (the funded balance is the hard cap — when it runs dry, grants pause until topped up). Backed by the real custody USDC that backed those fees, so solvency/PoR holds. **Lock `CREDIT_BUDGET` `FOR UPDATE` when debiting it (`getBalanceForUpdate`, `ledger.ts:144`) — do NOT reuse the unlocked `creditCapped` pattern (QA M3):** `creditCapped` clamps on the *user's* headroom and lets its source go negative, so two concurrent grants would both read the same budget balance and overdraw it (→ unbacked liability → PoR breach). Record the grant per user (`signup_credits` row, or `Σ SIGNUP_CREDIT` by reason). **Reason-list updates (QA L1): add `SIGNUP_CREDIT` *and* `SIGNUP_CREDIT_EXPIRE` to `EXTERNAL_CAPITAL_REASONS` (`leaderboard.ts:11`)** — else the grant is miscounted as trading PnL and the claw-back as a trading loss — **and add both to `TXN_TYPE` (`history.ts`)** or they vanish from users' transaction history.

### 2.2 The non-withdrawable rule (the WHOLE trick — SINGLE AUTHORITY)
There is exactly **one** withdrawal-cap helper, `withdrawableBalance(userId)` — the only thing §8 changes at the chokepoint. Definitions: `C` = current USER_COLLATERAL balance, `G` = grant principal still outstanding (`Σ SIGNUP_CREDIT − Σ SIGNUP_CREDIT_EXPIRE` for the user), `D` = the user's own net capital still in (`Σ DEPOSIT − Σ prior own-withdrawals`, floored at 0).

```
floor (never withdrawable) = min(G, C)
withdrawable = wageringMet
    ? max(0, C − G)              // post-wagering: everything above the grant principal
    : min(max(0, C − G), D)      // pre-wagering: only your OWN deposited capital back — no winnings
```

- The grant `G` is **never** withdrawable (the floor). Losses hit the user's own money first — "cash-before-bonus" (validated vs casino practice).
- `max(0, C − G)` is the absolute ceiling on what can ever leave; the wagering gate just restricts it to `D` until met.
- **Worked examples (these now agree with §2.3 — the earlier draft did not):**
  - **No deposit, $50 grant, trade to $90:** pre-wagering `min(40, 0) = $0` — winnings are **locked until they deposit $50 + trade $1,000**, then `max(0,90−50)=$40` unlocks. *(The earlier draft wrongly said $40 immediately — QA C2.)*
  - **$100 deposit + $50 grant, lose $80 → C=$70:** `min(max(0,70−50), 100) = $20` — surviving cash; **the $50 grant never leaks.** *(The earlier §2.4 formula wrongly returned $70 — QA C1.)*
  - **$100 deposit + $50 grant, win to $200, wagering met:** `max(0,200−50) = $150` — deposit + winnings, grant still locked.

### 2.3 Wagering gate — a LIVE condition, not a sticky flag
`wageringMet` is evaluated **at withdrawal time** as BOTH currently true:
- **net deposits `D` ≥ $50** (the deposit must still be in — see below), **and**
- **cumulative post-first-deposit trade volume ≥ $1,000.**

> **Why live, not sticky (fixes a bypass — QA H3):** a one-time flag lets a bot deposit $50, flip the flag, immediately withdraw the $50 (own money), then cash out grant-funded winnings with no real money left in. Requiring `D ≥ $50` *at withdrawal time* forces the deposit to actually stay.

> **Calibration (research):** turnover = `multiple × bonus`; $1,000 on $50 = 20× — conservative (industry ~20–50×, avg ~35×, >40× predatory); a knob. **Caveat (QA H2): on a *leveraged* perp, $1,000 of volume is one round-trip for a few dollars of fees — turnover alone is weak friction.** If abuse appears, turn ON the §2.7 leverage cap during the bonus phase and/or switch wagering to fees-paid or realized-loss-based. (Do NOT cite per-type bands; see Appendix A.)

> **"Bonus volume doesn't count" (definitional — and this is what's BUILT):** collateral is one fungible pool, so once credit and deposits mix you cannot attribute a given trade's volume to bonus-vs-real dollars. The literal ask ("bonus-funded volume must not count") is therefore not implementable per-dollar. The built proxy enforces the *intent*: require the real deposit first, then count only fills with `created_at ≥ the first DEPOSIT` (`creditState`, `signup-credit.ts`). Pre-deposit bonus-only churn earns **zero** wagering credit; post-deposit trading counts regardless of which dollars fund it.

### 2.4 Notes on the rule (the earlier separate formula was wrong)
- §2.2 is the **single authority.** The earlier `ownNetDeposits + bonusWinnings` formula was **removed** — it ignored trading losses and **leaked the grant** on any deposit-then-lose path (QA C1).
- **Do NOT reuse this helper in `treasury.ts` PoR liability math (QA M7).** Non-withdrawable credit is *still a real liability* (it sits in USER_COLLATERAL, is tradeable, and its winnings become cashable). PoR must keep counting the full `|TREASURY_USDC|`; subtracting the floor would understate liabilities and break the solvency check.
- **`G = 0` must be byte-identical to today (QA L2):** a normal (non-credit) user's `withdrawableBalance` = `max(0, C − 0) = C` = the current raw balance read. Test this equivalence so the chokepoint change can't regress normal withdrawals.

### 2.5 Expiry — DORMANCY (unused → reclaimed; DECIDED — supersedes the earlier hard-from-grant)
**DECIDED (operator, 2026-07-01):** credit expires only when the account goes **dormant** — **no fills for `expiryDays` days (default 7) AND the grant is at least that old** (the grant is the start-of-clock, so a never-traded account expires `expiryDays` after the grant). **An account that has traded within the window keeps its credit.** This is the "expires if unused; keep trading and the credit stays" rule the operator asked for — it *replaces* the earlier hard-7-day-from-grant design.

> **Accepted trade-off (the original §2.5 objection, now overridden):** a sliding window means a dust trade every `expiryDays−1` days keeps the free option alive indefinitely. The operator has accepted this because the downside is small: the credit is **non-withdrawable** (the floor), winnings are gated behind the **wagering** requirement, the **CREDIT_BUDGET** balance hard-caps principal, and the **velocity freeze (§3.1)** bounds mass abuse — a kept-alive-but-uncashable credit costs the house almost nothing. If dust-trade keepalive ever bites, add a hard-cap overlay later without a redeploy.

**Built:** the sweep's due-set is `expired_at IS NULL AND granted_at < now() − expiryDays AND NOT EXISTS (a fill by this user within expiryDays)` (`expireSignupCredits`, `signup-credit.ts`), run every ~10 min by the maintenance loop. On expiry, claw the still-present credit back:
```
reason: 'SIGNUP_CREDIT_EXPIRE'
− USER_COLLATERAL  clawAmount
+ CREDIT_BUDGET    clawAmount
```
- **`clawAmount` must count credit parked in open-position margin, not just free collateral (QA M2).** Margin moves `USER_COLLATERAL → USER_POSITION_MARGIN` on open, so `min(G, freeCollateral)` can read ~$0 for a user holding the grant as margin → the sweep would claw nothing, mark the row expired, and (if "expired" drops `G` from the floor) **un-lock the principal when the position later closes.** Fix: compute against `free + locked margin`, and **only reduce `G` by what was actually clawed** (never zero `G` while collateral/margin still backs it); claw the residual when the position closes.
- **Lock the `USER_COLLATERAL` row `FOR UPDATE` in the sweep** — it races position-close + withdrawal. Idempotent; reuses the gacha-reconciler pattern.

### 2.6 Max-cashout cap on bonus winnings — **v1: OFF / unlimited (DECIDED)**; knob retained for later
**DECIDED: no cap in v1.** Winnings withdraw per §2.2 + the wagering gate, with no extra ceiling — so there is **no "graduation" question and no stranded-winnings problem** (both were artifacts of a finite cap; see §9.4). The knob `signup_credit_max_cashout_usd` is still built but **defaults to unlimited**; you can switch on a finite cap later if abuse appears, without a redeploy.

> *If a finite cap is ever turned on* (the casino playbook caps free-bonus winnings ~$100): it would apply to **bonus-derived withdrawals = withdrawals attributed deposit-first then winnings** (cumulative in `bonus_cashout_paid_e6`), and should **lift once net deposits ≥ the grant** so real depositors aren't capped (QA H5); `0` = nothing withdrawable (pure demo). All of that is **deferred** — v1 ships only the dormant unlimited knob.

### 2.7 Bonus-active trading caps (ADDED from research — operator-adjustable, DEFAULT = no restriction)
Casinos cap **max bet per round ($5–$10)** while a bonus is in play, to stop someone converting a small bonus into a huge swing. The perp analogue is **optional** caps on **leverage**, **max position notional ("max bet")**, applied only while an account holds unspent credit (`remainingCredit > 0`) and hasn't met wagering. **These are operator knobs and DEFAULT to OFF / unlimited** — out of the box a credit account trades exactly like a normal account (full leverage + size). The operator can tighten them later from the Perks page if abuse appears. Knobs (all default unlimited): `signup_credit_max_leverage`, `signup_credit_max_position_usd`.

---

## 3. Anti-sybil stack (the hard part — see §5 for why it's necessary)

> **BUILD STATUS (updated 2026-07-01): §3.1 (velocity freeze) and §3d (manual-review hold) SHIP in Phase 1; the rest of §3 does not.** Phase 1 now includes the money plumbing, the *manual-review hold* on the first credit-origin withdrawal (§3d), **and the velocity auto-freeze (§3.1)**. Still deferred to **Phase 2+** (see §10): captcha/SMS at grant time (§3a), on-chain funding-source clustering (§3b/§3.2), and device/IP fingerprint caps (§3c). Those remain design documentation so the picture is complete, but are out of scope until the program is turned on. The plain-English walkthrough of how the clustering works is in **§3.2**.

Layered, strongest → weakest. **The plan's saving grace is the manual-review hold (#d) — but it only works if the reviewer has signal, which comes from clustering (#b).**

**Gate the money, not the door** (you cannot stop wallet creation cheaply):

- **a. Per-account cost + one-per-IDENTITY (not per-email/wallet) at grant time** — Cloudflare Turnstile and/or SMS verification. Turns "1,000 accounts for $0" into "1,000 accounts for real money/effort". Research consensus (Stripe): **scope eligibility to one redemption per verified identity, not per email** (email limits are trivially defeated). The mature operator checklist (Ignition Casino T&Cs) is "one bonus per individual / household / address / email / device / IP / bank / phone" — i.e. dedupe on *every* stable signal you can collect, not just one.
- **b. On-chain clustering (crypto-native, powerful, data already exists; this is the lever airdrops actually use).** Winnings only withdraw after a deposit, and deposits + withdrawals are on-chain. Build a **funding-source + transfer graph** and run community detection — exactly what Trusta Labs and the Arbitrum/Hop airdrops did:
  - Trusta builds a token-transfer graph + a **gas-funding graph** (who first funded each wallet) and flags four farm topologies: **star-divergence** (one funder → many), **star-convergence** (many → one), **tree**, and **chain**.
  - Arbitrum built funder/sweep edges (first-in / last-out), partitioned into connected subgraphs, broke big ones with the **Louvain community-detection algorithm**, and flagged groups **>20 addresses**, addresses **funded from the same source**, and addresses **cashing out to the same CEX deposit address**.
  - Scale check: Hop flagged **~24% of eligible wallets (10,253 / 43,058) as sybils** — a near-quarter farm rate even on a one-time snapshot. Expect heavy farming.
  - **Crucial lesson (Hop):** they set a *conservative false-positive bar* and refused any method with "a non-negligible chance of eliminating legitimate users." So **cluster signal feeds the manual-review queue (#d) — do NOT auto-block on it.** Cap grants/payouts per cluster + surface "1 of N funded from the same wallet" to the reviewer.
  - Caveat: this evidence is from one-time airdrop *snapshots*, not live real-time gating — applying it continuously is reasonable but unproven; lean on review, not auto-deny.
- **c. Cheap filters** — device fingerprint + IP/subnet **velocity caps on GRANTS** (not signups). Catches lazy bots.
- **d. Manual-review hold on the FIRST withdrawal from any credit-origin account.** **NOT automatic from the §8 chokepoint change (QA H4):** auto-approval runs in `willAutoApprove` / `processAllRequested` (`withdrawals.ts`), which select purely by `amount ≤ auto-cap` — nothing there excludes credit accounts. You must add a **per-user "needs manual review" condition the auto-approval query honours.** Definitions: **"credit-origin account"** = ever received a `SIGNUP_CREDIT` grant; **"first withdrawal"** = no prior `confirmed` withdrawal. Such a withdrawal is forced to stay `requested` (manual) regardless of `withdrawal_auto_process`/amount; a human/heuristic clears it (with the §3b cluster signal in view) before real USDC leaves. Reuses the existing manual path + daily cap + PoR freeze.
- **e. Backstops that bound the blast radius:**
  - **The `CREDIT_BUDGET` balance caps the PRINCIPAL granted** — top it up from `FEE_REVENUE`; when empty, grants pause. **It does NOT cap total program cost (QA H1):** credit users' winning *trades* settle from `LP_POOL` (uncapped by the budget), bounded only by the per-account §2.6 max-cashout × the number of accounts (which is unbounded until §3 sybil defense ships). What actually bounds the variable cost: the §2.6 cap + the sybil gates + the optional Phase-2 LP reconciliation (§9.2) — not the budget alone.
  - **Low leverage + position-size cap on bonus money** — smaller winners, less to chase.
  - **Anomaly detection** on the signature: signup → bonus → high-lev trade → deposit-exactly-$50 → churn-exactly-$1k → withdraw. (Precedent: referral bonuses already pay only the "first N" referrers — an anti-farming cap.)

### 3.1 Velocity alarm (mechanism #5 — freeze the GRANT, never signups) — **BUILT (Phase 1)**
**Trigger:** more than **N new accounts in the last 24h** (knob `signup_credit_daily_account_cap`, default **50**). **Action:** raise a flag on the admin **Perks page** (a red "Grants FROZEN" banner + a live "Signups (24h): n / cap" card) **and auto-freeze new bonus grants** — existing accounts and *signups continue normally*; only the free-money issuance pauses. **The admin unfreezes** from the Perks page.

> **The one change from the original ask:** the original #5 said "freeze account creation". Don't — that's a self-inflicted DoS: anyone could spin up 51 throwaway wallets to halt signup for *all* real users, and it wouldn't even stop the bot (its accounts already exist). Freezing only the **grant** is safe and achieves the same goal — an account with no free money is harmless.

**Built (2026-07-01):**
- `enforceSignupVelocity(db)` (`signup-credit.ts`) counts `users` created in the last 24h; if `count > dailyAccountCap` it LATCHES `signup_credit_frozen = true` (a settings knob). It **only ever sets** the latch — never auto-clears it (an auto-unfreeze would re-open the flood the instant the 24h window rolls).
- Enforced in **two places**: synchronously inside `grantSignupCredit` (a grant attempt while over the cap freezes + issues nothing), and proactively in the `startSignupCreditMaintenanceLoop` pass (~every 10 min, so the freeze + admin flag trip even before the next deposit).
- **Unfreeze** = admin sets `frozen = false` from the Perks banner. NB: if signups are *still* over the cap, the next grant/loop re-freezes — so to resume during a legitimate surge the admin raises `dailyAccountCap`. This is deliberate fail-closed behaviour.
- The **`CREDIT_BUDGET` balance** remains the ultimate hard stop regardless.

Optional Phase-2 refinements: also apply **per-signal** caps (per IP/subnet/fingerprint/funding-cluster) so one farm trips only its own limit rather than the global switch.

### 3.2 How the on-chain clustering works — in depth, plain English (design only; NOT built in Phase 1)

**The problem:** a bot makes thousands of fake wallets to farm the free credit. One at a time they're indistinguishable from real new users. The trick is to follow the **money trail**, because fake wallets almost always share a common source.

**How the defense works (this is what real crypto projects actually do):**
- **Everything is on a public blockchain.** Where each wallet got its first money/gas, and where it sends money out, is visible to anyone.
- **Build a graph.** Every wallet is a dot; draw a line between two whenever money flowed between them (or one paid the other's gas). Real users are scattered, unconnected dots. **A bot farm is one big connected blob** — because the operator funded all 1,000 wallets from one source, and/or cashes them all out to one address.
- **The tell-tale shapes ("topologies")** — Trusta Labs named the four a farm makes: **star-out** (one wallet → many, the funder spraying cash), **star-in** (many → one collector), **tree** (funder → middle wallets → leaves, to hide the link), and **chain** (A→B→C→D in a line).
- **Finding the blobs automatically ("Louvain community detection")** — an algorithm that scans the whole graph and groups densely-connected dots, outputting "here's a cluster of 340 wallets all tied together." Arbitrum used exactly this: flag any group >20 wallets, any wallets funded from the same source, or all withdrawing to the same exchange deposit address.
- **Scale check:** Hop Protocol ran this and found **~24% of "eligible" wallets were fake** (10,253 of 43,058). Nearly a quarter — so farming at scale is the norm, not paranoia.
- **The critical lesson — don't auto-ban.** Clustering isn't perfect (real users can look linked, e.g. all withdrawing from the same exchange). Hop refused to auto-remove anyone if the method might catch a real user. So the right move is to **use the cluster as a FLAG for human review before paying out** — which is why §3d routes the first withdrawal from any credit account to manual review, showing the reviewer "this wallet is 1 of 340 funded from the same source."
- **The boring-but-essential other half:** limit the bonus to **one per real person, not one per email** (emails are free/infinite). Mature operators dedupe on every stable signal — phone, device fingerprint, IP, payment method — not just one.

**Bottom line:** you can't stop fake wallets being created, but you *can* see they're all funded by the same hand — and you flag those for a human check before real money leaves. **Deferred: this is Phase 2+ work, documented now so the design is complete.**

---

## 4. Admin surface

- **Customers tab** — two new columns: **Free Credit** (`Σ SIGNUP_CREDIT`) and **Remaining** (`min(grant, collateral)`). Same reason-sum pattern as the just-shipped Gold column.
- **Overview** — a box: **Total bonuses issued ($)** = `Σ SIGNUP_CREDIT` across all users (and ideally net of expiries/claw-backs).
- **New "Perks" admin page** — the home for all bonus/perk controls:
  - `signup_credit_usd` **live knob** (like the chat/gacha config knobs) + **on/off flag** + **`CREDIT_BUDGET` balance readout** (set amount to 0 / off ⇒ dormant).
  - **"Fund budget" control** — transfer USDC from `FEE_REVENUE` → `CREDIT_BUDGET` (the program's funding source), showing both balances. This is how the operator tops up the program from earned fees.
  - Wagering thresholds (deposit min, volume min ≈ turnover ×), dormancy **expiry window**, and the **daily-account-cap** velocity knob — all live knobs. *(max-cashout §2.6 + bonus-active caps §2.7 are Phase-2 knobs, not surfaced yet.)*
  - **Velocity freeze surface (§3.1, BUILT):** a live **"Signups (24h): n / cap"** card + a red **"Grants FROZEN"** banner with an **Unfreeze** button when the cap is breached.
  - **Manual-review queue** for first credit-origin withdrawals, each row showing the cluster signal (funding source, destination, IP/fingerprint, how many sibling accounts).
  - Velocity/cluster alerts + the grant-pause toggle.

---

## 5. Why anti-sybil is necessary — the account model (grounded)

- **An account is a wallet, nothing else.** Created on SIWS verify by: `INSERT INTO users(id, solana_pubkey) ON CONFLICT(solana_pubkey) DO NOTHING` (`auth.ts:273`). No email, KYC, captcha, phone, or device check exists (KYC/AML is only a *future* gate for mainnet real-funds, `config.ts:280`).
- **Botting cost ≈ one HTTP round-trip per account:** `Keypair.generate()` (offline/free/infinite) → `/auth/nonce` → sign offline (tweetnacl) → `/auth/verify` → JWT. The only friction is an IP rate limit (`RL_AUTH_NONCE=30`, `RL_AUTH_VERIFY=30`), bypassed with rotating IPs.
- **Why the wagering gate alone doesn't stop the farm:** the bonus is a **free option** — capped downside (house money, non-withdrawable) + real upside (withdrawable winnings). 1,000 × $50 of variance; large numbers *guarantee* a profitable subset; the bot pays the deposit+volume cost **only on winners**. Net positive-EV unless account/grant cost is raised (§3).

---

## 6. Ledger entries (summary)

| Event | Posting (reason) |
|---|---|
| Fund budget (admin) | `+CREDIT_BUDGET / −FEE_REVENUE` (`CREDIT_BUDGET_FUND`) — move earned fees into the bonus budget |
| Grant | `+USER_COLLATERAL / −CREDIT_BUDGET` (`SIGNUP_CREDIT`) — clamped to the budget balance |
| Trade win | `+USER_COLLATERAL / −LP_POOL` (`REALIZED_PNL`, unchanged) |
| Trade loss | `−USER_COLLATERAL / +LP_POOL` (`REALIZED_PNL`, unchanged) — eats the floor first while no deposit |
| Withdrawal | `−USER_COLLATERAL / +TREASURY_USDC` (`WITHDRAWAL`, unchanged) — **capped by `withdrawableBalance()`** |
| Expiry claw-back | `−USER_COLLATERAL / +CREDIT_BUDGET` (`SIGNUP_CREDIT_EXPIRE`) — returns to the budget |

Reason-list updates required: `EXTERNAL_CAPITAL_REASONS` (`leaderboard.ts`) and `TXN_TYPE` (`history.ts`) must include `SIGNUP_CREDIT` (+ the expire reason).

---

## 7. Schema / config

- **New system account type** `CREDIT_BUDGET` — add to BOTH the `AccountType` TS union (`ledger.ts:13-29`) **and** the `SYSTEM_ACCOUNT_TYPES` array (or it won't type-check). Funded from `FEE_REVENUE` via an admin transfer on the Perks page (DECIDED, §9.2).
- **`signup_credits`** table (BUILT): `user_id`, `granted_e6`, `granted_at` (dormancy start-of-clock), `expired_at`, `first_withdrawal_reviewed`. `first_deposit_at`/`last_trade_at` are **derived live** from the ledger + fills (not stored): wagering = net deposits ≥ $50 now + post-first-deposit volume ≥ $1k, and dormancy = no fill within the window — **no sticky `wagering_met_at`** (QA H3). `cluster_id`/funding-source is Phase 2; `bonus_cashout_paid_e6` only if a finite §2.6 cap is later turned on.
- **Knobs (liveKnob pattern) — the seven BUILT:** `signup_credit_enabled` (bool), `signup_credit_usd` (grant amount; each grant clamped to the live `CREDIT_BUDGET` balance, which is the hard cap), `signup_credit_wager_deposit_usd` (50), `signup_credit_wager_volume_usd` (1000 ≈ 20× turnover; defensible up to ~40×), `signup_credit_expiry_days` (7, **dormancy window** §2.5), `signup_credit_daily_account_cap` (§3.1, default 50 — flag + auto-freeze grants), `signup_credit_frozen` (bool — the velocity latch; auto-set on breach, cleared only by an admin). *Phase-2 knobs not yet built:* `signup_credit_max_cashout_usd` (§2.6), `signup_credit_max_leverage` + `signup_credit_max_position_usd` (§2.7).
- **Solvency:** grants debit `CREDIT_BUDGET`, funded from `FEE_REVENUE` (real, already-collected fee USDC), so they create **no unbacked liability** (unlike the faucet) — PoR stays intact. Invariant: a grant can't exceed the `CREDIT_BUDGET` balance (clamp; never drive it negative) — the funded balance is the cap. (Distinct from the faucet's `db/init.ts` ban, which exists precisely because faucet credit is *un*backed.)

---

## 8. The chokepoint diff (the core code change)

`services/custody/withdrawals.ts` ~line 171, replace the raw balance read:
```ts
// before
const available = lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n;
// after
const available = await withdrawableBalance(q, userId); // collateral − non-withdrawable floor, gated by wagering
```
Plus: credit-origin accounts skip auto-approval (route to manual) for the first withdrawal.

---

## 9. PRODUCT DECISIONS

1. **Free-on-signup vs deposit-first — RECOMMENDATION RECORDED: deposit-first.** Free-on-signup maximises reach but keeps account cost ≈ $0 (abuse magnet, contained only by §3); **deposit-first** (bonus unlocks/matches only after a real deposit) is the only design that's *close to bot-proof*. Recommendation = **deposit-first**. *Free-on-signup is left for now* (not chosen, not ruled out) — revisit if reach matters more than abuse-resistance. Build Phase 1 so the grant trigger is a config (deposit-gated vs at-signup) rather than hard-coded.
2. **Who funds the cost — DECIDED: a dedicated `CREDIT_BUDGET`, topped up from `FEE_REVENUE`.** The operator transfers earned fees into `CREDIT_BUDGET` from the admin Perks page; grants debit it, and the funded balance is the hard cap. Self-funded from house profits → visible, capped, and the principal stays off the LP pool. **Honest nuance:** a credit user's winning *trades* are still paid by `LP_POOL` (the engine's PnL counterparty), so the LP pool bears the trading-winnings portion even though `CREDIT_BUDGET` owns the principal. To fully insulate LPs, **Phase 2** can add a periodic reconciliation that reimburses `LP_POOL` for credit-origin PnL out of `CREDIT_BUDGET`. v1 = `CREDIT_BUDGET`-for-principal + the cap (already far better than LP-funding). *(Switched from an earlier LP-pool-funded draft because there are meaningful third-party LPs — their capital shouldn't silently fund promos.)*
3. **Which §3 gates ship first** (still open) — at minimum (a) one per-account cost gate + (d) manual hold + (e) capped budget. (b) on-chain clustering is the highest-leverage add.
4. **QA-surfaced calls — RESOLVED for v1:**
   - **Max-cashout cap = OFF / unlimited (§2.6, DECIDED).** Therefore (a) the **graduation threshold** and (c) **stranded-winnings policy** **do not apply to v1** — both were artifacts of a finite cap and only resurface if one is turned on later.
   - (b) **Turnover gate: accept the raw $1k-volume rule for v1 (DECIDED);** hardening (bonus-phase leverage cap, or fees-paid/realized-loss wagering) **recorded for Phase 2** (QA H2: $1k volume ≈ one leveraged round-trip).
   - The free **principal stays non-withdrawable forever** (original "non-withdrawable principal" requirement — unchanged).

---

## 10. Phasing

- **Phase 1 (dark, flag-gated `signup_credit_enabled=false`) — BUILT:** ledger plumbing (new `CREDIT_BUDGET` account + the `FEE_REVENUE`→`CREDIT_BUDGET` transfer control; `SIGNUP_CREDIT` grant from `CREDIT_BUDGET`, clamped to its balance; reason-list updates), the `withdrawableBalance()` floor + wagering at the chokepoint, **dormancy expiry (§2.5) swept by `startSignupCreditMaintenanceLoop`**, the two customers columns, the `signup_credit_usd` knob + `CREDIT_BUDGET` balance readout, the Perks page with the manual-review queue, credit-origin first-withdrawal → manual, **and the §3.1 velocity auto-freeze (`dailyAccountCap` + `frozen` + admin banner/unfreeze)**. Grant trigger fires on first deposit (at-signup mode parked). No real grants until flipped on.
- **Phase 2:** the remaining sybil gates — Turnstile/SMS at grant, on-chain clustering in the review queue, per-signal (IP/subnet/fingerprint/cluster) grant caps. **Plus turnover-gate hardening (QA H2):** bonus-phase leverage cap, or switch wagering from raw volume to fees-paid / realized-loss.
- **Phase 3:** anomaly detection, expiry-window tuning, analytics on program EV (cost vs retained-deposit value).

---

## 11. Test plan (high level)

- Withdrawable rule (§2.2): no-deposit grant, win → withdrawable **$0 until wagering met** (then = winnings); lose → $0; **principal never withdrawable**. Deposit+grant, lose past the deposit → withdrawable = surviving cash, **grant never leaks** (the C1 regression). Deposit+grant, win + wagering met → deposit + winnings, grant locked. **`G=0` (normal user) → withdrawable == raw balance (L2 equivalence).**
- Wagering (§2.3): LIVE check — `D ≥ $50` at withdrawal time (deposit-then-withdraw must NOT keep it met); post-deposit volume ≥ $1,000; not-met blocks winnings, met releases.
- Max-cashout (§2.6): OFF in v1 (unlimited) — no test needed for v1 (if a finite cap is later set: deposit-first attribution, lifts at net deposits ≥ grant).
- Expiry (§2.5): **dormancy** — an unused grant older than the window is swept; **an account that traded inside the window keeps its credit**; once it goes quiet past the window it too expires. Claw counts margin-parked credit; `G` reduced only by what's clawed; no un-lock when a position later closes. *(covered by the `expiry — dormancy` test.)*
- Budget: grant clamped/blocked when `CREDIT_BUDGET` is insufficient; budget debit **locked `FOR UPDATE`** so concurrent grants can't overdraw (M3); never creates unbacked liability.
- Sybil / velocity: a credit-origin first-withdrawal does NOT auto-approve even with `withdrawal_auto_process` on; **>`dailyAccountCap` signups/24h latches `frozen` so grants issue nothing until an admin unfreezes** (signups themselves never blocked), and the latch never auto-clears. *(covered by the `velocity` test.)*
- Solvency/PoR: `withdrawableBalance` is **NOT** used in `treasury.ts` PoR liability — PoR still counts the full `|TREASURY_USDC|` incl. the credit (M7); `db/init.ts` invariant holds.

---

## 12. Regulatory / responsible-trading (flagged by the research — get legal review)

A tradeable, non-withdrawable "free credit" on a crypto **perpetual-futures** product sits at the intersection of **gambling-promotion, derivatives/securities, and AML/KYC** rules, and may be characterised as a **gambling inducement** or an **unregistered derivatives promotion** depending on jurisdiction. The casino playbook this spec borrows from operates under licensed responsible-gambling regimes (deposit limits, self-exclusion, before-payout KYC, geofencing). Before launch assume you need **KYC/AML, jurisdiction geoblocking, clear non-withdrawable + wagering disclosure at claim time, responsible-trading safeguards, and legal review.** No researched source opines on the legality of this exact structure — treat it as an open legal question. (Dovetails with the existing mainnet gate: real-funds on mainnet is already blocked behind "audit + KYC/AML + geofence", `config.ts`.)

---

## Appendix A — research findings (cited; deep-research pass 2026-06-30)

21 of 25 verified claims confirmed (3-vote adversarial verification).

**Non-withdrawable bonus mechanics (casino/sportsbook — the mature playbook):**
- Principal is locked behind a **wagering/turnover requirement = multiple × bonus** ($50 @ 30× = $1,500 to wager) before any bonus-derived funds withdraw. [acgcs.org, sportsline]
- **>40× is the aggressive ceiling**; the 20×–50× band averages ~35×. **Max bet $5–$10/round** while a bonus is active. [gamblingnerd, corroborated]
- After wagering, a **max-cashout cap on winnings (~$100 typical for free bonuses)**; signup credit is explicitly **non-withdrawable** with a **short hard expiry** (DraftKings free spins void in 24h; FanDuel site credit in 7 days). [next.io + trackers]
- **Loss ordering = "cash-before-bonus"** (cash spent first, bonus only once cash is gone) — validates §2.4.

**Crypto analog (the closest real product):** Bitget Futures Trading Bonus — usable as margin + offsets fees/funding/losses up to the bonus, principal never withdrawable, any withdrawal/transfer voids the unused bonus, only profits withdrawable. [Bitget support — primary]

**Sybil defense:**
- One per **verified identity**, not per email. [Stripe] Mature checklist dedupes on individual / household / address / email / device / IP / bank / phone. [Ignition T&Cs]
- **On-chain clustering** is the crypto-native lever: funding-source + gas + transfer graphs, **Louvain community detection**, four farm topologies (star-divergence / star-convergence / tree / chain), flag groups >20 / same-source / same CEX-deposit. [Trusta Labs, Arbitrum, Beosin — primary repos]
- **~24% sybil rate** observed (Hop: 10,253 / 43,058) — expect heavy farming; Hop's **conservative false-positive** stance → flag for review, don't auto-block.
- **Deposit-first / progressive friction** (release credit only after a real purchase) is the cross-industry recommendation [Stripe, Yogonet] — *advised, not measured.*

**Do NOT cite (failed verification):** per-bonus-type wagering bands (no-deposit 40–70× etc.); a "1×–30× typical" range; an iGaming CAC of $250–$650; the blanket "multi-accounting is THE primary attack vector."

**Caveats:** casino figures are industry norms (mostly secondary sources), not regulatory limits; Bitget is the operator's own docs (mechanics, not independent); deposit-first efficacy is advised not measured; on-chain clustering evidence is from one-time airdrop snapshots, not live real-time gating.

**Open questions:** no verified public post-mortem of a crypto trading-bonus being farmed; exact perp-DEX profit-unlock thresholds undocumented; relative cost/effectiveness ranking of each sybil layer for a *live* program unquantified; deposit-first abuse reduction unmeasured.

**Sources (primary → secondary):** Bitget support (primary); TrustaLabs, Arbitrum Foundation, Hop airdrop repos (primary); Beosin; Stripe; acgcs.org; next.io; sportsline; gamblingnerd; Yogonet; Sumsub. Full list + per-claim 3-vote results in the research transcript.
