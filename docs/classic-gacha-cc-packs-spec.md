# Classic Gacha — Collector Crypt real-NFT packs on GDEX

**Status:** SCOPED (not built), **v2 — adversarially QA'd** (2026-06-23). Design doc for review.
**Coexists** with the synthetic **Pack Rip** game (`game` branch) — a *separate* surface: real graded-card NFTs
from Collector Crypt (CC), not GDEX-oracle synthetic prizes (see §4).

## 0. QA changelog (what the v1→v2 review found + fixed)

Three independent reviews grounded against the real rare.win + GDEX code. Survivors, all addressed below:
- **Custody topology (blocker):** CC `generatePack` has **no verified `altPlayerAddress`** (rare.win's client is
  `{playerAddress, packType, turbo?}` only). → primary model is now **sign with a per-user keypair + just-in-time
  fund it from the hot wallet**; `altPlayerAddress` demoted to an optimization to verify on the live test (§5).
- **Deposit-scanner collision (blocker):** the live `scanDeposits` credits *any* USDC delta on *any* deposit
  address as a fresh deposit and sweeps its SOL → a CC buyback into such a wallet **double-credits** and the SOL
  drain breaks pNFT fees. → a **dedicated, un-scanned** NFT-custody derivation path is now **mandatory**, and CC
  buyback USDC routes to the hot wallet (§5).
- **Missing refund entry (blocker):** a failed/refunded buy had no reversal. → `GACHA_REFUND` added (§6).
- **Convert-to-position (blocker):** `openPosition(db)` opens its own tx + market lock, can't nest in sell-back,
  and sell-back is async. → convert is now **two async stages**, and unavailable when the card has no GDEX market
  (which is *most* CC cards — lever C honestly downgraded) (§6, §9).
- **Turbo bugs:** §9 said the turbo cut was 5% (everywhere else 10%); turbo only auto-sells **Common** wins
  (a turbo Rare/Epic is *kept*). → fixed to branch on the buyback signal at 10% (§9).
- **Token math/accounting:** fractional Tokens (a $25 open earned 62.5) and an unpostable lone-leg token-pack
  entry that also corrupted `FEE_REVENUE`. → unit is now **1 Token = $0.001** (integer earns) + a dedicated
  `GACHA_REWARDS_BUDGET` account. **No markup required** at the operator's expected ~90% sell-back rate (revised
  §6 with the operator's CC-data model); the **free-pack threshold is an admin liveKnob** (default $1000, §6b).
- **Smaller:** `payWith` missing from §9's open body; inventory INSERT not idempotent; "saved withdraw address"
  doesn't exist in GDEX (it's per-request + step-up); the signer must be a port of rare.win's `signBase64Tx`;
  machine-price drift; buyback-unavailable path; held-forever custody. All fixed below.
- **Cross-checked vs the other session's `tradex-clone/docs/pack-opening-flow-handoff.md`** (2026-06-24) — it
  confirms our spine (custodial · pay≠deliver · memo-as-receipt · idempotent deliver + reconciler) and added:
  **invariant #6** (the live `generatePack` build call *is* the stock gate — no cached stock pre-check; generate
  the tx fresh right before submit, never reuse; map "sold out" → a no-funds-taken 409); **paying mutations get 0
  retries** (only the idempotent `openPack` retries); the **gas-relay fee-payer** pattern (custodial wallets hold
  no SOL — the hot/treasury wallet pays gas); and a note on why GDEX gates on the **off-chain ledger** (pooled
  funds) where the handoff's per-user-on-chain model gates on chain. Folded into §5/§8/§9/§16.

- **P2 build correction (2026-06-24):** CC cards are **Metaplex Core** (`MplCoreAsset`) — NOT pNFTs — verified
  against live mints + rare.win's `lib/nftTransfer.ts`. So `transferNft` uses **mpl-core `transferV1`** (hybrid →
  web3.js via the umi adapter) + a DAS `getAssetTransferInfo` for the collection, NOT Token Metadata / SPL. Deps
  installed: `@metaplex-foundation/{mpl-core,umi,umi-bundle-defaults,umi-web3js-adapters}`.

## 1. Goal

A **"Classic Gacha"** entry on the Games page → a rare.win-style **lobby** of CC pack "machines" (machine
artwork + the real graded cards in each + price). A user buys a pack with their **GDEX balance** (or Tokens, §6b);
GDEX pays CC on-chain, CC's draw reveals + delivers a **real graded-card NFT** into the user's **GDEX custody
wallet**. Then: **Sell back** (GDEX keeps 5% / 10% turbo, rest to the user), **Withdraw** (the slab shows in
**Portfolio → Inventory**, sendable to an external wallet), or **Trade/Convert** (→ that card's GDEX perp, when a
market exists). UX is GDEX-styled — *similar* to CC's lobby, not a clone.

## 2. Decisions locked (by the user)

1. **Coexist** as a "Classic Gacha" card on the Games page → its own lobby.
2. Prize = **real Collector Crypt graded NFTs**.
3. **Sell-back:** GDEX keeps **5%** (10% on turbo/instant); rest to the customer.
4. **Withdraw:** the NFT lives in the user's GDEX wallet; **Portfolio → Inventory** lists held NFTs; withdraw
   sends the NFT to an external wallet (per-request dest + step-up, §9).
