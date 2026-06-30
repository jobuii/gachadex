# Free Signup Credit — Spec

**Status:** DRAFT / investigation → spec. Not built. Flag-gated when built.
**Author:** design session 2026-06-30.
**One-liner:** Give new accounts a configurable amount of **free, tradeable, non-withdrawable** USDC credit, with loss-prevention so we never give away the principal and bound the cost of withdrawable winnings.

---

## 0. The framing you must internalise first

On a real-money venue the **principal being non-withdrawable is the easy 10%**. The expensive 90%:

1. **Winnings made with free credit are real, withdrawable money.** A user who turns $50 of credit into $90 has $40 of real, cashable profit.
2. **On this platform that profit is paid out of the LP pool.** Trading PnL settles `+USER_COLLATERAL / −LP_POOL` (`engine.ts`, reason `REALIZED_PNL`). So a free-credit winner is literally paid by your liquidity providers unless the program is funded separately.
3. **Solvency.** The codebase already refuses to boot in real-funds mode if the play-money `FAUCET_SOURCE` carries any balance ("must never become withdrawable as real USDC", `db/init.ts`). Translation: *unbacked credit that can become withdrawable is forbidden.* **DECIDED (§9.2): fund from the LP pool** — its existing real USDC backs every grant + any winnings, so no separate pre-funded account is needed and solvency/PoR stays intact. The cost lands on LP providers; a program cap (`signup_credit_program_budget_usd`) bounds total LP drain.
4. **Account creation is ≈ free and permissionless** (an account is just a Solana wallet — see §5). So "free money per account" is, by construction, an abuse magnet you *contain*, not *close*.

This spec therefore has two halves: the **money mechanism** (clean, low blast-radius) and the **anti-sybil stack** (the hard part).

---

## 1. How it fits the code (clean insertion)

- **One spendable balance** — `USER_COLLATERAL`. Deposits, faucet, referral, and trading PnL all land there and are fungible (`ledger.ts`, `getUserBalances` in `faucet.ts`). Trading "just works" if credit sits here — no engine changes.
- **One withdrawal chokepoint** — `requestWithdrawal` (`services/custody/withdrawals.ts:171`): `available = balance(USER_COLLATERAL); if (available < amount) throw 'insufficient balance'`. Today it's the *full* balance. Non-withdrawable credit = change that one read to a `withdrawableBalance(...)` helper.
- **Money is classified by ledger `reason`** (`EXTERNAL_CAPITAL_REASONS` in `leaderboard.ts:11`; `TXN_TYPE` in `history.ts`). A new reason `SIGNUP_CREDIT` slots straight in — no separate account for the credit itself.
- **Funding = LP_POOL (DECIDED).** No new budget account — the grant is drawn from the existing `LP_POOL` system account (which already pays/receives trading PnL), so the LP pool's real USDC backs it. A `signup_credit_program_budget_usd` knob caps cumulative LP drain.

---

## 2. The money mechanism

> **This model exists in the wild — Bitget's "Futures Trading Bonus" is the near-exact analog** (validated, primary source): the bonus serves as **margin to open positions and offsets fees/funding/losses up to the bonus amount, but the principal can never be withdrawn**, and *any withdrawal or transfer from the account voids the unused bonus* — **only profits earned trading the bonus are withdrawable.** Our floor model (§2.2) is a more granular version of the same idea; "any withdraw voids unused bonus" is a cruder fallback option if the floor proves fiddly.

### 2.1 Grant
At the qualifying moment (see §5 for *when* — signup vs deposit-gated), post one balanced txn:

```
reason: 'SIGNUP_CREDIT'
+ USER_COLLATERAL  (user)      +grantE6
− LP_POOL          (system)    −grantE6
```

**Funding = the LP pool (DECIDED, §9.2).** The grant comes straight out of `LP_POOL` — the same account that already pays trading PnL — so no separate pre-funded budget account is needed and the LP pool's existing real USDC backs it (solvency stays intact). Implication recorded in §9.2: the LP providers bear the program's cost. **Bound it with a program cap** `signup_credit_program_budget_usd` (max cumulative outstanding credit drawn from LP) — once hit, grants pause. Reuse `creditCapped`-style clamp logic. Record the grant per user (`signup_credits` row, or `Σ SIGNUP_CREDIT` by reason). **Add `SIGNUP_CREDIT` to `EXTERNAL_CAPITAL_REASONS` and `TXN_TYPE`** — else the leaderboard miscounts the grant as trading PnL (warning at `leaderboard.ts:10`).

