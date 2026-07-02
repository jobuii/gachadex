# Bonus Credits — Spec (v2: two sources on one shared protection layer)

**Status: BUILT (2026-07-02) — dark behind the per-source `*_bonus_enabled` toggles + $0 amounts; local branch
`feat/bonus-credits-v2`, not pushed. All decisions D1–D5 implemented.** This generalises the dark, Phase-1
"free signup credit"
(built + merged to local master, never enabled — see [`signup-credit-spec.md`](signup-credit-spec.md)) into a
**bonus-credits** subsystem with **two independent bonus sources** that both plug into **one shared set of
protection hooks**. Nothing is live; the existing feature has issued zero grants, so this is a clean refactor
with a zero-row migration.

---

## 0. The shape (what the operator asked for)

- **Two bonus sources, each independently toggleable, each with its own amount:**
  - **Signup bonus** — a **flat $ amount**, granted **once, when a new account is created**. New accounts only.
  - **Deposit bonus** — a **percentage of a deposit**, granted when the customer deposits.
- **One shared protection layer** both sources hook into (not duplicated per source): non-withdrawable floor,
  wagering gate (min deposit + min trade volume before winnings withdraw), dormancy expiry, first-withdrawal
  manual review, and CREDIT_BUDGET funding + hard cap.
- **One shared velocity guard**: if more than N new accounts are created in 24h, **both** sources stop issuing
  and the admin is flagged; the admin re-enables **one or both** when they choose.

---

## 1. Architecture — a shared "bonus engine" + pluggable "sources" (the hooks)

The core idea (and the thing that makes "both share the same protections" true rather than copy-pasted):

```
        SOURCES (triggers)                    THE SHARED ENGINE (one code path)
  ┌───────────────────────────┐        ┌──────────────────────────────────────────┐
  │ signup source             │        │ issueBonus(userId, type, amountE6):        │
  │  hook: account creation   ├──────► │   1. source enabled?  (per-type toggle)    │
  │  amount: flat $           │        │   2. velocity frozen for this type? → stop │
  ├───────────────────────────┤        │   3. debit CREDIT_BUDGET (row-locked,      │
  │ deposit source            │        │      clamped to funded balance) → user     │
  │  hook: deposit credited   ├──────► │   4. record a bonus_grants row (type,$,at)  │
  │  amount: % of deposit     │        │   5. ledger reason tags the source          │
  └───────────────────────────┘        └───────────────────┬────────────────────────┘
                                                            │  all downstream protections
                                                            ▼  read the AGGREGATE bonus principal
        ┌───────────────────────────────────────────────────────────────────────────┐
        │ SHARED PROTECTION HOOKS (unchanged logic, now source-agnostic):            │
        │  • non-withdrawable floor at the ONE withdrawal chokepoint                  │
        │  • wagering gate: net deposits ≥ min AND post-deposit volume ≥ min          │
        │  • dormancy expiry: claw unused bonus after N days                          │
        │  • first-withdrawal manual-review hold                                      │
        │  • velocity freeze (feeds back into step 2 above)                           │
        │  • CREDIT_BUDGET funded from FEE_REVENUE = the hard cap                     │
        └───────────────────────────────────────────────────────────────────────────┘
```

**`issueBonus(db, userId, type, amountE6)` is THE hook.** Every source computes an amount and calls it; the
engine owns budget, velocity, idempotency, and the grant record. A source never touches money directly. Adding
a third source later (e.g. a referral bonus) is one new trigger + one `issueBonus` call — the protections come
for free.

This replaces today's single `grantSignupCredit(db, userId)` (which hard-codes the flat signup amount and the
deposit trigger) with the generic engine + two thin sources.

---

## 2. The two sources

### 2.1 Signup source (NEW)
- **Trigger:** account creation. `auth.ts:upsertUser` already inserts with `... ON CONFLICT(solana_pubkey) DO
  NOTHING RETURNING id`, so `RETURNING` yields a row **only for a genuinely new account**. That branch (`if
  (ins.rows[0])`, right where the referral code is assigned) is the exact, correct hook — existing customers hit
  the conflict path and are never granted. This is what makes it "new accounts from now on" automatically.
