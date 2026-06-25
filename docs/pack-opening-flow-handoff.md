# Pack-opening flow — architecture handoff

How rare.win's pack-opening works, written so another session can replicate the pattern.
This is grounded in the actual rare.win source, not from memory. The card/payment provider
there is **CollectorCrypt (CC)**; if your app uses a different provider, the *architecture*
below still transfers — only the provider client changes.

---

## The core idea (the transferable architecture)

The user never signs anything in their browser. It's a **custodial** model:

1. **Each user gets a server-held wallet.** On account creation the server generates a
   keypair, AES-256-CBC-encrypts the secret, and stores it. The server signs transactions
   *on the user's behalf*.
2. **An external provider builds the transactions.** The app doesn't mint cards itself — the
   provider does. The pattern for *every* money action is identical:
   **provider returns an unsigned transaction → server signs it with the user's custodial
   key → server submits it.**
3. **Money is real on-chain currency (USDC on Solana).** The on-chain balance is the spend
   gate; a separate DB "ledger" is just a **mirror** for accounting, not the authority.

The single most important and non-obvious property: **the provider decouples payment from
delivery.** Submitting the transaction *pays*, but the asset is revealed by a *separate,
idempotent* `openPack(memo)` call that only succeeds once the provider's payment webhook
confirms. So **the `memo` is the receipt** — persist it *before* paying, then deliver /
reconcile idempotently. Everything below exists to make that safe.

---

## End-to-end flow

```
Frontend (packs page) → POST /api/packs/open {packType, qty, turbo}
  │
  ├─ PRE-PAYMENT  (a failure here = truthfully "no funds taken")
  │    getMachines()         → authoritative price for the machine `code`
  │    getUsdcBalance(wallet) → real on-chain balance check
  │    generatePack(...)      → provider returns {memo, unsigned tx}  (×qty via a batch call)
  │                             ↑ THIS is also the real-time stock gate (see invariant #6)
  │
  └─ PAY + DELIVER  (per pack, independent; NEVER claim "no charge" past submit)
       1. write PackPurchase {memo, status:"paid_pending"}   ← receipt FIRST (crash-safe)
       2. submit(sign(tx, custodialKey))                     ← this PAYS
       3. deliverMemo(memo):
            openPack(memo)  → if WAITING_FOR_WEBHOOK, retry a few times
                            → returns the won asset (mint + metadata)
            record the asset, mark PackPurchase "opened",
            mirror the ledger debit (pack_buy, −price)        ← all keyed on memo (idempotent)
  → response {cards, pending, failed}; the reveal UI animates the cards
```

Anything not delivered in the request is left `paid_pending`; a **reconciler**
(`reconcilePending`, run on login + after an open) finishes confirmed ones and marks
genuinely-failed / refunded memos after a grace window (via `getPackStatus(memo)`).

---

## Components to replicate (responsibility → why it matters)