### 2.2 The non-withdrawable floor (the whole trick)
Enforced at the one chokepoint:

```
remainingCredit = min(grantTotal, collateral)      // the still-present credit
floorWithdrawable = max(0, collateral − remainingCredit)
                  = max(0, collateral − grantTotal)
```

- **No deposit, $50 credit:** trade to $90 → withdrawable `90−50 = $40` (true winnings). Lose to $30 → `remaining = 30`, withdrawable `$0` (credit absorbed the loss). **The $50 principal never leaves, ever.**
- **$100 deposit on top of $50 credit:** withdrawable = `max(0, collateral − 50)` = deposit + net winnings; the $50 stays locked.

### 2.3 Wagering gate (layered ON TOP of the floor)
Winnings derived from the bonus do not withdraw until the account has:
- **deposited ≥ $50 real USDC** (the deposit must *clear first*), **and**
- **traded ≥ $1,000 volume after the deposit cleared.**

> **Calibration (research):** turnover is universally `multiple × bonus`. $1,000 on a $50 grant = **20× turnover** — *conservative/player-friendly*; the industry band is ~20×–50× (avg ~35×), and **>40× is the aggressive ceiling** that reads as predatory. 20× is a fine launch value with headroom to raise toward 30–40× if abuse runs hot. Keep it a knob. (Do NOT cite per-bonus-type bands like "no-deposit 40–70×" — that claim failed verification; see Appendix A.)

> **Definitional pin (important):** collateral is one fungible pool, so you cannot cleanly tag a trade's notional as "real-money" vs "bonus" volume. The implementable interpretation of "bonus volume doesn't count" is: **count only volume traded after the qualifying $50 deposit has cleared.** Same spirit, actually buildable. (Pure lot-tracking of bonus-vs-deposit dollars is possible but high-complexity; not recommended for v1.)

### 2.4 Precise withdrawable rule (pin these edges before coding)
A depositor's **own deposit is always withdrawable** (it's their money); only **bonus-derived winnings** are gated. So:

```
ownNetDeposits = Σ(DEPOSIT) − Σ(WITHDRAWAL) − Σ(WITHDRAWAL_REVERSAL inverse) ...   // their real capital in
bonusWinnings  = max(0, collateral − grantTotal − ownNetDeposits)                  // profit beyond grant+deposits
withdrawable   = ownNetDeposits_available + (wageringMet ? bonusWinnings : 0)
```
clamped to `≥ 0` and `≤ collateral`, and never below the credit floor. The exact formula is the single place the loss-absorption policy lives — write it as one tested helper `withdrawableBalance(q, userId)` shared by `requestWithdrawal`, the UI "max withdrawable", and `treasury.ts` liability math.

> **Research validates this loss-ordering.** The floor model spends the user's *withdrawable* money (deposit + winnings) down first and only erodes the credit floor once collateral drops below the grant — i.e. **"cash-before-bonus"**, which is exactly the standard casino rule ("the casino first uses up our cash balance; it only uses the bonus balance once cash is gone"). So no custom policy invention needed — we match mature practice.

### 2.5 Expiry
Credit expires **7 days after the last trade** (dormant = no trade in the window). On expiry, claw the **remaining** credit back:
```
reason: 'SIGNUP_CREDIT_EXPIRE'
− USER_COLLATERAL  remainingCredit
+ LP_POOL          remainingCredit
```
Only the unspent floor (`min(grant, collateral)`) is clawed; winnings above it are untouched. A background sweep (like the gacha reconcilers) handles expiry.

### 2.6 Max-cashout cap on bonus winnings (ADDED from research — biggest single loss-bound)
The casino/sportsbook playbook **caps how much of the bonus-derived winnings can ever be withdrawn** — commonly ~$100 for a free/no-deposit bonus (next.io, WizardofOdds). This is the single cleanest bound on per-account house loss. Knob `signup_credit_max_cashout_usd`, **fully operator-set across the whole range $0 → unlimited:**
- **`0`** = *no* bonus-derived winnings are ever withdrawable — the credit is a pure trading demo (house cost ≈ just the LP variance + fees foregone; near-zero giveaway).
- **a positive $ cap** (e.g. $100–$250 conservative) = a credit-origin account's lifetime *bonus-derived* withdrawals are capped at that; anything above stays locked / is clawed.
- **unlimited** (a sentinel, e.g. blank / −1) = no cap (full giveaway).