- **Amount:** flat `signup_bonus_usd` (operator-set $).
- **Once per account:** enforced by the engine (one signup-type `bonus_grants` row per user).
- **Note:** the grant lands before any deposit. The floor already handles this — with zero deposits,
  `withdrawable = min(collateral − grant, netDeposits=0) = 0`, so a signup-only user can *trade* the bonus but
  can withdraw nothing until they deposit and clear wagering. No new money logic needed.

### 2.2 Deposit source (CHANGED: flat $ → % of deposit)
- **Trigger:** `deposits.ts:creditDeposit` (where today's flat grant fires). Keep it here.
- **Amount:** `deposit_bonus_pct` × the deposited amount, capped by `deposit_bonus_max_usd` ($ ceiling per
  grant). Example: 10% of a $200 deposit = $20; with a $100 cap, a $2,000 deposit still only bonuses $100.
- **Scope (DECIDED, D1):** **first deposit only** — one deposit-bonus grant per account (a standard
  "first-deposit match"). Enforced by the engine (one deposit-type `bonus_grants` row per user).

Both sources are **independent (DECIDED, D2 = yes, they stack)**: a brand-new customer who then deposits can
receive **both** (signup + deposit), each toggled separately. The aggregate is bounded by the wagering gate,
dormancy claw-back, velocity pause, and the CREDIT_BUDGET cap.

---

## 3. Shared protection hooks (what each source inherits)

All of these already exist for the single signup credit; the only change is they read the **aggregate** bonus
principal (sum across both sources) instead of a single grant. The floor/wagering are **ledger-derived**, so
broadening the set of "bonus" reasons is all that's required — the math is unchanged.

1. **Non-withdrawable floor** (`floorWithdrawable`, enforced at the one chokepoint `custody/withdrawals.ts`):
   `withdrawable = wageringMet ? max(0, C − G) : min(max(0, C − G), netDeposits)`, where **G = total outstanding
   bonus principal** (Σ all bonus grants − Σ all bonus claws). Unchanged except G now spans both sources.
2. **Wagering gate** (`creditState`): winnings withdraw only after **net deposits ≥ `bonus_wager_deposit_usd`**
   AND **post-first-deposit volume ≥ `bonus_wager_volume_usd`**. Shared, unchanged. (Applies to signup-only users
   too: they must deposit ≥ the min and trade the volume before any winnings leave.)
3. **Dormancy expiry** (`expireBonuses`, was `expireSignupCredits`): claw a bonus grant back to CREDIT_BUDGET
   when it is **older than `bonus_expiry_days` AND the account has no fills in that window**. Per-grant rows,
   swept oldest-first; margin-safe (claw only `min(remaining, free collateral)`, mark a row expired only when
   its residual is fully clawed). Active traders keep all their bonuses; a no-show's unused bonus is reclaimed
   (this is what keeps a *signup* bonus cheap — no-shows self-reclaim).
4. **First-withdrawal manual review** (`needsFirstWithdrawalReview` + `willAutoApprove`/`processAllRequested`):
   a **credit-origin account** (has any bonus grant) has its **first** withdrawal held for manual review
   regardless of the auto-approve toggle. Shared, unchanged (just keys off "any bonus grant," not "signup grant").
5. **CREDIT_BUDGET** funded from FEE_REVENUE via the admin transfer; `issueBonus` row-locks + clamps to the
   funded balance, so **total principal issued (both sources) ≤ the funded budget** — the hard cap. Shared.

---

## 4. Velocity guard — shared; a trip PAUSES both by turning the toggles OFF; admin re-enables via the toggles (DECIDED, D4)

- **Signal:** new accounts created in the last 24h (one platform-wide count, `users.created_at`).
- **Trip:** count > `bonus_daily_account_cap` (default 50) → **turn BOTH source toggles off**
  (`signup_bonus_enabled = false` AND `deposit_bonus_enabled = false`) → flag the admin on the Perks page. So
  "paused" == the enable toggles are switched off, exactly as if the admin had flipped them.
- **Admin re-enables via those same Perks toggles** — one or both, whenever they choose. There is **no separate
  freeze latch**: the enable toggle *is* the on/off state (this is what D4 asked for).
- **Edge-triggered so it never fights the admin.** An internal `bonus_velocity_tripped` flag records that we've
  already acted on the current breach: the guard turns the toggles off **once per breach episode** (when the
  count crosses `≤cap → >cap`) and re-arms only after the count falls back to `≤cap`. So once the admin flips a
  toggle back on, it **stays on** even while the count is still over the cap — the pause does not re-fire until
  a *new* breach. *(This supersedes Phase-1's re-latch-every-pass, which would have fought the manual re-enable.)*
- **Admin visibility:** while `bonus_velocity_tripped` is set, the Perks page shows a red
  *"Auto-paused by velocity — N new accounts in 24h exceeded the cap of C; re-enable below when ready"* banner,
  so an off toggle is never mistaken for a manual choice.
- Signups themselves are **never** blocked; only issuance pauses. CREDIT_BUDGET remains the ultimate cap.

---

## 5. Data model

Generalise `signup_credits` → **`bonus_grants`** (one row per grant; a user can have a signup row + a deposit
row, or — under "every deposit" scope — several deposit rows):

```
bonus_grants
  id            TEXT PK
  user_id       TEXT NOT NULL REFERENCES users(id)
  type          TEXT NOT NULL          -- 'signup' | 'deposit'
  granted_e6    BIGINT NOT NULL        -- original grant (the admin "issued" figure)
  clawed_e6     BIGINT NOT NULL DEFAULT 0  -- Σ dormancy claw-backs against THIS grant (remaining = granted − clawed)
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now()  -- dormancy age anchor for this grant
  ref_deposit   TEXT                   -- the triggering deposit id (deposit-type only; audit + idempotency)
  expired_at    TIMESTAMPTZ            -- set when this grant's residual is fully clawed
  UNIQUE (user_id, type)               -- one signup bonus AND one (first-deposit) deposit bonus per account
```

- **First-withdrawal review flag** is **per-account**, not per-grant. Move it to a tiny `bonus_accounts`
  (`user_id PK, first_withdrawal_reviewed BOOL`) row created on the first grant — or keep it derivable. (Minor;
  either works. Recommended: `bonus_accounts` for a clean per-account flag.)
- **Migration:** `signup_credits` has **zero rows** (feature never enabled), so we create `bonus_grants` fresh
  and drop `signup_credits`. No data movement, no backfill.

---

## 6. Ledger reasons

Today: `SIGNUP_CREDIT` / `SIGNUP_CREDIT_EXPIRE`. Proposed (clean, source-tagged; zero-data rename):

- `SIGNUP_BONUS` — signup grant (CREDIT_BUDGET → USER_COLLATERAL)
- `DEPOSIT_BONUS` — deposit-% grant (CREDIT_BUDGET → USER_COLLATERAL)
- `BONUS_EXPIRE` — dormancy claw-back (USER_COLLATERAL → CREDIT_BUDGET), either source
- `CREDIT_BUDGET_FUND` — FEE_REVENUE → CREDIT_BUDGET (unchanged)

The floor/wagering sum **{SIGNUP_BONUS, DEPOSIT_BONUS} − {BONUS_EXPIRE}** for G. Add all three to
`EXTERNAL_CAPITAL_REASONS` (`leaderboard.ts`) and `TXN_TYPE` (`history.ts`) — same one-line edits as today.

---

## 7. Config knobs (all `liveKnob`, admin-tunable, no redeploy)

**Shared protections:**
| Knob | Default | Meaning |
|---|---|---|
| `bonus_wager_deposit_usd` | 50 | min net deposit before winnings withdraw |
| `bonus_wager_volume_usd` | 1000 | min post-deposit trade volume before winnings withdraw |
| `bonus_expiry_days` | 7 | dormancy window (unused → clawed back) |
| `bonus_daily_account_cap` | 50 | velocity: >this many new accounts/24h pauses both sources |
| `bonus_velocity_tripped` | false | internal edge-trigger flag (§4); not an operator control |

**Signup source:**
| Knob | Default | Meaning |
|---|---|---|
| `signup_bonus_enabled` | **false** | master toggle (also the velocity re-enable control) |
| `signup_bonus_usd` | **0** | flat $ per new account — **0 ⇒ issues nothing even if enabled** |

**Deposit source:**
| Knob | Default | Meaning |
|---|---|---|
| `deposit_bonus_enabled` | **false** | master toggle (also the velocity re-enable control) |
| `deposit_bonus_pct` | **0** | % of the first deposit — **0 ⇒ issues nothing even if enabled** |
| `deposit_bonus_max_usd` | **0** | $ ceiling per grant — **0 ⇒ no bonus** (operator must set a cap to issue) |

**D3 (DECIDED):** both amounts default to **0** so nothing can be issued until the operator deliberately sets a
figure — a second safety on top of the toggle. Admin inputs on the Perks page: **signup = a $ figure**;
**deposit = a % figure + a $ cap figure**. (A flat signup bonus needs no cap — the $ figure *is* the amount.)
Because `deposit_bonus_max_usd` defaults to 0 = "no bonus", the deposit source only pays once the operator sets
**both** a % and a $ cap — you cannot accidentally ship an uncapped % match.

(Existing Phase-1 knobs `signup_credit_*` are renamed/replaced; no live overrides exist to migrate.)

---

## 8. Decisions — all RESOLVED (2026-07-02)

- **D1 — Deposit-bonus scope: DECIDED = first deposit only, with the $ cap.** One deposit-bonus grant per account.
- **D2 — Both bonuses stack: DECIDED = yes.** If both toggles are on, a new signup who deposits gets both; each
  is independently toggled and the shared caps bound the total.
- **D3 — Amounts default to 0: DECIDED.** Operator sets signup = $ figure; deposit = % + $ cap. Nothing issues
  until set (belt-and-braces with the toggles). See §7.
- **D4 — Velocity: DECIDED = pause both by switching the toggles OFF; admin re-enables via the toggles.**
  Edge-triggered so a manual re-enable is not immediately overridden (§4).
- **D5 — Bonus principal stays LOCKED FOREVER: DECIDED.** Meeting the standards (min deposit + min volume)
  unlocks only the *winnings on top*; the free bonus itself is never withdrawable. No change to the §3 floor
  (G is always subtracted). "Withdraw" for a bonus user always means their own deposit back + net winnings,
  gated by the wagering standards — never the bonus principal.

---

## 9. Admin surface (Perks page)

- **Two panels — "Signup bonus" and "Deposit bonus"** — each: **enable toggle** (this is also the velocity
  re-enable control) + amount (signup = $ figure; deposit = % + $ cap) + a ● LIVE / ○ dark indicator.
- **Shared "Protections" panel:** wager deposit, wager volume, expiry days, daily account cap.
- **Shared "Budget" panel:** CREDIT_BUDGET balance, FEE_REVENUE available, Fund control.
- **Velocity status:** live "New accounts (24h): n / cap" card (red when over); when `bonus_velocity_tripped`,
  a red **"Auto-paused by velocity — re-enable the toggles above when ready"** banner explains why both toggles
  went off (see §4).
- **First-withdrawal review queue:** unchanged (now any-bonus-origin).
- **Customers tab:** Free Credit (total issued to the user) + Remaining (still-locked) columns — as today, now
  aggregate across both sources (optional per-type tooltip). Overview "Total bonuses issued" split signup vs
  deposit.

---

## 10. Phasing / test-plan delta

- **This is one build** (a refactor + one new source), still shipping **dark** behind the two `*_enabled`
  toggles. Sequence: engine (`issueBonus` + `bonus_grants` + reasons) → repoint the deposit source to %-of-
  deposit → add the signup source at `upsertUser` → generalise the shared hooks to the aggregate → velocity
  edge-trigger + per-type latches → admin surface → docs.
- **New/changed tests:** signup-source grant at account creation (new accounts only; existing accounts never);
  deposit-% math + cap + scope; both-stack aggregate floor/wagering; dormancy per-grant claw across two grants;
  velocity freezes both + per-type unfreeze + edge-trigger re-arm; budget clamp across both sources; the M1–M7
  QA scenarios re-run against the generalised engine.
- **Money-safety review** (adversarial, as before) before "done."

## 11. Explicitly NOT changing

The custodial ledger, the withdrawal chokepoint's single-authority floor formula, PoR (bonus stays a full
liability — never subtracted from `|TREASURY_USDC|`), the manual-review path, and the CREDIT_BUDGET =
FEE_REVENUE funding model. Anti-sybil clustering (captcha/SMS/on-chain graph) remains Phase 2+.
