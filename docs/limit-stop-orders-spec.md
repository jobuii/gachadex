# Limit / Stop-Loss / Take-Profit orders — build spec (v1)

**Status:** SCOPED + adversarially QA'd, not built (2026-06-23). Implements `ROADMAP.md` §6 (deferred).
v1 = **Limit orders + Stop-Loss + Take-Profit**, SL/TP **attached to a position** (reduce-only). Out of
scope for v1 (→ v2): stop-limit, trailing stops, explicit OCO linking, partial-fill resting orders.

> **Revised after a 3-reviewer adversarial QA (2026-06-23).** The first draft was economically sound but
> mis-fitted to the engine. The QA (grounded in `engine.ts`/`ledger.ts`/`index.ts`/`client.ts`) changed the
> core model in five ways, all reflected below:
> 1. **All three types are TRIGGERS that market-fill at the mark** — *not* "limit fills at the limit price."
>    The LP is the sole counterparty at the fair-value mark, the engine hard-codes `execPrice = mark` (no
>    override seam), and fill-at-limit is unfair/exploitable. A limit's price becomes its **slippage cap**
>    (fill at the mark, never worse than the limit ⇒ "mark-or-better").
> 2. **In-tx primitives.** `openPosition`/`closePosition` are top-level entrypoints that open their *own*
>    `withMarketLock` + `db.tx`; calling them from inside the trigger tx nests the tx (no savepoints →
>    corrupts) and self-deadlocks `withMarketLock`. Refactor `openPositionInTx(q,…)` / `closePositionInTx(q,…)`
>    (take a `Queryer`), exactly like the existing `liquidatePositionInTx`; the trigger pass calls those.
> 3. **Margin sequence.** `openPosition` re-locks margin from collateral itself, so "release reserve *into*
>    position margin" double-charges. On fill: release the reserve back to **collateral**, then let the open
>    lock from collateral (one charge). Reserve is a **floor**, re-derived from the fill mark.
> 4. **Triggers fire on the ORACLE mark, not the live skew-perturbed mark** (anti self-trigger / stop-hunt),
>    and the resting-order pass runs on its **own chained loop**, not inside the liquidation self-chain
>    (so a trigger backlog can't starve liquidations).
> 5. **The fill-time contract is the hard part** — full re-validation + trigger-side idempotency + a
>    defaulted slippage on closes. Detailed in §8.

---

## 0. Today (the starting point)

`ORDER_KINDS = ['market', 'reduce_only']`. Every order fills **immediately at the current mark** via
`engine.ts` `openPosition`/`closePosition`; `reduce_only` is a close-only market order. `limitPriceE6` is a
**slippage guard only** (`openPosition` rejects `slippage_exceeded` if the mark is worse) — **not** a resting
order. No resting-order store, no trigger mechanism. `CloseInput` has **no** slippage field — the guard
exists only on the open path (verified `engine.ts` `OpenInput`/`CloseInput`).

## 0a. The constraint that shapes everything — no order book

The **mark is synthetic** (`index × (1 + premium)`, `premium = clamp(k·skew/depth, ±cap)`; skew = net OI),
and the **LP pool is the SOLE counterparty**. There is no matching engine and no maker price. So a resting
order is a **trigger**: when the mark reaches its price, it executes a *market* fill against the pool at the
mark. Two consequences are baked into the model below: (a) all order types fill at the mark (a "limit price"
is only a trigger + a slippage cap), and (b) the mark moves intraday with OI skew, so triggers must read a
**manipulation-resistant mark** (§1a).

## 0b. Prerequisite refactor (not optional)

The trigger loop must run engine logic **inside its own tx + market lock**. Therefore, before P1:
factor the bodies of `openPosition`/`closePosition` into `openPositionInTx(q, …)` / `closePositionInTx(q, …)`
that take the in-tx `Queryer` and assume the caller holds `withMarketLock` + `db.tx` (mirroring
`liquidatePositionInTx`/`adlClosePositionInTx`). The public `openPosition`/`closePosition` become thin
`withMarketLock(…, () => db.tx(q => …InTx(q,…)))` wrappers. The trigger loop calls the `*InTx` variants. The
`*InTx` open gains an explicit `slippageE6` (already on open) — and the `*InTx` close gains a new `slippageE6`
param (the close path has none today). This is a small, well-bounded refactor, but it is a **prerequisite**.

---

## 1. Order types (v1) — all are triggers, all fill at the mark

| Type | Opens/Reduces | Fires when (long / short) | Fills | Slippage cap | Margin |
|---|---|---|---|---|---|
| **Limit** | open or reduce | mark ≤ price / mark ≥ price | market **at the mark** | **= the limit price** (mark-or-better; cancel if worse) | reserved on place (open only), re-margined at fill |
| **Stop-Loss** | reduce-only (position) | mark ≤ stop / mark ≥ stop | market **at the mark**, full close | defaulted (`RESTING_DEFAULT_SLIP_BPS`); breach ⇒ **stays resting** | none |
| **Take-Profit** | reduce-only (position) | mark ≥ tp / mark ≤ tp | market **at the mark**, full close | defaulted; breach ⇒ **stays resting** | none |

- **Limit** = a trigger at a price that market-fills at the mark, with the limit price as a **slippage cap**:
  you fill at the mark *or better*, never worse than your limit (if the mark gapped past, it cancels). This
  reuses `openPosition`'s existing fill-at-mark + `limitPriceE6` guard verbatim — no exec-price seam, no free
  option.
- **Stop-Loss / Take-Profit** = trigger-then-market, **reduce-only, attached to one position, full close**.
  They carry a **defaulted** slippage bound; if the mark is worse than the bound when they fire, the order
  **stays active and re-evaluates next sweep** (a protective stop is never silently cancelled — the
  liquidation engine is the hard backstop for a runaway loss).
- **Natural bracket (OCO-for-free):** a position may carry **one SL + one TP**; both are full-close
  reduce-only and auto-cancel on position-close, so when either fires the position closes and the other is
  auto-cancelled. No explicit OCO linking in v1.

## 1a. Anti-manipulation — what mark triggers read

`refreshMark` recomputes the mark from net OI skew on *every fill*, with no per-update clamp on the trade
path — so a user's own trade moves the mark intraday (≈ ±10% premium cap on a thin `$1M`-depth market for
~`$5k` margin). To stop self-trigger / stop-hunting, **triggers evaluate against the mark snapshot at the
last accepted oracle print** (the index-driven mark), captured at the start of each trigger sweep — *not* the
within-sweep, trade-perturbed mark. Position PnL/liquidation continue to use the live mark; only the
**trigger gate** uses the oracle snapshot. Recommend the NAV-relative OI cap (`oiCapNavBps`, currently `0`)
be **enabled** before this ships. (QA exploit #2.)

---

## 2. Schema — `resting_orders` (new, additive)

```sql
CREATE TABLE IF NOT EXISTS resting_orders (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  market_id       TEXT NOT NULL REFERENCES markets(id),
  position_id     TEXT REFERENCES positions(id),       -- required for stop_loss/take_profit
  kind            TEXT NOT NULL,                        -- 'limit' | 'stop_loss' | 'take_profit'
  reduce_only     BOOLEAN NOT NULL DEFAULT false,
  side            TEXT,                                 -- LIMIT-OPEN only (resulting direction); NULL for reduce-only (derived from position)
  qty_e6          BIGINT,                               -- limit only; SL/TP store full-close intent (see §8.4)
  leverage_e2     INT,                                  -- limit-open only
  trigger_price_e6 BIGINT NOT NULL,                     -- the price the mark must cross
  slippage_e6     BIGINT,                               -- worst acceptable fill; limit = the trigger price; SL/TP defaulted
  reserved_margin_uusdc BIGINT NOT NULL DEFAULT 0,      -- limit-open reservation (a floor)
  status          TEXT NOT NULL DEFAULT 'active',       -- active | filled | cancelled
  reject_reason   TEXT,
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_resting_user_idem ON resting_orders(user_id, idempotency_key);
-- one active SL + one active TP per position (QA gap #5): replace-on-duplicate in placeRestingOrder
CREATE UNIQUE INDEX uq_resting_pos_kind ON resting_orders(position_id, kind) WHERE status='active' AND reduce_only;
-- the trigger query range-scans this instead of loading all active rows (QA exploit #5)
CREATE INDEX idx_resting_trigger ON resting_orders(market_id, kind, trigger_price_e6) WHERE status='active';
```

Plus a **per-user** ledger account `RESTING_ORDER_MARGIN` — added to `AccountType`, created lazily via
`getOrCreateUserAccount` (NOT a `SYSTEM_ACCOUNT_TYPE`, no backfill), and **included in the equity/reconciler
views** that enumerate user account types (else a user's reserved margin vanishes from displayed equity).

## 3. Engine (`engine.ts`)

- **`placeRestingOrder(db, userId, input)`** — runs in **its own `db.tx` + `advisoryXactLock` on the user's
  collateral row** (so two concurrent placements can't double-reserve; `postTxn` requires a surrounding tx).
  Validates market + trigger-side sanity; for reduce-only SL/TP, validates `position_id` is the user's open
  position and enforces the one-SL/one-TP index (**replace** on duplicate kind: cancel-old + insert in the
  same tx, so "edit SL" is one call). For a **limit-open**, reserve a **floor** margin =
  `initialMargin(notional(qty, max(limitPrice, currentMark)), leverage)` (collateral → `RESTING_ORDER_MARGIN`).
  Publish `orders:{userId}`. Reduce-only orders reserve nothing.
- **`cancelRestingOrder(db, userId, id)`** — a **guarded** `UPDATE … SET status='cancelled' WHERE id=$ AND
  status='active' RETURNING *`; if it returns a row, refund the reserve in the same tx; if zero rows (a
  trigger already took it), no-op. (QA gap #7 — cancel-vs-trigger race.)
- **`checkRestingOrderTriggers(db, marketId, oracleMarkE6)`** — the per-market trigger pass, under **one**
  `withMarketLock(marketId, () => db.tx(q => …))` (never re-enters the lock). `SELECT … WHERE market_id=$ AND
  status='active' ORDER BY (kind='stop_loss') DESC, (kind='take_profit') DESC` (SL → TP → limit) for orders
  whose `trigger_price_e6` the `oracleMarkE6` has crossed; cap at `RESTING_MAX_PER_SWEEP` (carry the rest to
  next sweep). For each, **guarded-claim** it (`UPDATE … SET status='filled' WHERE id=$ AND status='active'
  RETURNING`; zero rows ⇒ skip) and execute via the in-tx primitive:
  - **limit** → `openPositionInTx(q, …, { execAtMark, slippageE6: triggerPrice })`. Sequence: **release the
    reserve to collateral**, then the open locks margin from collateral at the **fill mark** (one charge;
    QA #3). The open runs its **full gate set** (§8.1); on a *transient* market-state reject
    (halted/reduce_only/low_confidence/repricing) → revert the claim to `active` (retry next sweep, §8.3); on
    a *terminal* reject (opposite-side, slippage, OI cap, insufficient collateral) → leave `cancelled` +
    `reject_reason`, reserve already refunded.
  - **stop_loss / take_profit** → `closePositionInTx(q, …, { full: true, slippageE6 })` against
    `min(recorded, live)` qty read in-tx (§8.4). On a slippage breach → revert to `active` (re-evaluate). If
    the position is liquidatable, `closePositionInTx` rejects → revert to `active` (the liquidation sweep
    takes it; §4).
  Use a **deterministic idempotency key `resting:{id}`** for the engine order so a crash mid-fill can't
  double-execute (QA gap #6). Mark `filled` + `resolved_at` in the **same tx** as the fill. Publish.
- **Auto-cancel hooks** — in `closePositionInTx` (**only on a FULL close**, `remQty ≤ 0`), `liquidatePositionInTx`,
  **and `adlClosePositionInTx`** (QA #5 — ADL was missed): `UPDATE resting_orders SET status='cancelled'
  WHERE position_id=$ AND status='active' AND reduce_only` + refund any reserve. A *partial* manual close
  must NOT cancel the brackets.

## 4. Trigger loop (`index.ts`) — its own chain

Add a **separate** `chainLoop` (`startRestingOrderLoop`), NOT inside `startLiquidationLoop`, so a trigger
backlog can never starve the safety-critical liquidation/ADL self-chain (QA exploit #5). Each pass: for each
tradeable market, snapshot the **last-oracle-print mark** (§1a) and `await checkRestingOrderTriggers(db,
marketId, oracleMarkE6)`. A trigger on a liquidatable position no-ops (the close rejects) and defers to the
liquidation chain — so strict cross-chain ordering isn't required. Cadence `restingSweepMs` (≈ the liq
cadence); the pass is also fine to kick after each accepted oracle print.

## 5. API (`routes/orders.ts`)

- `POST /orders/resting` — `{ marketId, kind, triggerPriceE6, slippageE6?, side?, qtyE6?, leverage?,
  positionId?, reduceOnly, idempotencyKey }`. Validation: SL/TP require `positionId` (the caller's open
  position) and **ignore `side`** (derived from the position, §8.8); limit requires `side`+`qtyE6`+`leverage`.
  Enforce `RESTING_MAX_PER_USER_MARKET` (QA exploit #5).
- `POST /orders/resting/:id/cancel` → `cancelRestingOrder`.
- `GET /orders/resting` → the user's `active` resting orders (Open-Orders list).

## 6. UI (`OrderEntry.jsx` + bottom panel)

- **Market | Limit** order-type toggle; Limit reveals a price input → `/orders/resting`. Show that a limit is
  "fill at market when the price is reached, no worse than your limit."
- **Per-position SL/TP** control on each open position row (set/edit/clear; clearing cancels).
- **Open Orders** bottom-panel tab: active resting orders (type · trigger · qty/position) + cancel; live from
  `orders:{userId}` via **snapshot-then-delta keyed by order id** (client replaces on snapshot, upserts on
  delta — QA gap #7).

## 7. Realtime

Publish to `orders:{userId}` on place / fill / cancel; the fill event carries the realized fill price + any
slippage so the UI can show "stop filled at $X (trigger $Y)".

## 8. The fill-time contract (where the QA found the real holes)

1. **Full re-validation at fill.** A limit-open re-runs the **entire `openPosition` gate set** at trigger
   time — leverage cap, static + NAV-relative OI caps, pool-health, `low_confidence`, fresh-mark, and
   `margin + openFee ≤ available`. The reserve covers margin but **not the open fee**; insufficient → cancel.
2. **Funding + fee.** Funding accrues from the **fill** instant (snapshot then); the fee is on **fill-mark
   notional**, charged at fill. Placement reserves margin only — no fee, no funding. SL/TP settle funding
   first (the `closePosition` path already does).
3. **Stale/halted markets.** While a market is `reduce_only`/`halted`/`low_confidence`, **limit-opens skip
   and stay active** (resume when `active`); **SL/TP still fire** (the close path is status-exempt — correct
   for risk reduction). The §4 check is per-order, gated on the open's transient-vs-terminal reject.
4. **SL/TP qty drift.** Store SL/TP as **full-close intent**, not a frozen qty; fill against the position's
   `min(recorded, live)` qty read **in-tx** at fill; if the position is gone, auto-cancel.
5. **One SL + one TP** — enforced by `uq_resting_pos_kind` (§2); `placeRestingOrder` replaces on duplicate.
6. **Crash idempotency** — the trigger's engine order uses `idempotency_key = 'resting:{id}'`; the row flips
   to `filled` in the same tx as the fill, so a re-run after a crash hits the `orders(user_id,
   idempotency_key)` conflict and never double-fills.
7. **Cancel-vs-trigger** — both sides do a guarded `UPDATE … WHERE status='active' RETURNING`; the loser sees
   zero rows; the reserve is released exactly once.
8. **`side` semantics** — `side` is an input only for limit-opens; for reduce-only SL/TP it's the opposite of
   the position's side (derived, not trusted from the client).

## 9. Decisions (v1 defaults — override on review)

- **No partial fills** (all-or-nothing). **Limit = trigger + fill-at-mark, capped by the limit price**
  (mark-or-better). **SL/TP = full-close, market at the mark.** Slippage is **optional** with **NO default in
  P2** (built behaviour): a stop fills at whatever the mark is — the safest default for a protective order
  (it always fills rather than getting stuck). If the caller supplies a `slippageE6` bound, a breach ⇒ the
  order **stays resting** (re-evaluates; liquidation is the backstop) — so the UI must send a tolerance band,
  NOT the bare trigger price. (`RESTING_DEFAULT_SLIP_BPS` deferred.) **One SL + one TP per position** (the
  natural bracket). **Caps:**
  `RESTING_MAX_PER_USER_MARKET` + `RESTING_MAX_PER_SWEEP`. **Flag-gated** `RESTING_ORDERS_ENABLED` (default
  OFF) gates the routes AND the §4 loop → dark deploy. **Enable `oiCapNavBps`** before the flag flips.

## 10. Phasing

1. **P0 — prerequisite refactor:** `openPositionInTx`/`closePositionInTx` (+ `closePositionInTx` slippage) +
   `RESTING_ORDER_MARGIN` account + equity-view inclusion. Pure refactor; existing behaviour unchanged; tests.
2. **P1 — backend, limit orders:** `resting_orders` schema + `placeRestingOrder`/`cancel`/
   `checkRestingOrderTriggers` (limit only) + the own-chain loop + the oracle-mark trigger gate + the
   margin sequence + full re-validation + idempotency + the API. Dark behind the flag. Tests.
3. **P2 — SL/TP:** reduce-only, position-attached, full-close, defaulted slippage + the auto-cancel hooks on
   close-full / liquidate / ADL + qty-drift. Tests.
4. **P3 — UI:** Market/Limit toggle, per-position SL/TP, Open-Orders tab, snapshot-then-delta WS.
5. **P4 (later):** partial fills/closes, explicit OCO, stop-limit, trailing.

## 11. Test plan

- **Margin:** reserve→fill is one charge (not two); reserve→cancel refunds exactly once; the reserve floor vs
  re-margin-at-fill reconciliation; collateral lock prevents double-reserve.
- **Triggers:** limit fills at the mark capped by the limit (mark-or-better); a gap past the limit cancels; a
  stop fills on a mark cross within slippage; a stop past slippage **stays resting**; SL-before-TP ordering.
- **Lifecycle:** auto-cancel a position's SL/TP on full close, on liquidation, **and on ADL**; a partial
  close does NOT cancel; qty-drift caps at the live qty; one-SL/one-TP replace.
- **Concurrency/recovery:** cancel-vs-trigger guarded race; `resting:{id}` idempotency prevents
  double-execute across a simulated crash; self-trigger is blocked (a trade-perturbed mark does NOT fire a
  trigger; the oracle mark does).
- **Fill-time gates:** a limit-open that breaches an OI cap / pool-health / collateral at fill → cancel with
  the engine reason; a halted market pauses limit-opens but still fires SL/TP.
- **DoS:** `RESTING_MAX_PER_SWEEP` bounds a clustered print so the loop can't stall; the trigger query
  range-scans (doesn't load all active rows).

## 12. Risks / watch-items

- **Self-trigger** is the headline risk; mitigated by the oracle-mark trigger gate (§1a) + enabling
  `oiCapNavBps`. Re-derive the manipulation budget (premiumCap × depth-floor) on the live config before flip.
- **Stops on a gap** fill no worse than the defaulted slippage, else stay resting; communicate "stops aren't
  guaranteed at the stop price" in the UI; the liquidation engine is the ultimate backstop.
- **The P0 in-tx refactor** touches the hottest code path (`openPosition`/`closePosition`) — full regression +
  the existing 300+ engine tests must stay green before P1.
- **Reserve-vs-fill-margin** must reconcile atomically (one tx); covered in tests.