Only the **bonus-funded upside** is capped — the user's own deposits + winnings on their own deposited capital are never capped. This turns the per-account worst case from "unbounded leveraged upside" into a number you choose.

### 2.7 Bonus-active trading caps (ADDED from research — operator-adjustable, DEFAULT = no restriction)
Casinos cap **max bet per round ($5–$10)** while a bonus is in play, to stop someone converting a small bonus into a huge swing. The perp analogue is **optional** caps on **leverage**, **max position notional ("max bet")**, applied only while an account holds unspent credit (`remainingCredit > 0`) and hasn't met wagering. **These are operator knobs and DEFAULT to OFF / unlimited** — out of the box a credit account trades exactly like a normal account (full leverage + size). The operator can tighten them later from the Perks page if abuse appears. Knobs (all default unlimited): `signup_credit_max_leverage`, `signup_credit_max_position_usd`.

---

## 3. Anti-sybil stack (the hard part — see §5 for why it's necessary)

> **BUILD STATUS: NOT YET. None of §3 ships in Phase 1.** This whole section is design documentation, deferred to **Phase 2+** (see §10). Phase 1 only lays the money plumbing + the *manual-review hold* hook (§3d, which reuses existing withdrawal approval). The automated gates — captcha/SMS, on-chain clustering, velocity caps — are documented here so the design is complete, but are explicitly out of scope until the program is actually turned on. The plain-English walkthrough of how the clustering works is in **§3.2**.

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
- **d. Manual-review hold on the FIRST withdrawal from any credit-origin account.** Reuse the existing manual path: the `withdrawal_auto_process` knob, the daily cap, and the PoR freeze already exist. **Route credit-origin first-withdrawals to manual** (don't auto-approve). Real USDC doesn't leave until a heuristic/human clears it, with the cluster signal from (b) in view.
- **e. Backstops that bound the blast radius:**
  - **Program budget cap** (`signup_credit_program_budget_usd`, the max cumulative LP drain) — the hard ceiling on total exposure regardless of everything else.
  - **Low leverage + position-size cap on bonus money** — smaller winners, less to chase.
  - **Anomaly detection** on the signature: signup → bonus → high-lev trade → deposit-exactly-$50 → churn-exactly-$1k → withdraw. (Precedent: referral bonuses already pay only the "first N" referrers — an anti-farming cap.)

### 3.1 Velocity alarm — REWORKED from the original "freeze signups at 50/day"
> **Do NOT globally freeze account creation.** That is a self-inflicted DoS: any anonymous person spins up 51 throwaway wallets (free, minutes) and freezes signup for *all* real users until an admin unfreezes — and it doesn't even stop the bot (its accounts were already created; it can spread across days/IPs). Accounts without a grant are harmless.

Instead:
- **Velocity spike → auto-pause GRANT issuance** (people can still sign up; the free money pauses) + **admin alert** on the Perks page.
- **Per-signal, not one global counter** — per IP/subnet/fingerprint/funding-cluster, so a farm trips only its own limit.
- The **program budget cap** (`signup_credit_program_budget_usd`) is the real hard stop.

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
  - `signup_credit_usd` **live knob** (like the chat/gacha config knobs) + **on/off flag** + **program-budget / cumulative-LP-drain readout** (set amount to 0 / off ⇒ dormant).
  - Wagering thresholds (deposit min, volume min ≈ turnover ×), **max-cashout cap** (§2.6), **bonus-active leverage + position caps** (§2.7), expiry window, velocity thresholds — all knobs.
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
| Grant | `+USER_COLLATERAL / −LP_POOL` (`SIGNUP_CREDIT`) — LP-funded |
| Trade win | `+USER_COLLATERAL / −LP_POOL` (`REALIZED_PNL`, unchanged) |
| Trade loss | `−USER_COLLATERAL / +LP_POOL` (`REALIZED_PNL`, unchanged) — eats the floor first while no deposit |
| Withdrawal | `−USER_COLLATERAL / +TREASURY_USDC` (`WITHDRAWAL`, unchanged) — **capped by `withdrawableBalance()`** |
| Expiry claw-back | `−USER_COLLATERAL / +LP_POOL` (`SIGNUP_CREDIT_EXPIRE`) — returns to LP |

Reason-list updates required: `EXTERNAL_CAPITAL_REASONS` (`leaderboard.ts`) and `TXN_TYPE` (`history.ts`) must include `SIGNUP_CREDIT` (+ the expire reason).

---

## 7. Schema / config

- **No new account type** — the grant is drawn from the existing `LP_POOL` (DECIDED, §9.2).
- **`signup_credits`** table (or reason-derived): `user_id`, `granted_e6`, `granted_at`, `last_trade_at`, `wagering_met_at`, `expired_at`, `cluster_id`/funding-source, `first_withdrawal_reviewed`, `bonus_cashout_paid_e6` (running total of bonus-derived withdrawals, for the §2.6 cap).
- **Knobs (liveKnob pattern):** `signup_credit_enabled` (bool), `signup_credit_usd` (grant amount), `signup_credit_program_budget_usd` (max cumulative LP drain; grants pause when hit), `signup_credit_wager_deposit_usd` (50), `signup_credit_wager_volume_usd` (1000 ≈ 20× turnover; defensible up to ~40×), `signup_credit_expiry_days` (7), `signup_credit_max_cashout_usd` (§2.6 — **$0 → unlimited**, operator-set), `signup_credit_max_leverage` + `signup_credit_max_position_usd` (§2.7 — **default unlimited / no restriction**), grant velocity thresholds.
- **Solvency:** because grants come from `LP_POOL` (real USDC), they create **no unbacked liability** (unlike the faucet) — PoR stays intact. The only invariant: `LP_POOL` must not be driven negative, and the program cap (`signup_credit_program_budget_usd`) bounds the drain. (Distinct from the faucet's `db/init.ts` ban, which exists precisely because faucet credit is *un*backed.)

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
2. **Who funds the cost — DECIDED: the LP pool.** Grants + winnings are drawn from `LP_POOL` (no separate operator budget); the LP pool's real USDC backs it. **Recorded caveat:** this means **LP providers subsidise the bonuses** — it dilutes LP yield, so it must be (a) bounded by `signup_credit_program_budget_usd`, and (b) disclosed to LPs (pool page / docs), or LPs may pull liquidity. Mitigation is the cap + transparency, not a different funding source.
3. **Which §3 gates ship first** (still open) — at minimum (a) one per-account cost gate + (d) manual hold + (e) capped budget. (b) on-chain clustering is the highest-leverage add.

---

## 10. Phasing

- **Phase 1 (dark, flag-gated `signup_credit_enabled=false`):** ledger plumbing (`SIGNUP_CREDIT` from `LP_POOL`, reason-list updates, program-budget cap), the `withdrawableBalance()` floor + wagering at the chokepoint, the two customers columns, the `signup_credit_usd` knob + LP-drain/budget readout, the Perks page skeleton with the manual-review queue, and credit-origin first-withdrawal → manual. Grant trigger is config (deposit-gated vs at-signup). No real grants until flipped on.
- **Phase 2:** the sybil gates — Turnstile/SMS at grant, on-chain clustering in the review queue, per-signal grant velocity caps + auto-pause.
- **Phase 3:** anomaly detection, expiry sweep tuning, analytics on program EV (cost vs retained-deposit value).

---

## 11. Test plan (high level)

- Floor math: no-deposit grant — win → withdrawable = winnings; lose → withdrawable 0; principal never withdrawable. Deposit + grant — own deposit withdrawable, bonus winnings gated until wagering met.
- Wagering: deposit must clear first; volume counted only post-deposit; not-met blocks bonus winnings, met releases them.
- Expiry: dormant 7d claws back remaining only, not winnings; a trade resets the clock.
- Budget: grant clamped/blocked when the program budget cap is reached (or `LP_POOL` would go negative); never creates unbacked liability.
- Sybil: credit-origin first-withdrawal does NOT auto-approve; velocity spike pauses grants (not signups); per-cluster cap blocks the Nth grant in a cluster.
- Solvency: `withdrawableBalance` is consistent with `treasury.ts` PoR liability; `db/init.ts` invariant holds.

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
