# Classic Gacha — real-funds test runbook

How to validate the on-chain Classic Gacha flows (buy → reveal → sell-back → withdraw → convert →
earn Gold → claim) **before** turning it on for customers. The logic (money/idempotency/state-machine)
is covered by 457 unit tests with **faked** chain + CC; this runbook covers the parts those fakes can't:
the **live Collector Crypt + Solana** integration.

## The strategy: devnet first (free), then a tiny mainnet pass

You do **not** need real money to test the on-chain integration. Run `REAL_FUNDS=true` pointed at **CC
devnet + Solana devnet** — same code paths, free devnet SOL/USDC. The boot guard explicitly allows this
(`config.ts`: *"Devnet/testnet runs need no override"*); the `ALLOW_MAINNET_FUNDS` gate only trips on a
mainnet RPC or the mainnet USDC mint.

| Stage | Network | Funds | Gate |
|---|---|---|---|
| **1 — devnet** | CC devnet + Solana devnet | free (faucets) | `REAL_FUNDS=true` only |
| **2 — mainnet smoke** | CC main + Solana main | tiny real ($25) | `REAL_FUNDS=true` **+ `ALLOW_MAINNET_FUNDS=true`** (after audit/KYC/geofence) |
| **3 — calibrate + open** | mainnet | real | flip `CLASSIC_GACHA_ENABLED` for customers |

Confirmed at write time: CC devnet is live (`GET https://dev-gacha.collectorcrypt.com/api/machines` → 200,
real machines), and the `solana` CLI is available for keypair gen + devnet SOL airdrops.

---

## Stage 1 — devnet end-to-end

### 1a. Prerequisites you must provide

- **A DAS-capable devnet RPC** (e.g. a free Helius devnet key) → `HELIUS_DAS_URL`. Needed for `getAsset`
  (the withdraw transfer + the stuck-row reconciler). A plain devnet RPC does **not** support DAS.
- **Devnet USDC of the mint CC devnet expects.** Inspect a `generatePack` response (or ask CC) for the
  payment mint, then acquire that devnet SPL token. If CC uses a non-standard devnet mint you may need
  their faucet.
- **A test wallet** (Phantom/Backpack set to devnet) to sign in to the site and drive the customer flows,
  funded with devnet SOL + the devnet USDC above (deposit into the app to get play→real collateral).

### 1b. Generate + fund the operator keypairs (one-time)

```bash
solana config set --url https://api.devnet.solana.com
solana-keygen new -o hot.json --no-bip39-passphrase          # the hot wallet (pays CC + gas)
solana airdrop 2 $(solana-keygen pubkey hot.json)            # devnet SOL for gas (repeat if rate-limited)
# fund hot.json with devnet USDC (CC's mint) — this is the float that pays CC on a buy
solana-keygen new -o treasury.json --no-bip39-passphrase     # cold treasury (PoR anchor)
```
`DEPOSIT_MASTER_SEED` = any 64-hex string (devnet; pure-crypto derivation, no real value).

### 1c. Boot the API in devnet real-funds mode

```bash
REAL_FUNDS=true \
CLASSIC_GACHA_ENABLED=true \
CC_ENV=dev \
SOLANA_RPC_URL=https://api.devnet.solana.com \
HELIUS_DAS_URL=<your devnet DAS url> \
USDC_MINT=<CC devnet USDC mint> \
TREASURY_PUBKEY=$(solana-keygen pubkey treasury.json) \
HOT_WALLET_SECRET=<base58/json of hot.json> \
DEPOSIT_MASTER_SEED=<64 hex> \
ADMIN_API_KEY=<≥32 chars> \
pnpm --filter @pokex/api dev
```
Boot must NOT throw `REAL_FUNDS=true requires custody config; missing: …`. `/health` should show
`realFunds:true`, `classicGachaEnabled:true`.

### 1d. Run each flow + verify (per flow: on-chain AND ledger)

Sign in with the test wallet, deposit devnet USDC, then:

**Buy / open (USDC)** — open a pack in the lobby.
- On-chain: hot wallet JIT-funds the user's custody wallet (devnet SOL + USDC); CC `generatePack` → sign →
  `submitTransaction` lands the USDC payment to CC; CC's VRF reveals + **delivers a real (devnet) graded
  NFT** to the custody wallet. ⚠️ check the reveal carries **image / grade / insured-value** (not thin —
  if thin, the DAS-enrich follow-up is needed).
