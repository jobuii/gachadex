# Affiliate / KOL Referral Economics — Spec

**Status:** decisions LOCKED (2026-06-20). Awaiting user approval to build. Build target: the
**`development`** worktree (catch it up to `master` first — it's behind).

**Goal.** Admin-managed referral codes for KOLs / streamers / affiliates, each with two configurable
knobs, linked to a wallet:

- **`fee_discount_bps`** — the code-owner's own trading-fee discount (e.g. 50% off their fees).
- **`cashback_bps`** — the % of their referees' trading fees paid back to the code-owner (e.g. 35%).

Worked example: cashback 35% + discount 50% → the affiliate trades at half fees, and 35% of the fees
paid by anyone who signed up under their code flows to the affiliate as real, withdrawable USDC.

---

## What already exists (foundation — reuse, don't rebuild)

**Referral system** (`apps/api/src/services/referral.ts`, `routes/social.ts`, `web/ReferralPanel.jsx`)
- `users.referral_code` (auto `POKE-XXXXX`, or custom 4–20 chars), `users.referred_by` (referee→referrer,
  set ONCE via `redeemReferral`), `referral_code_aliases` (renamed-code reservations / anti-hijack).
- Routes: `GET /referral/me`, `POST /referral/redeem`, `POST /referral/code`.
- The existing reward is a **play-money signup bonus** (`creditCapped` from `FAUCET_SOURCE`, gated on
  `!config.realFunds`). **In real-funds mode (the live site) this bonus is INACTIVE** — so KOL codes'
  only economics are the discount + cashback below (resolves the "signup-bonus coexistence" question).

**Accounts / identity** (`schema.sql` users, `services/auth.ts`)
- `users(id UUID, solana_pubkey UNIQUE, …)`. Auth = Sign-In-With-Solana → `req.userId`/`req.pubkey`.
- `upsertUser(db, pubkey)` creates an account for a wallet — reusable to pre-provision a KOL by wallet.

**Fees + ledger** (`apps/api/src/services/engine.ts`, `fees.ts`, `ledger.ts`, `money.ts`)
- `getFeeBps()` live knob (settings `trading_fee_bps`); `fee(notional, bps) = notional*bps/10000`.
- **`chargeFee(q, userId, feeAmt, reason, refId)`** (`engine.ts:18-36`): deducts `feeAmt` from the trader's
  `USER_COLLATERAL`, splits `LP_POOL` (`feeLpSharePct`%) + `FEE_REVENUE` (rest) in one `postTxn`.
- Charged on **OPEN_FEE** (`engine.ts:408`, computed `:364`) and **CLOSE_FEE** (`:522`, computed `:493`).
- `fills.fee_uusdc` per fill. Money = micro-USDC bigint (1 USDC = 1e6).
- Double-entry: `accounts` / `ledger_entries` (each txn_id sums to 0) / `balances`; system accounts
  `FEE_REVENUE`, `LP_POOL`. `/account/balance` returns equity/available/unrealizedPnl (`routes/account.ts`).

**Admin** (`routes/admin.ts`+`admin-ops.ts`, `services/live-knob.ts`, `web/AdminPanel.jsx`)
- `requireAdminKey` (timing-safe `x-admin-key`). Live-knob = settings-backed, memory-cached scalar.
  Per-entity precedent = custody limits (`settings` keyed `custody_limit:<k>`). AdminPanel tabs
  (Main/Customers/Chat/Games), `/admin/fee` get+set, `/admin/customers` list+drill-down.

---

## Data model

```sql
CREATE TABLE affiliate_terms (
  user_id          TEXT PRIMARY KEY REFERENCES users(id),
  cashback_bps     INT  NOT NULL DEFAULT 0,   -- % of referees' fees → this affiliate
  fee_discount_bps INT  NOT NULL DEFAULT 0,   -- this affiliate's own fee discount
  label            TEXT,                       -- admin note ("Streamer X")
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Affiliate's **code** = their `users.referral_code` (admin may assign a branded one via the existing
custom-code + alias path). Attribution = the existing `users.referred_by`.

**Validation bounds:** `fee_discount_bps` ∈ [0, 10000] (≤100%). `cashback_bps` ∈ [0, 10000 −
feeLpSharePct·100] so the house share never underflows (see Mechanism 3 guard) — rejected at set-time
if it would violate that.

---

## Mechanism 1 — link a code to a wallet (admin)

`POST /admin/affiliates { pubkey, code, cashbackBps, feeDiscountBps, label }`:
1. `upsertUser(pubkey)` → `userId` (creates the account if the KOL never signed in).
2. Set their `referral_code = code` (reuse the unique-code + alias mechanism).
3. Upsert `affiliate_terms` (validated).

`GET /admin/affiliates` → list (code, wallet, %s, #referrals, cashback paid, active). `PATCH`/deactivate
to edit. All behind `requireAdminKey`.

---

## Mechanism 2 — the affiliate's own fee discount

At trade time (`engine.ts` open `:364` / close `:493`):

```ts
const grossFee = fee(notion, getFeeBps());
const discBps  = affiliateDiscountBps(userId);          // 0 if not an affiliate
const netFee   = grossFee - (grossFee * BigInt(discBps)) / 10000n;
await chargeFee(q, userId, netFee, 'OPEN_FEE', market.id);
```

`chargeFee` already splits whatever it's given, so the LP/revenue split scales down automatically.
Lookup uses a cached `Map<userId, terms>` refreshed on admin write (mirrors the live-knob pattern —
the engine reads fees synchronously on the hot path, keep it sync).

---

## Mechanism 3 — cashback from referees' fees → **LOCKED**

Extend `chargeFee`: when the trading user has a `referred_by` affiliate with `cashback_bps > 0`, add a
cashback leg in the SAME txn, **out of the house's `FEE_REVENUE` share — never `LP_POOL`**:

```
gross F      debit  trader USER_COLLATERAL
LP  = F * feeLpSharePct/100      credit LP_POOL
CB  = F * cashbackBps/10000      credit affiliate USER_COLLATERAL   (reason REFERRAL_CASHBACK, ref=affiliate)
REV = F - LP - CB                credit FEE_REVENUE
```

- **Source: `FEE_REVENUE` only** (LPs never subsidize affiliate payouts). ✅ decided.
- **Guard (two layers):** at **set-time** reject if `feeLpSharePct% + cashback% > 100%`
  (`feeLpSharePct` is a STATIC env config — `config.ts:131`, default 50 → cashback ceiling = **50%**);
  AND at **runtime** clamp `CB = min(F·cashbackBps/10000, F − LP)` so `REV ≥ 0` even if `FEE_LP_SHARE_PCT`
  is changed on a later redeploy. (Integer floor already keeps `LP+CB ≤ F` when the %-sum ≤ 100%.) ✅
- **Payout: real USDC → the affiliate's normal withdrawable `USER_COLLATERAL`.** ✅ decided.
- Applies to **new trades only** (cashback computed at trade time; not retroactive).

---

## Mechanism 4 — affiliate-facing cashback display → **LOCKED (new UI)**

- **Backend:** `/account/balance` gains `cashbackTotalUusdc` = lifetime cashback received =
  `SUM(amount_uusdc)` over the user's `USER_COLLATERAL` `ledger_entries` where `reason='REFERRAL_CASHBACK'`.
- **Portfolio (`web/Portfolio.jsx`):** add a **"Cashback"** `stat-card` immediately **to the left of the
  "Unrealized PnL"** card (currently `Portfolio.jsx:67`), showing `cashbackTotalUusdc`. So the top row
  reads: Equity · Available · **Cashback** · Unrealized PnL.
- (Also surface "earnings to date" in `ReferralPanel.jsx` for affiliates.)

---

## Admin UI

New **Affiliates** tab in `AdminPanel.jsx` (mirrors Customers/Chat/Games): a table (code · wallet ·
cashback% · discount% · #referrals · cashback paid · active), a create/link form (wallet + code +
cashback% + discount% + label), inline edit (custody-limits style), deactivate.

---

## Build plan (gated on approval; build in `development`)

**Pre-req:** fast-forward / merge `master` into `development` (it's behind) so we build on the live code.

- **P1 (backend):** `affiliate_terms` schema + service (cached terms, discount on open/close fee, cashback
  leg + guard in `chargeFee`), `cashbackTotalUusdc` on `/account/balance`, `/admin/affiliates` API. Tests:
  discount math, cashback accounting (txn sums to zero, REV≥0 guard), set-time validation.
- **P2 (admin UI):** the Affiliates tab.
- **P3 (affiliate-facing):** Portfolio "Cashback" stat-card + ReferralPanel earnings.
- Each phase: QA + `/simplify` + adversarial. Local commit on `development`; merge to master + push/deploy
  gated on explicit approval.

## QA review (2026-06-20) — verified against code

Hook points confirmed real (`engine.ts:18-36` chargeFee; open `:364`/`:408`, close `:493`/`:522`;
`Portfolio.jsx:67`; `/account/balance`). Findings:

1. **THIRD fee site = liquidation (the spec missed it).** `liquidatePositionInTx` charges a
   `LIQUIDATION_FEE` (`engine.ts:635` via a separate `getLiqFeeBps()`, posted `:684` out of the released
   margin — NOT through `chargeFee`). ADL charges no fee; funding isn't a fee. **NEW DECISION:** exclude
   liquidation fees from both the discount and the cashback — they're penalties, not trading commissions
   (recommended + simplest). Only `OPEN_FEE` + `CLOSE_FEE` are in scope. Including them is a separate,
   deeper change. → ✅ confirmed EXCLUDED by user.
2. **Cashback ceiling = 50% by default + needs a runtime clamp.** `feeLpSharePct` is a static env config
   (default 50), so cashback can't exceed `100 − feeLpSharePct`. The admin UI must show this dynamic
   ceiling; runtime clamp added to Mechanism 3 above (protects `REV` if the env changes later).
3. **Attribution is the linchpin — VERIFY before P1.** Referees link via the existing redeem
   (`api.js:165`: the `?ref=` code is "captured on first load and held until the user signs in and
   redeems it"). The whole KOL feature depends on this firing. **Confirm the held code auto-redeems on
   sign-in**; if it's manual-only, add auto-redeem-on-signin (small fix) or KOL referees won't be attributed.
4. **Lookup: drop the cached Map; use one joined query per fee** — `users u LEFT JOIN affiliate_terms own
   (u.id) LEFT JOIN affiliate_terms ref (u.referred_by)` resolves the trader's own discount AND their
   referrer's cashback in one indexed read. The trader→referrer link can't be cached for all users anyway,
   and a per-fee query avoids multi-instance cache staleness. (Supersedes the cached-Map note in Mechanism 2.)
5. **Discount → fill consistency: OK, no extra work.** The discount is applied once at the fee computation
   (`openFee :364` / `closeFeeAmt :493`); that single value feeds BOTH `insertFill(feeUusdc=…)` and
   `chargeFee`, so `fills.fee_uusdc` automatically records the net (discounted) fee.
6. **Custody / PoR.** Cashback moves `FEE_REVENUE → affiliate USER_COLLATERAL` (both ledger accounts on the
   same treasury) — a liability re-class, not new money. Confirm proof-of-reserves treats a
   `REFERRAL_CASHBACK` collateral credit like any balance; it then withdraws via the normal custody queue.

## Decisions log
1. Cashback source — **`FEE_REVENUE` only**, with `LP% + cashback% ≤ 100%` guard. ✅
2. Payout — affiliate's **withdrawable balance**; show lifetime total in **Portfolio** (left of Unrealized
   PnL) + ReferralPanel. ✅
3. Build location — **`development` worktree**. ✅
4. Bounds — discount ≤100%, cashback ≤ (100 − LP-share)%, validated at set-time. (default applied)
5. Retroactivity — **new trades only**. (default applied)
6. Signup bonus — N/A in real-funds mode (existing bonus is play-money only); KOL codes = discount +
   cashback only. (resolved by context)
7. Hot-path lookup — **one joined query per fee** (revised from cached Map; see QA #4).
8. Liquidation fees — **EXCLUDED** from discount + cashback (penalties, not commissions). ✅ confirmed.
9. Attribution — **verify the `?ref=` held code auto-redeems on sign-in** before P1 (QA #3). ⏳ open (P1 step 0).