5. **CC API needs no key** — payment is an on-chain signed USDC transfer (confirmed against rare.win's client).
6. **CC mainnet behavior confirmed by a small live test once built** — incl. whether `altPlayerAddress` exists.
7. Revenue levers: 5%/10% sell-back cut + convert-to-position (C) + Tokens loyalty (E); markup/withdraw-fee held.

## 3. How Collector Crypt works (recap — grounds the integration)

CC is a fully custodial gacha: it owns the packs, the real graded PSA/CGC slabs (Solana NFTs), the draw, the
per-card pricing (`insured_value`, from ALT/eBay), and the buyback. Two base URLs, no key required:
- **Gacha API** `https://gacha.collectorcrypt.com` (devnet `https://dev-gacha.collectorcrypt.com`).
- **Marketplace API** `https://api.collectorcrypt.com` (only if we ever list — not in v1).

| Purpose | Method | Path (gacha) | Key params | Returns |
|---|---|---|---|---|
| List machines | GET | `/api/machines` | — | price, odds, tierRanges ($ bands), `instantBuyback` %, stock, ev — **$ values are dollars** |
| Per-machine stock | GET | `/api/stock` | — | `{machineCode:{rarity:count}}` |
| Cards in a pool | GET | `/api/getNfts` | `code`,`rarity?`,`page?`,`limit?` | `nft_address`,`name`,`rarity`,`image`,`insured_value` ($) |
| Recent winners | GET | `/api/getAllWinners` | `count?`,`packType?` | winners feed |
| Generate pack (pay) | POST | `/api/generatePack` | `playerAddress`,`packType`,`turbo?` *(`altPlayerAddress?` UNVERIFIED — see §5)* | `{ memo, transaction }` — unsigned b64 USDC-transfer tx |
| Submit signed tx | POST | `/api/submitTransaction` | `signedTransaction` (b64) | `{ success, signature, confirmationStatus }` |
| Open / reveal | POST | `/api/openPack` | `memo` | `nft_address`, `nftWon`, `rarity`, `buybackAmount` (base units), `code` (`WAITING_FOR_WEBHOOK`/`TURBO_MODE_BUYBACK`) |
| Pack status | GET | `/api/pack/status?memo=` | `memo` | `{ pack(refunded?), send, buyback }` |
| Buyback quote | GET | `/api/buyback/available` | `wallet`,`nft` | `{ available, amount? }` (base units, haircut) |
| Instant buyback | POST | `/api/buyback` | `playerAddress`,`nftAddress`,`altRecipient?` | `{ serializedTransaction, refundAmount, memo }` — atomic NFT→CC + USDC→recipient. **72h window** after open |

**Monetary units (verified):** machines/getNfts/winners $ fields are **dollars** (×1e6 → micro-USDC on the way
in); `buybackAmount`/`refundAmount` are **base units** already. `pack/status` refund/insured fields are strings
of undocumented unit — pin them before crediting off `pack/status`.

**Two-phase flow** (proven in rare.win `packDelivery.ts`): `generatePack` → sign → `submitTransaction` (USDC to
CC) → `openPack(memo)` (CC confirms payment via its own webhook, then reveals + transfers the NFT). `openPack`
can return `WAITING_FOR_WEBHOOK` → retry 3 × ~1.5s → reconciler. `openPack` is idempotent by memo.

## 4. Classic Gacha vs Pack Rip (why this is a new surface)

| | **Pack Rip** (synthetic, `game` branch) | **Classic Gacha** (this spec) |
|---|---|---|
| Card source / pricing | GDEX featured markets / oracle mark | CC machine inventory / CC `insured_value` |
| Draw | GDEX commit-reveal (`game-fairness.ts`) | CC's draw (we don't run RNG) |
| Prize | synthetic (USDC at oracle mark) | **real graded NFT** in the user's wallet |
| Sell-back | `oracle × (1−spread)` from `GAME_POOL` | CC buyback amount; GDEX keeps 5%/10% |
| Withdraw real card | stub | yes (MPL Core transfer to external wallet, P2) |

Shared: the Games shell, live-feed/chat, the trade→perp hook. Keep both.

## 5. Architecture (custodial — consistent with GDEX)