| Component | What it owns | Why it matters |
|---|---|---|
| **Custodial wallet store** | Per-user keypairs: create, decrypt (server-only), treasury key | Server-signs-for-the-user. Secret encrypted at rest; move to a KMS before real funds. |
| **Provider client** | `getMachines`, `generatePack`/batch, `submit`, `openPack`, `getPackStatus`, `sign(tx)` | The external boundary. **Mutations use 0 retries** (never double-process); idempotent GETs may retry. |
| **Open route (orchestrator)** | The pre-payment / post-payment **honesty boundary** + per-pack `payAndDeliver` (receipt-first, **never throws**) | The crash-safety heart. Each pack is its own tx+memo, so one failure never discards the others. |
| **Delivery + reconcile** | `deliverMemo` (idempotent reveal+record) + `reconcilePending` (finish stranded paid packs) | Encodes pay≠deliver. The memo is the receipt; `openPack` is idempotent. |
| **Ledger** | `mirrorLedger` (track on-chain moves, never reject) vs `applyLedger` (authoritative, rejects on negative); idempotent on a key | The ledger is a **mirror reconciled to on-chain truth** — not the spend gate. A debit with no matching on-chain transfer drifts and gets reverted. |
| **On-chain helpers** | `getUsdcBalance`; transfers with the **treasury as fee-payer** (custodial wallets hold no SOL for gas) | Funding / withdrawals + the gas-relay pattern. |
| **Frontend** | Catalog (derive the provider's machine `code` from the pack), the open call, the reveal, reconcile-on-login | Thin over the API. |

---

## The six invariants that make it correct (do NOT skip these)

1. **Receipt before payment.** Persist the memo (`paid_pending`) *before* submitting. A crash
   between pay and deliver must never lose a paid pack.
2. **Idempotency everywhere, keyed on memo.** `openPack` is idempotent; the ledger debit is
   keyed `pack_buy:${memo}`; the purchase row is memo-unique. Retries and the reconciler never
   double-charge or double-deliver.
3. **The honesty boundary.** Before submit, a failure is truthfully "no funds taken." *After*
   submit, **never** say "no charge" — the tx may have landed; leave it pending for the
   reconciler. The signal: a returned **signature ⇒ may have landed ⇒ pending**; **no signature
   ⇒ rejected pre-broadcast ⇒ safe to fail.**
4. **A reconciler is mandatory, not optional.** Webhooks/opens fail; the reconciler is what
   guarantees every paid pack eventually delivers (or is marked refunded/failed).
5. **Chain is the gate; ledger is a mirror.** Spendability = real on-chain balance. Don't gate
   spends on a DB number you can debit without a matching on-chain movement.
6. **Let the provider's build call gate stock — and generate fresh, right before submit.**
   The `generatePack` (build) call is the **authoritative, real-time** stock check, and it runs
   **pre-payment**. So:
   - **Don't add your own stock pre-check from a cached/snapshot field.** A snapshot (e.g.
     `machine.stock` from `getMachines`) is *staler* than the live build call, so an explicit
     pre-check can only **false-positive — block a valid open after a restock** — without adding
     any safety the build call doesn't already provide. (We considered this and rejected it.)
   - **Generate the tx fresh, immediately before submit, in the same request. Never cache or
     reuse a generated tx across time** — submitting a stale, pre-built tx *after* the machine
     emptied is exactly how you pay and get nothing.
   - **Structure the code so the only errors reachable before `submit` are pre-payment ones**,
     then map the provider's "machine empty / sold out" error → a `"sold out — no funds taken"`
     409. Because the build call runs in the try *before* the never-throwing `payAndDeliver`,
     that catch is reachable only pre-payment, so the wording is always truthful.
   - Residual (can't be fully eliminated): the tiny race where stock depletes *between* a fresh
     generate and submit → the asset fails to deliver *after* payment. That surfaces as
     `pending`/`failed` and is handled by the reconciler + provider refund, **not** a pre-check.

---

## Provider-specific notes (CollectorCrypt — adapt or drop for your provider)

- **`turbo` mode:** the provider auto-sells low-tier (Common) wins for currency instead of
  delivering the asset — so "kept vs sold" is decided by the provider's *response*, not the
  request flag. Plumb the real outcome through, don't assume.
- **Instant buyback:** any asset won within 72h can be sold back to the provider for ~a fixed
  % of insured value, and the payout can be redirected to a different wallet via an
  `altRecipient` param. (rare.win uses this for "sell at reveal" and for battle settlement.)
- **Auth:** the provider's API key was optional/unenforced in practice — sent if present, never
  required. Validate against the provider's dev endpoints before pointing at production.

---

## What transfers vs what's provider-specific

The **provider client** won't transfer if your app uses a different card/pricing source (e.g.
Scrydex). But the **architecture does**: custodial wallets, the unsigned-tx → sign → submit
pattern, **pay≠deliver decoupling**, **memo-as-receipt**, **idempotent delivery + a reconciler**,
**ledger-as-mirror**, and **invariant #6's "let the live build call gate stock; generate fresh
before submit."**

If your provider is **pricing-only (no minting/payment rail)**, the part you replace is the
"provider builds a payment+mint tx" layer — but the **receipt-first → idempotent-deliver →
reconcile** spine is what keeps *any* money/asset flow from double-charging, and it's worth
keeping whatever the rail.