- Ledger: `USER_COLLATERAL −price`, `TREASURY_USDC +price` (+`FEE_REVENUE +markup` if markup on). Row in
  `gacha_pack_opens` status `opened`, with `payment_sig` + `cc_memo`. Verify the VRF link
  (`/api/vrf/verify?memo=…`).

**Earn Gold** — the same USDC open.
- `gold_ledger` gets a `PACK_OPEN_EARN` row; `gold_balances` increases. The vault reflects it (master on).

**Sell-back** — sell a held card.
- ⚠️ **The unverified assumption:** CC buyback USDC must land in the **hot wallet via `altRecipient`** (NOT
  a scanned deposit address). Confirm on the explorer.
- Ledger: `USER_COLLATERAL +payout` (95% / after cut), `FEE_REVENUE +cut`, `TREASURY_USDC −gross`. DAS:
  the NFT's owner is now CC (left custody). Row → `sold`.

**Withdraw** — withdraw a held NFT to an external devnet wallet.
- ⚠️ **Greenfield path:** MPL Core `transferV1` moves the slab out; the hot wallet pays gas. Verify via DAS
  the NFT's new owner is the dest. Row → `withdrawn`, `withdraw_sig` set.

**Convert** — convert a held card (needs a matched market).
- Sell-back (as above) **then** `openPosition`: proceeds settle to `USER_COLLATERAL`, then a perp opens
  on the card's market (margin locked). 409 `no_market` if the card isn't a tradeable market.

**Claim a free pack** — with ≥25,000 Gold (admin master on; pay-with-Gold may be off).
- Gold-bought $25 pack: `GACHA_REWARDS_BUDGET −price → TREASURY_USDC +price`; `gold_balances −25,000` +
  `gold_ledger PACK_BUY_GOLD`. CC delivers the NFT as usual.

**Reconciler** — kill the API during a sell-back (between the buyback and the settle), restart.
- Boot/admin reconcile (`/admin/gacha/reconcile-stuck`) reads the NFT's DAS owner and resolves the
  `selling`/`withdrawing` row (released to `held`, or marked `withdrawn`, or flagged for a manual credit).

### 1e. Invariants to assert after the run
- `Σ ledger_entries.amount_uusdc == 0` (global double-entry).
- On-chain hot+treasury USDC `≥ |TREASURY_USDC|` (proof of reserves).
- `Σ gold_ledger.delta == gold_balances.balance` per user.
- No `gacha_pack_opens` stuck in `paid`/`pending`; no inventory stuck in `selling`/`withdrawing`.

---

## Stage 2 — mainnet smoke (the real-money test)

Identical flows, deltas only:
- `CC_ENV=main`, `SOLANA_RPC_URL=<mainnet>`, `USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`,
  a **real funded hot wallet** (SOL + a small USDC float), `ALLOW_MAINNET_FUNDS=true` (only after the
  audit + KYC/AML + geofence gates).
- Operator + 1–2 internal wallets, **a single $25 pack**, Gold + pay-with-Gold **OFF** so you validate the
  core CC flow in isolation first. Then a sell-back, a withdraw, and one of each remaining flow.
- Watch the two never-run-live pieces: the buyback `altRecipient` and the MPL Core withdraw.

## Stage 3 — calibrate + open
- Read the real per-machine `ev` / `instantBuyback` / sell-back behaviour from the monitoring tab.
- Pre-fund `GACHA_REWARDS_BUDGET` before enabling Gold spend; set the cut/markup/free-pack-threshold knobs.
- Merge `development` → master, flip `CLASSIC_GACHA_ENABLED` (and `GOLD_ENABLED` / pay-with-Gold when ready).

## Rollback / kill switches
- `CLASSIC_GACHA_ENABLED=false` → the whole surface 404s (lobby + buy/sell/withdraw).
- Master **Gold** off (admin) → Gold hidden; pay-with-Gold off → USDC-only.
- Per-machine disable (admin) → hide a machine from the lobby.
- A stuck pack: `/admin/gacha/reconcile-stuck`. A `paid` open self-heals via `/gacha/reconcile` + the
  `GACHA_REFUND` path.

## Known unknowns (validate explicitly)
1. CC **devnet** delivers a real NFT + accepts the payment mint end-to-end (reads confirmed; full cycle not).
2. CC honors the buyback **`altRecipient`** (→ hot wallet).
3. The **MPL Core `transferV1`** withdraw on a live CC card (new dep; never run live).
4. The reveal payload carries image/grade/insured-value (else port rare.win's DAS enrichment).