- **Off-chain ledger is the spend gate.** Spendable USDC = `USER_COLLATERAL` (backed by deposited funds swept to
  the hot wallet). A USDC pack debits `USER_COLLATERAL` (insufficient balance → blocked). *(NB: this deliberately
  differs from the handoff's "chain is the gate, ledger is a mirror" — that holds when each user has their own
  on-chain wallet; GDEX pools deposits into the hot wallet and has no per-user on-chain USDC to check, so the
  ledger is the authority. Don't "fix" this to match the handoff.)*
- **Per-user NFT-custody wallet — a DEDICATED, un-swept derivation path** (e.g. `m/44'/501'/{index}'/1'`, distinct
  from the `…/0'` deposit path), **NOT enumerated by `scanDeposits`**. *This is mandatory, not optional:* the live
  deposit scanner credits any USDC delta on any deposit address as a fresh `USER_COLLATERAL` deposit and sweeps its
  SOL — so a CC buyback or a JIT funding into a *deposit* address would double-credit and drain the SOL a pNFT
  account needs. The dedicated path is never scanned/swept, so the won NFT and its rent-SOL sit safely until the
  user sells or withdraws.
- **Paying CC — primary model: per-user keypair signs + JIT funding.** CC binds delivery to the signer (rare.win
  signs `generatePack` with the user's own wallet, which is payer + recipient + balance). GDEX's per-user wallet is
  empty (or dedicated/un-swept), so on open: the **hot wallet transfers the pack price** into the user's NFT-custody
  wallet, then GDEX signs `generatePack` with **that** keypair → CC delivers the NFT there. Use the
  **hot/treasury wallet as the fee-payer** (the gas-relay pattern from the handoff — custodial wallets hold no SOL)
  on every tx we control (the buyback + the pNFT withdraw); for the CC-built payment tx, confirm on the live test
  whether CC forces the signer to cover gas (if so, relay a little SOL into the wallet too). *Optimization (verify on the live test, §2.6):* if CC supports `altPlayerAddress` (payer ≠ recipient), pay
  straight from the hot wallet and skip the JIT funding tx.
- **Signer:** port rare.win's `signBase64Tx` (`collectorcrypt.ts:256`) — it deserializes and signs **both**
  `VersionedTransaction` and legacy `Transaction`. GDEX's `custody/solana.ts` only signs txs it builds itself, so
  this is a new generic signer in `gacha-chain.ts`, not an "extension" of `signUsdcTransfer`.
- **CC buyback USDC routes to the hot wallet.** Sign `buyback` with the user NFT-custody keypair (it owns the NFT)
  and pass `altRecipient: hotWallet` so the refund lands directly in the hot wallet — never in a scanned address.
  (If `altRecipient` is unconfirmed, the refund lands in the un-scanned NFT-custody wallet and we explicitly
  sweep+credit; still safe because that path is not a `deposit_address`.)
- **PoR (USDC) stays balanced;** the NFT is a non-USDC asset tracked in `gacha_nft_inventory`. Note the transient
  in §6.

## 6. Money flows (exact ledger entries)

All `postTxn`, Σ entries = 0 (the helper throws otherwise), inside `db.tx`, system/`USER_COLLATERAL` rows
`FOR UPDATE` (lock order: `USER_COLLATERAL` → others).

**Buy a USDC pack (price P):** receipt row first (`status=pending`), then debit:
```
USER_COLLATERAL -P ; TREASURY_USDC +P     reason=GACHA_PACK_BUY  refType=gacha_open
```
The hot wallet's outbound P is the user's own deposited float. **Transient + sweeper note:** the debit posts
before the on-chain payment confirms, so PoR briefly reads a *surplus* (liability dropped, on-chain not yet out) —
harmless direction, but the treasury sweeper must **reserve in-flight `status='paid'` gacha buys** (as it reserves
pending withdrawals) so it can't sweep the float needed for the pending CC payment.

**Refund / fail reversal (NEW — was missing):** idempotent on `open_id`, posted once on the status transition
under `FOR UPDATE`:
```
USER_COLLATERAL +P ; TREASURY_USDC -P     reason=GACHA_REFUND
```
- `failed` (no `payment_sig` — money never left, e.g. `generatePack`/`submit` failed after the step-3 debit):
  re-credit the user. **Without this the user is silently out P.**
- `refunded` (`pack/status.refunded` — CC returned USDC on-chain): reconcile the on-chain inflow + post the credit.

**Sell back (CC buyback returns B base-units to the hot wallet via `altRecipient`):**
```
USER_COLLATERAL +floor(B*(1-cut)) ; FEE_REVENUE +(B-floor(B*(1-cut))) ; TREASURY_USDC -B
reason=GACHA_SELLBACK  refType=gacha_prize     cut = 5% manual (gacha_buyback_cut_bps=500) | 10% turbo/instant (gacha_turbo_cut_bps=1000)
```
Use the **actually-received** B (from the buyback confirm), not the pre-quote, so the ledger matches chain. `floor`
the user share; GDEX takes the remainder (never over-credit). The 5%/10% is GDEX's cut **of CC's buyback amount**
(itself `insured × CC%`) — the user's effective return on a sold card = `insured × CC% × (1−cut)`.

**Withdraw the real NFT:** no USDC ledger entry; the pNFT transfers from the user NFT-custody wallet → the
user-supplied external dest; `status=withdrawn`.

**Revenue levers** (one place — referenced elsewhere): **(A, held)** purchase markup `gacha_markup_bps`;
**(D)** sell-back cut 5% / 10% turbo; **(C)** convert-to-position (sell-back → open a perp on the card's market,
when one exists — earns the cut + perp fees + funding; see §9, and the honest reach caveat §15); **(E)** Tokens
loyalty (§6b — a cost, not margin); **(held)** NFT-withdraw fee.

**Economics (operator model — no markup for now):** the sell-back cut funds the Token rebate with margin at the
expected sell-back rate. Worked from CC data: a $25 pack's EV ≈ $26, CC buyback ≈ $22.1, GDEX's **5% cut ≈ $1.10
per sold-back pack** (10% on turbo). CC data shows **~90% of players sell back** (don't keep). Per **$1,000 of
pulls** (~40 packs): ~36 sell-backs × $1.10 ≈ **$40 cut** vs the **$25** free pack given away → **≈ +$15 net per
$1,000** (≈ +$19 at the ~100% sell-back the operator quoted). **Break-even ≈ 57% sell-back** at these params, so
~90% is comfortably profitable — **no purchase markup is charged.** `gacha_markup_bps` stays an *optional* lever,
and the live net is **monitored** (admin readout: cut revenue vs rebate cost + the actual sell-back rate); if
sell-back drifts toward ~57%, turn the markup on.

## 6b. Tokens — loyalty & rewards (lever E)

A per-player **loyalty points currency** ("Tokens" — working name; a coin with the GachaDex logo), **distinct from
the on-chain `$GDEX` token** (you *earn* Tokens partly by holding `$GDEX`; Tokens are internal, **non-transferable,
non-withdrawable** points). Packs are bought with **USDC or Tokens**.

**Unit + calibration (admin-adjustable threshold).** **1 Token = $0.001**; a pack's Token price = USD price × 1000
(a $25 pack = **25,000 Tokens**, $50 = 50,000, $100 = 100,000). The pack-open earn rate is **derived from an admin
liveKnob `gacha_free_pack_threshold_usd`** = the USD of pack spend that earns one free $25 pack (**default $1000**
→ 25 Tokens/$1 → ≈**2.5% rebate**; a $25 open earns 625, a $100 open 2,500). The operator changes the threshold
live in the admin panel ($500 = more generous, $2000 = less); the earn rate recomputes from it. Per-open earn is
`floor`ed (fractional Tokens dropped), so the threshold is approximate to the cent — fine for a loyalty program.
- **Other earn (each a tunable knob; all = future cost):** holding `$GDEX` (daily accrual ∝ balance — reuse the
  on-chain `$GDEX` read DROP already uses), trading (∝ **fees paid**, wash-resistant), LP contribution (∝ stake ×
  duration).

**Spend + accounting (Tokens are a cost, not revenue):**
- Tokens live in their own ledger (`token_balances` + `token_ledger`) — **no Σ=0 partner**, so a reconciler
  invariant must enforce `Σ token_ledger == token_balances` per user (mirroring the USDC reconciler).
- A token-bought pack still costs GDEX **real USDC** to CC, booked to a **dedicated `GACHA_REWARDS_BUDGET`** account
  (NOT `FEE_REVENUE` — that's shared with LP fees + affiliate cashback, which is a % of FEE_REVENUE):
  ```
  GACHA_REWARDS_BUDGET -price ; TREASURY_USDC +price     reason=PACK_BUY_TOKENS_FUND
  ```
  No `USER_COLLATERAL` debit. Pre-fund/cap the budget — an unfunded budget running negative is an unbacked promise,
  not a reserved liability. Outstanding Tokens = a **deferred USDC liability**.
- **No markup required** at the expected sell-back rate (§6); `gacha_markup_bps` stays an optional lever, with the
  live net monitored (admin readout of cut revenue vs rebate cost + sell-back rate).

**Anti-abuse:** earn only on **paid (USDC)** opens (token opens earn nothing); per-account daily earn cap;
trade/LP earn tied to fees paid; Tokens non-transferable.

**UI:** Token balance (logo coin) in the lobby header + Portfolio; Pay-with toggle; a **"X Tokens until your next
free $25 pack"** progress bar.

## 7. Data model (new tables)

```sql
-- Pack purchase/open receipt + state machine (idempotency anchor; written BEFORE payment).
CREATE TABLE gacha_pack_opens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL, machine_code TEXT NOT NULL,
  price_e6 BIGINT NOT NULL, paid_with TEXT NOT NULL DEFAULT 'usdc',   -- usdc | tokens
  turbo BOOLEAN NOT NULL DEFAULT false,
  cc_memo TEXT UNIQUE, payment_sig TEXT,                              -- payment_sig set ⇒ never auto-fail
  status TEXT NOT NULL DEFAULT 'pending',                             -- pending|paid|opened|turbo_sold|refunded|failed
  nft_mint TEXT, nft_name TEXT, grade TEXT, insured_value_e6 BIGINT, rarity TEXT,
  turbo_refund_e6 BIGINT, refunded_at TIMESTAMPTZ,                    -- turbo instant-sell payout / refund
  opened_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
-- Won NFTs in custody (Portfolio → Inventory; mirrored vs Helius DAS).
CREATE TABLE gacha_nft_inventory (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  open_id TEXT REFERENCES gacha_pack_opens(id),
  mint TEXT NOT NULL UNIQUE, custody_pubkey TEXT NOT NULL,            -- the dedicated-path wallet
  name TEXT, grade TEXT, set_name TEXT, year TEXT, image_url TEXT,
  insured_value_e6 BIGINT, market_id TEXT REFERENCES markets(id),     -- matched GDEX market (often NULL)
  status TEXT NOT NULL DEFAULT 'held',                               -- held|sold|withdrawing|withdrawn
  sell_value_e6 BIGINT, sell_cut_e6 BIGINT, txn_id TEXT,
  withdraw_dest TEXT, withdraw_sig TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(), settled_at TIMESTAMPTZ
);
CREATE INDEX idx_gacha_inventory_user ON gacha_nft_inventory(user_id, status);
-- Loyalty Tokens (1 Token = $0.001). Separate from the USDC ledger and from $GDEX.
CREATE TABLE token_balances ( user_id TEXT PRIMARY KEY REFERENCES users(id), balance BIGINT NOT NULL DEFAULT 0 );
CREATE TABLE token_ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  delta BIGINT NOT NULL, reason TEXT NOT NULL,                       -- PACK_OPEN_EARN|GDEX_HOLD_EARN|TRADE_EARN|LP_EARN|PACK_BUY_TOKENS
  ref_type TEXT, ref_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_token_ledger_user ON token_ledger(user_id, created_at DESC);
```
New USDC ledger account: **`GACHA_REWARDS_BUDGET`** (funds token-bought packs). Machines/cards read live from CC
(cache ~15–60s), not persisted.

## 8. Backend modules

- `services/providers/collectorcrypt.ts` — CC client (`getMachines`/`getNfts`/`getAllWinners`/`generatePack`/
  `submitTransaction`/`openPack`/`getPackStatus`/`buyback`/`buybackAvailable`); 15s timeout; **2 retries on
  idempotent GETs, 0 retries on paying mutations (`generatePack`/`submitTransaction`) — never double-pay**;
  `openPack` is idempotent so it retries on `WAITING_FOR_WEBHOOK`; `$ → micro-USDC` on the way in.
- `services/custody/gacha-chain.ts` — **port of rare.win `signBase64Tx`** (versioned + legacy) + `broadcast` +
  `sigStatus`; the per-user dedicated-path keypair derivation + JIT funding; and **`transferNft(fromKeypair, mint,
  dest)`** — Metaplex **Core** transfer: mpl-core `transferV1` built via umi → `toWeb3JsInstruction` → the same
  web3.js tx (hot fee-payer + custody signer); the collection comes from a DAS `getAssetTransferInfo`
  (services/das.ts). Ported from rare.win's proven `lib/nftTransfer.ts`.
- `services/das.ts` — Helius DAS `getAsset`/`getAssetsByOwner` (net-new; needs a DAS-capable RPC, e.g. Helius —
  GDEX's deposit scanner uses plain RPC today, so this is new infra, not just code).
- `services/gacha.ts` — orchestration: `openPack`, `sellBack`, `requestNftWithdraw`, `convert`, `listInventory`,
  `reconcilePending`. Idempotent on `(user_id, idempotency_key)` + `cc_memo`; receipt-before-payment.
- `services/gacha-config.ts` — knobs (§13).

## 9. Flows

**Open** (`POST /gacha/open {machineCode, idempotencyKey, payWith:'usdc'|'tokens', expectedPriceE6, turbo?}`):
1. Gate flag + auth (`trade` scope) + rate limit. `INSERT gacha_pack_opens(... status=pending)`
   `ON CONFLICT (user_id, idempotency_key) DO NOTHING` → dup returns the stored result.
2. Read the live machine price (authoritative). If it drifted beyond a small tolerance from `expectedPriceE6`,
   reject with the new price (no surprise charge). **No cached-stock pre-check** — `generatePack` (step 4) is the
   authoritative real-time stock gate; a snapshot stock field is staler and would only false-block a valid open
   after a restock.
3. **Charge by `payWith`:** `usdc` → check `USER_COLLATERAL ≥ price`, post `GACHA_PACK_BUY`. `tokens` → check
   `TOKENS_ENABLED`, debit `token_balances ≥ tokenPrice` (`FOR UPDATE`), post `PACK_BUY_TOKENS_FUND`
   (`GACHA_REWARDS_BUDGET -price / TREASURY_USDC +price`). Set `status=paid`.
4. JIT-fund the user NFT-custody wallet from the hot wallet (skip if `altPlayerAddress` is confirmed). Build the
   CC payment via `generatePack` **fresh, immediately before submit (never cache/reuse a built tx — a stale tx
   submitted after the machine emptied pays for nothing)**; map CC's "sold out / machine empty" error → a
   **`409 "sold out — no funds taken"`** (reachable only here, pre-payment, since `generatePack` runs before the
   never-throwing pay step). Store `cc_memo`, sign with the user keypair → `submitTransaction` → store
   `payment_sig`. *(Residual: stock depleting between this fresh generate and submit → pay-and-fail → handled by
   the reconciler + CC refund in step 7, not a pre-check.)*
5. `openPack(memo)` + retry loop. Branch on the **buyback signal**, not the requested turbo flag:
   - returns an `nft_address` (kept — incl. a turbo Rare/Epic): DAS-enrich, `INSERT gacha_nft_inventory(...)`
     **`ON CONFLICT (mint) DO NOTHING`** (idempotent vs concurrent reveal), `status=opened`.
   - `code=TURBO_MODE_BUYBACK` / `buybackAmount` set (turbo Common auto-sold): no NFT; credit the user
     `buybackAmount` **minus the 10% turbo cut** (`GACHA_SELLBACK` split, FEE_REVENUE takes 10%); `status=turbo_sold`,
     store `turbo_refund_e6`.
6. Still `WAITING_FOR_WEBHOOK` after retries → leave `paid` for the reconciler.
7. **Reconciler** (`reconcilePending`; `POST /gacha/reconcile` + fire-and-forget on lobby load): re-`openPack` each
   `paid` row; after 90s grace, `getPackStatus` → `refunded` (post `GACHA_REFUND`) or `failed` (only if **no
   `payment_sig`**; post `GACHA_REFUND` since step-3 debited). Never auto-fail a row with a `payment_sig`.

**Sell back** (`POST /gacha/prizes/:id/sell-back`): pre-quote via `buybackAvailable`; if `available=false` (expired
72h window / delisted) disable sell-back + convert, leave Withdraw as the only exit. Else lock the inventory row
(`held`), `buyback({playerAddress: userCustody, nftAddress, altRecipient: hotWallet})` → sign with the user
keypair → submit; on confirm, post the 5%/10% split on the **received** B, `status=sold`.

**Withdraw** (`POST /gacha/prizes/:id/withdraw {dest, stepUpSig}`): GDEX has **no saved withdraw address** — the
dest is **per-request, with a fresh step-up wallet signature over `(mint, dest)`**, mirroring the USDC withdrawal
path (+ the same freeze/limits checks). `held→withdrawing`; `transferNft(userCustody, mint, dest)`; persist sig
before broadcast; on confirm `status=withdrawn`; recover in-flight on boot.

**Convert** (`POST /gacha/prizes/:id/convert`) — **two async stages, not atomic** (`openPosition(db)` opens its own
tx + market lock, so it cannot nest in the sell-back tx, and sell-back waits on the CC buyback): (1) run the normal
sell-back → proceeds settle to `USER_COLLATERAL`; (2) *then* a separate `openPosition` on the card's market with the
proceeds. **Only available when `market_id` is non-null** (see §15 reach caveat) — otherwise the button is hidden.

**Trade** — link to the `markets` row in `nft_inventory.market_id` (hidden when null).

## 10. Fairness

CC **documents** a VRF over the payment tx signature (ECVRF-SECP256K1, `/api/vrf/verify?memo=`) per its docs —
but rare.win's *code* never exercises it (it just opens by memo). So: **confirm `/api/vrf/verify` is live before
promising a "Verify rip" link**; if it is, surface it; if not, state plainly that fairness is CC's. Note: under the
primary custody model the payment is signed by GDEX's per-user keypair (not the end-user's personal wallet), so any
"your signature" framing is inaccurate — describe it as "CC-provided, verifiable" only. We do **not** run a GDEX
draw here (that's Pack Rip).

## 11. API surface (GDEX)

```
GET  /gacha/machines                  -> [{code,name,game,priceE6,tokenPriceE3,buybackPct,bigWinPct,tiers:[{label,color,minE6,maxE6,pct}],stock,image}]
GET  /gacha/machines/:code/cards      -> [{mint,name,grade,imageUrl,valueE6,rarity}]            (?page,?rarity)
GET  /gacha/winners?count             -> recent winners feed
POST /gacha/open {machineCode,idempotencyKey,payWith,expectedPriceE6,turbo?} -> {openId,status,card?}  (auth, trade, rate-limited)
GET  /gacha/opens/:id                 -> {status, card?}                       (poll for async reveal)
POST /gacha/reconcile                 -> {recovered}                           (fire-and-forget on lobby load)
GET  /gacha/inventory                 -> [{id,mint,name,grade,imageUrl,insuredValueE6,marketId,status}]
POST /gacha/prizes/:id/sell-back      -> {payoutE6,cutE6}                       (quote via ?quote=1; 409 if buyback unavailable)
POST /gacha/prizes/:id/withdraw {dest,stepUpSig} -> {status, sig?}
POST /gacha/prizes/:id/convert        -> 2-stage sell-back→open perp           (409 if market_id null)
GET  /tokens/balance                  -> {balance, perUsd:0.001, untilFreePackTokens}
GET  /tokens/history                  -> token_ledger rows
```

## 12. Web UI (GDEX-styled)

- **Games page:** a **"Classic Gacha"** card → the lobby.
- **Lobby** (`ClassicGacha.jsx`): category tabs (from machine `game`); a horizontal **machine strip**; a
  **machine panel** (CC artwork, name, price + **Pay with: USDC/Tokens** toggle, **Turbo** toggle, **Rip**, the
  tier legend 🟡/🟢/🔵/🔴 + "Instant buyback X%" + "Big win Y%"); the **cards-in-machine grid** (`getNfts`: image,
  grade badge, value); the **Token balance + "until next free pack" bar**; reuse the live winners feed + chat.
- **Rip + reveal:** GDEX-styled rip → reveal modal with the slab + actions: **Sell back** (net after 5%),
  **Instant sell** (10%), **Withdraw**, **Convert** / **Trade** (*shown only when the card has a GDEX market*),
  and a "Verify rip" link *(only if §10 confirms the endpoint)*.
- **Portfolio → Inventory:** held NFTs (image/grade/value/status) with per-row Sell back / Withdraw / Convert.
  Withdraw collects a dest + triggers the step-up signature.

**Admin (Games config tab):** adjust the **free-pack threshold** (`gacha_free_pack_threshold_usd`, default $1000),
the cut %s, the optional markup, and per-machine enable — plus a **monitoring readout**: cut revenue vs Token-rebate
cost and the live **sell-back rate**, so the operator can watch the §6 net (break-even ≈ 57%) and turn the markup
on if sell-back drops.

Visual: GDEX retro/arcade skin + cyan/violet/pink brand; not a pixel clone of CC.

## 13. Config / env

- `COLLECTORCRYPT_GACHA_URL` (default mainnet), `CC_ENV` (dev|main), optional `COLLECTORCRYPT_API_KEY`.
- `HELIUS_DAS_URL` (**new infra** — a DAS-capable RPC for `getAsset`).
- **NFT custody: a dedicated, un-swept derivation path** (mandatory, §5) — `m/44'/501'/{index}'/1'` from
  `DEPOSIT_MASTER_SEED`, excluded from `scanDeposits`.
- Knobs: `CLASSIC_GACHA_ENABLED` (off), `gacha_buyback_cut_bps`=500, `gacha_turbo_cut_bps`=1000, `gacha_markup_bps`
  (default 0, **optional — not required**). **Tokens:** `TOKENS_ENABLED` (off), **`gacha_free_pack_threshold_usd`=1000
  (admin-adjustable — $ of pack spend per free $25 pack; derives the earn rate)**, `token_unit_usd_thou`=1
  (1 Token=$0.001), `token_earn_gdex_per_day`, `token_earn_per_fee_usd`, `token_earn_lp_per_day_per_usd`,
  per-account daily earn cap. All editable in the admin panel.

## 14. Build phasing

- **P0 — Read-only lobby.** CC client + lobby UI (machines, tier legends, cards grid, winners). No buying. Flag off.
  *(Branch resolved — the Games surface is on master; build on `development`, §15.)*
- **P1 — Buy → open → sell-back (core loop, USDC only).** Dedicated NFT-custody path + JIT funding + the
  `signBase64Tx` port; two-phase open + reconciler + the refund/fail reversal; idempotent inventory; 5%/10%
  sell-back via `altRecipient`→hot; reveal modal. **No NFT leaves custody. Confirm CC mainnet + `altPlayerAddress`
  on a tiny live test here.**
- **P2 — Withdraw the real NFT (BUILT).** The MPL **Core** `transferNft` (mpl-core/umi `transferV1` hybrid → web3.js
  + a DAS `getAssetTransferInfo` for the collection) + per-request dest + step-up. Deps: `@metaplex-foundation/mpl-core`
  + `umi` + `umi-bundle-defaults` + `umi-web3js-adapters`.
- **P3 — Funnel + polish.** Turbo, Instant sell, **Convert (2-stage, market-gated)**, the card→market matching
  (best-effort — see §15), "Verify rip" (if §10 confirms), winners-feed richness.
- **P4 — Tokens loyalty (own track, `TOKENS_ENABLED` off; markup optional + monitored).** Token ledger + earn hooks +
  pay-with-Tokens + the free-pack progress UI + the `Σ token_ledger == token_balances` reconciler.

## 15. Risks & open decisions

1. **`altPlayerAddress` unverified** — the convenience of paying from the hot wallet without JIT funding depends on
   it; the spec works either way (JIT primary). Confirm on the live test (§2.6).
2. **NFT transfer-out (P2)** — CC cards are Metaplex **Core** (`MplCoreAsset`, verified on live mints), transferred
   via mpl-core `transferV1` (hybrid → web3.js), ported from rare.win's `nftTransfer.ts`. A wrong transfer on a
   real slab is unrecoverable → verify on the live test.
3. **CC on the critical path** — reconciler + receipt-before-payment + `payment_sig`-gating are mandatory.
   Add a CC-failure matrix at build (each call's failure → recovery; DAS-down → record the NFT with null metadata,
   back-fill later).
4. **Convert/Trade reach (lever C honesty)** — they need a matching GDEX market, but GDEX features ~250 cards/game
   (`UNIVERSE_TOP_N`) gated by a price-confidence check, and GDEX keys markets by `game:providerCardId`, not
   fuzzy name/set. So a random CC slab matches only **occasionally** — lever C fires on a *minority* of wins;
   don't over-count the perp-funnel revenue. Specify the matching as best-effort.
5. **Held-forever custody** — a `held` NFT can sit in GDEX custody indefinitely (real asset, unlike Pack Rip's
   synthetic prize). v1: indefinite custody expected + tracked; add an account-closure/abandonment policy note.
   Treasury reporting tracks NFT inventory separately from USDC PoR.
6. **KYC / gambling / jurisdiction** — real-money gacha on real assets. Reuse GDEX geofence/restrictions; specialist
   advice (per rare.win/docs/backend-plan.md). 
7. **Funding** — at the operator's expected ~90% sell-back (CC data) the cut funds the rebate (~+$15/$1,000);
   **break-even ≈ 57% sell-back**, so **no markup for now**. Monitor the live net (admin readout); turn on
   `gacha_markup_bps` only if the sell-back rate drifts toward break-even.
8. **Build branch — RESOLVED (2026-06-24):** the `game` branch was merged to master (`07e63ef`), so the Games
   surface (Pack Rip, `game-fairness`, `GAME_POOL`, `GAMES_ENABLED`) is now on **master / `development`**. Build
   Classic Gacha on `development` directly, as a Pack Rip sibling — no separate worktree needed. P0 is unblocked.
9. **Sell-back basis** — CC's buyback amount, not the GDEX oracle (so unmatched cards can still be sold back; only
   Trade/Convert need a market).

## 16. Money-safety invariants (for QA when built)

- PoR balanced after buy, refund, sell-back (on-chain Δ == liability Δ); in-flight `paid` buys reserved by the sweeper.
- Open idempotent on `(user_id, idempotency_key)` + `cc_memo`; inventory INSERT `ON CONFLICT (mint) DO NOTHING`.
- Every `failed`/`refunded` buy posts exactly one `GACHA_REFUND` (idempotent on `open_id`); no silent loss of P.
- A row with `payment_sig` is never auto-failed.
- Stock is gated by the live `generatePack` call (no cached pre-check); the payment tx is generated **fresh
  immediately before submit** and never reused; "sold out" → a no-funds-taken 409. Paying mutations
  (`generatePack`/`submitTransaction`) use **0 retries**; only the idempotent `openPack` retries.
- Sell-back/withdraw/convert lock the inventory row `FOR UPDATE`, check `status='held'`; sell-back settles on the
  **received** B; the 5%/10% split floors the user share.
- pNFT transfer-out persists the sig before broadcast; recovers in-flight on boot.
- Token-bought packs debit `token_balances` (`FOR UPDATE`, never negative) + book `GACHA_REWARDS_BUDGET -price /
  TREASURY_USDC +price`; no `USER_COLLATERAL` debit; Tokens earned only on **paid** opens; reconciler enforces
  `Σ token_ledger == token_balances`; Tokens non-transferable.

## 17. Buy latency — the JIT-fund step + how to streamline it

Because GDEX holds the player's USDC in the **off-chain ledger** (it's a perps exchange), a buy can't pay CC
directly — it must **JIT-fund a per-user custody wallet** (hot wallet → custody) and *then* have the custody
wallet pay CC. That extra on-chain funding tx is what makes our pre-reveal wait longer than a thin client
(collectorroll / Collector Crypt) that pays from a **pre-funded custodial wallet** in one tx.

**Applied (2026-06-26):** `fundCustody` (and `transferNft`) confirm to **`'confirmed'`** (~1-2s), not
`'finalized'` (~13s on mainnet) — the funding only needs to be spendable by the immediately-following CC
payment, which `'confirmed'` state satisfies. A rare confirmed-then-dropped funding tx just fails the CC
payment's preflight → the open refunds via the reconciler (no money risk). This took the pre-reveal wait
from **~10s → ~3s**. Also tightened the web reveal-poll (2s→1s) and the inline reveal-retry gap (1.5s→1s).
Applied the same `'confirmed'` to `transferNft` (withdrawals).

**Residual (documented, not fixed — standard `'confirmed'` property):** `fundCustody`'s reorg is self-healing
(a dropped funding tx makes the CC payment fail → the reconciler catches it). `transferNft` has no downstream
observer, so a confirmed-then-reorged withdraw would leave the row `'withdrawn'` while the NFT is back in
custody, and `reconcileStuckPrizes` only scans `'selling'`/`'withdrawing'`. A supermajority-block reorg is
near-impossible on mainnet (no Solana app finalizes before crediting), so this is accepted as standard.
**Optional belt-and-suspenders:** have the reconciler also DAS-check *recent* `'withdrawn'` rows and revert to
`'held'` if the NFT is somehow still in custody.

**Future options to reach ~1-2s parity (not done — bigger changes):**
1. **Eliminate the JIT-fund** by paying CC **directly from the hot wallet** with the won NFT routed to the
   user's custody wallet via CC's `altPlayerAddress` (payer ≠ recipient). One tx instead of two. Needs the
   `altPlayerAddress` behaviour verified live (it's currently demoted to a live-test optimization).
2. **Pre-fund per-user custody wallets** (keep a working USDC float in each) so a buy is a single custody→CC
   payment with no funding hop. Capital-inefficient + adds float-management/PoR complexity.
3. **Overlap** the funding with `generatePack`, and/or submit the fund + pay back-to-back without waiting for
   the fund to confirm (riskier — the pay can fail preflight if the fund hasn't landed).
