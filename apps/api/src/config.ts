import 'dotenv/config';

/**
 * Central runtime config. Everything secret lives here and is read from the
 * environment — never hardcoded, never shipped to the browser. (The old SPA
 * leaked a pokemontcg.io key in client code; the api owns it now.)
 */
function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

/** ORACLE_PRIMARY: which price feed drives the oracle. Fails fast on a typo. `scrydex` = Scrydex-primary
 *  pricing (docs/scrydex-pricing-build-spec.md): Scrydex sets the TCGplayer price, tcgpl runs alongside
 *  for the eBay/cross-feed confidence checks. */
function oraclePrimary(): 'pokemontcg' | 'tcgpricelookup' | 'scrydex' {
  const v = process.env.ORACLE_PRIMARY ?? 'pokemontcg';
  if (v !== 'pokemontcg' && v !== 'tcgpricelookup' && v !== 'scrydex') {
    throw new Error(`ORACLE_PRIMARY must be 'pokemontcg', 'tcgpricelookup', or 'scrydex', got '${v}'`);
  }
  return v;
}

const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 4000),
  host: process.env.HOST ?? '0.0.0.0',

  // CORS: the Vercel-hosted web origin(s) allowed to call this api.
  webOrigins: (process.env.WEB_ORIGINS ?? 'http://localhost:5173,http://localhost:4173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Rate limiting (per client IP). A global ceiling plus tighter per-route caps on the abuse-prone
  // write/auth endpoints. RATE_LIMIT_DISABLED=true turns it off (used by HTTP tests).
  rateLimitMax: num('RATE_LIMIT_MAX', 120), // global default: requests per window per IP
  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitDisabled: process.env.RATE_LIMIT_DISABLED === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true', // true behind Vercel/Render/Fly so client IPs are real
  // Per-route caps (requests per window per IP) — kept here so every security-relevant limit is
  // visible + tunable in one place (routes reference these via the `rl()` helper in routes/_ratelimit.ts).
  routeRateLimits: {
    authNonce: num('RL_AUTH_NONCE', 30),
    authVerify: num('RL_AUTH_VERIFY', 30),
    authRefresh: num('RL_AUTH_REFRESH', 60),
    faucet: num('RL_FAUCET', 10),
    chatPost: num('RL_CHAT', 20),
    username: num('RL_USERNAME', 15),
    referralRedeem: num('RL_REFERRAL_REDEEM', 10),
    referralCode: num('RL_REFERRAL_CODE', 15), // the "taken?" pre-check is an enumeration oracle
    withdraw: num('RL_WITHDRAW', 10),
    withdrawNonce: num('RL_WITHDRAW_NONCE', 20),
    delegateNonce: num('RL_DELEGATE_NONCE', 30), // trading-key delegation challenge (mirrors authNonce)
    delegateVerify: num('RL_DELEGATE_VERIFY', 30), // delegation authorization submit
    admin: num('RL_ADMIN', 30), // operator endpoints (also brute-force defense on the admin key)
    catalogSearch: num('RL_CATALOG_SEARCH', 30), // each uncached search costs a provider request
    marketEnsure: num('RL_MARKET_ENSURE', 10), // on-demand listing: provider request + market create
    imageProxy: num('RL_IMAGE_PROXY', 120), // same-origin re-serve of whitelisted CDN images (for the share card)
    gamePlay: num('RL_GAME_PLAY', 30), // games wager endpoints (pack rip open / sell-back)
    gameFairness: num('RL_GAME_FAIRNESS', 30), // provably-fair panel reads + client-seed rotation
  },

  // Database. Empty => use embedded PGlite (local dev, zero deps).
  // In prod set DATABASE_URL to a managed Postgres (Neon/Supabase).
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgliteDir: process.env.PGLITE_DIR ?? './.pglite',

  // Auth
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
  accessTtlSec: num('ACCESS_TTL_SEC', 15 * 60),
  refreshTtlSec: num('REFRESH_TTL_SEC', 7 * 24 * 60 * 60),
  authDomain: process.env.AUTH_DOMAIN ?? 'localhost',
  // Delegated trading keys (docs/cli-spec.md Part 1). Cap active keys per account and bound their
  // validity (dYdX/Hyperliquid bound agent-key lifetime rather than allowing "never").
  maxDelegatedKeys: num('MAX_DELEGATED_KEYS', 4),
  delegateMaxTtlMs: num('DELEGATE_MAX_TTL_DAYS', 180) * 24 * 60 * 60 * 1000,

  // Price source (server-side only)
  pokemontcgApiKey: process.env.POKEMONTCG_API_KEY ?? '', // optional; keyless works
  pokemontcgBase: 'https://api.pokemontcg.io/v2',
  oracleRefreshMs: num('ORACLE_REFRESH_MS', 6 * 60 * 60 * 1000), // 6h; source updates ~daily
  oraclePageSize: num('ORACLE_PAGE_SIZE', 250), // pokemontcg.io v2 caps pageSize at 250 (clamps silently); >250 is a no-op
  // Which feed drives the oracle (tcgpricelookup migration). Cutover/rollback = flip this env var, no
  // deploy. Validated here so a typo fails the boot loudly instead of silently never cutting over.
  oraclePrimary: oraclePrimary(),

  // JustTCG graded (PSA-10) pricing — server-side, optional. When set, the Graded index
  // becomes tradeable; without it, Graded stays gated.
  justtcgApiKey: process.env.JUSTTCG_API_KEY ?? '',
  justtcgBase: process.env.JUSTTCG_BASE ?? 'https://api.justtcg.com',
  gradedConstituents: num('GRADED_CONSTITUENTS', 100), // top-N cards for the Graded index

  // tcgpricelookup (Trader plan) — the multi-game raw+graded provider (docs/data-providers.md).
  // Hard limits verified live: 1 req/s (burst 1), 10k req/day. The DB-backed limiter enforces both
  // GLOBALLY (across instances); override the pacing only if the plan tier changes.
  tcgpricelookupApiKey: process.env.TCGPRICELOOKUP_API_KEY ?? '',
  tcgpricelookupBase: process.env.TCGPRICELOOKUP_BASE ?? 'https://api.tcgpricelookup.com/v1',
  tcgpricelookupMinIntervalMs: num('TCGPRICELOOKUP_MIN_INTERVAL_MS', 1100), // 1 req/s + 10% headroom
  tcgpricelookupDailyCap: num('TCGPRICELOOKUP_DAILY_CAP', 10_000),

  // Scrydex (Growth plan) — primary raw source under ORACLE_PRIMARY=scrydex (docs/scrydex-pricing-build-spec.md).
  // Price = TCGplayer market; tcgpl runs alongside for the eBay/cross-feed confidence checks. 100 req/s,
  // credit-metered (batch ≤100 cards/req); webhooks are the primary update path.
  scrydexApiKey: process.env.SCRYDEX_API_KEY ?? '',
  scrydexTeamId: process.env.SCRYDEX_TEAM_ID ?? '',
  scrydexBase: process.env.SCRYDEX_BASE ?? 'https://api.scrydex.com',
  scrydexWebhookSecret: process.env.SCRYDEX_WEBHOOK_SECRET ?? '', // whsec_… for HMAC-SHA256 verification
  scrydexMinIntervalMs: num('SCRYDEX_MIN_INTERVAL_MS', 50), // 100 req/s cap → 20/s with headroom
  scrydexDailyCap: num('SCRYDEX_DAILY_CAP', 1600), // ~50k credits/mo ÷ 30 (a guard; overage just bills)
  // FX for JP-only cards (Frankfurter, free/no key) — JPY→USD per decision #3.
  fxBase: process.env.FX_BASE ?? 'https://api.frankfurter.dev',
  discoveryIntervalMs: num('DISCOVERY_INTERVAL_MS', 7 * 24 * 60 * 60 * 1000), // weekly featured rebalance (post-cutover loop)
  // Search-and-bet (P6): catalog search proxy + on-demand market creation. Endpoints only register
  // when the tcgpricelookup feed is live; SEARCH_AND_BET=false turns them off without a deploy.
  searchAndBet: process.env.SEARCH_AND_BET !== 'false',
  retireAfterDays: num('RETIRE_AFTER_DAYS', 30), // dead long-tail markets (no OI, no volume) leave the refresh set

  // Money / safety
  realFunds: process.env.REAL_FUNDS === 'true', // hard gate; MVP must be false
  faucetDefaultUsd: num('FAUCET_DEFAULT_USD', 10_000),
  referralBonusUsd: num('REFERRAL_BONUS_USD', 1_000), // play-USDC bonus per redeemed referral (both parties); 0 disables
  maxReferralsPaid: num('MAX_REFERRALS_PAID', 50), // referrer is only paid a bonus for their first N referrals (anti-farming)

  // Trading commission (basis points of notional; 1 bps = 0.01%), charged on BOTH open and close.
  // Default 0 = no fee. This is the env-set DEFAULT; it's live-editable from the admin panel —
  // services/fees.ts overlays an operator override on top (shown as "Commission" in tx history).
  feeBps: num('FEE_BPS', 0),
  feeLpSharePct: num('FEE_LP_SHARE_PCT', 50), // % of fees that go to LPs (rest to platform revenue)

  // Chat action bars: broadcast a BIG BET when an open's notional >= this (USD) and a BIG WIN when a
  // close's realized profit >= this (USD). Live-tunable via settings (see chat-config.ts).
  chatBigBetUsd: num('CHAT_BIG_BET_USD', 500),
  chatBigWinUsd: num('CHAT_BIG_WIN_USD', 100),

  // DROP timed giveaway (docs/chat-social-spec.md F6). Defaults; live-tunable via the admin CHAT view
  // (see drop-config.ts). Phase 1 only persists these knobs + shows the pot bucket — the round worker
  // that consumes them is Phase 2.
  dropIntervalMin: num('DROP_INTERVAL_MIN', 60), // minutes between drops
  dropHouseFloorUsd: num('DROP_HOUSE_FLOOR_USD', 250), // house contribution floor per round (USD)
  dropGdexMin: num('DROP_GDEX_MIN', 500_000), // $GDEX held that grants eligibility (token units)
  // DROP pot tips (Phase 2a). Players contribute real USDC to the pot. OFF by default — a flag so the pot
  // can't take real money on prod until the draw/payout mechanic is live and the operator opts in.
  dropTipsEnabled: process.env.DROP_TIPS_ENABLED === 'true',
  dropTipMinUsd: num('DROP_TIP_MIN_USD', 1), // smallest single tip (USD)
  dropTipMaxUsd: num('DROP_TIP_MAX_USD', 10_000), // fat-finger cap on a single tip (USD)

  // Games surface (docs/games-spec.md). Master gate, OFF by default — real-money wagering rides above
  // the existing ALLOW_MAINNET_FUNDS gate. Per-game toggles live in the admin Games view (game-config.ts);
  // this env flag is the kill switch that hides + disables the whole surface until the operator opts in.
  gamesEnabled: process.env.GAMES_ENABLED === 'true',

  // Classic Gacha (docs/classic-gacha-cc-packs-spec.md) — real Collector Crypt graded-card packs as a Games
  // surface, coexisting with the synthetic Pack Rip. P0 is a read-only lobby proxying CC's gacha API. OFF by
  // default; the web hides the entry until this flips (exposed on /health). CC's gacha reads need no key
  // (x-api-key optional). CC_ENV=dev points at CC's dev endpoints; CC_GACHA_URL overrides the base entirely.
  classicGachaEnabled: process.env.CLASSIC_GACHA_ENABLED === 'true',
  ccEnv: process.env.CC_ENV ?? 'main', // 'main' | 'dev'
  ccGachaUrl: process.env.CC_GACHA_URL ?? '', // base override; default derived from ccEnv in the CC client
  ccApiKey: process.env.COLLECTORCRYPT_API_KEY ?? '', // optional — CC gacha endpoints don't enforce it
  gachaBuybackCutBps: num('GACHA_BUYBACK_CUT_BPS', 500), // GDEX's cut of a manual sell-back → FEE_REVENUE (5%)
  gachaTurboCutBps: num('GACHA_TURBO_CUT_BPS', 1000), // higher cut for an instant (sell-on-reveal) sell-back (10%)
  gachaMarkupBps: num('GACHA_MARKUP_BPS', 0), // optional purchase markup over the CC price → FEE_REVENUE (spec §6, default 0/off; admin-tunable)
  tokensEnabled: process.env.TOKENS_ENABLED === 'true', // pay-with-Tokens + loyalty earn (P4); dark until set
  gachaFreePackThresholdUsd: num('GACHA_FREE_PACK_THRESHOLD_USD', 1000), // USD spend that earns one free $25 pack — the loyalty earn rate derives from it (admin-tunable knob)
  gachaStockPollMs: num('GACHA_STOCK_POLL_MS', 300_000), // how often the stock worker polls CC for restocks (5 min)
  heliusDasUrl: process.env.HELIUS_DAS_URL ?? '', // DAS-capable RPC for getAsset (a won NFT's collection/owner — needed to transfer an MPL Core asset out); falls back to solanaRpcUrl

  // Funding: per-accrual rate = skewFactor * (skew / openInterest), bps (the heavy side pays)
  fundingSkewFactorBps: num('FUNDING_SKEW_FACTOR_BPS', 30), // skew-balancing component (max)
  fundingIntervalMs: num('FUNDING_INTERVAL_MS', 60 * 60 * 1000), // hourly

  // Liquidations + circuit breakers
  liqFeeBps: num('LIQ_FEE_BPS', 100), // 1% liquidation penalty -> insurance fund
  liquidationSweepMs: num('LIQUIDATION_SWEEP_MS', 5_000),
  oracleStaleMs: num('ORACLE_STALE_MS', 36 * 60 * 60 * 1000), // halt a market if no fresh print

  // Pool risk cap (GMX-style MAX_PNL_FACTOR). Pause NEW opens once the pool's net liability to
  // traders (winners' unrealized profit, losers' losses capped at their margin) exceeds this
  // fraction of LP NAV — the "stop digging" guard that keeps a thin/underfunded pool from being
  // drained by net winners (ADL is the active backstop, a later phase). 0 = DISABLED, which is the
  // play-money default (the pool runs uncapitalized there); operators set this for real funds.
  // See docs/liquidity-hybrid-spec.md §2.
  maxPnlFactorBps: num('MAX_PNL_FACTOR_BPS', 0),

  // B' adaptive market depth (LS-LMSR-inspired, docs/liquidity-hybrid-spec.md §3). The mark premium
  // is clamp(k·skew/depth, ±cap); depth is per-market = max(LP NAV, depthFloor, α·cumulativeVolume),
  // so every market starts at the floor and DEEPENS (less price impact) as real volume flows through
  // it — no operator pre-guessing, no exp() (fixed-point safe, unlike Augur v2's LS-LMSR). Keeping
  // NAV as a lower bound means depth is never shallower than the old NAV-based depth. The floor also
  // fixes the thin-pool gotcha (a 0<NAV<skew pool no longer pins the premium to its cap).
  // Defaults preserve today's fresh-market impact; alpha needs calibration against real volume.
  depthFloorUusdc: BigInt(num('DEPTH_FLOOR_UUSDC', 1_000_000_000_000)), // $1M zero-volume depth
  depthAlphaE6: BigInt(num('DEPTH_ALPHA_E6', 1_000_000)), // α = 1.0 → depth gains 1 uusdc per uusdc of cumulative volume

  // Auto-deleverage (ADL) — the active backstop to the MAX_PNL_FACTOR gate (Phase 3). When the pool's
  // net liability to traders exceeds this fraction of NAV, the liquidation sweep force-closes the most
  // profitable positions at the mark (realizing their gains, removing their forward upside) until
  // liability is back under the threshold. Set this >= maxPnlFactorBps so opens pause (the gate) BEFORE
  // ADL fires. 0 = DISABLED (play-money default). See docs/liquidity-hybrid-spec.md §6.
  adlPnlFactorBps: num('ADL_PNL_FACTOR_BPS', 0),

  // NAV-relative open-interest cap (Phase 4a). On top of the static per-market OI cap, limit each
  // side's OI to this fraction of LP NAV, so one market's worst-case PnL can't outgrow the pool as NAV
  // shrinks — the fix for "a single position out-earns the vault" (the static $50k/$250k caps are
  // unrelated to pool size). Calibration suggests ~3000-5000 (0.3-0.5×NAV); see
  // docs/liquidity-calibration.md §3. 0 = DISABLED (play-money default; the static cap still applies).
  oiCapNavBps: num('OI_CAP_NAV_BPS', 0),

  // --- Real-funds custody (P0 scaffolding; unused until the REAL_FUNDS paths land) ---
  // See docs/real-funds-custody-plan.md. Env-only; keys/seeds are never hardcoded — the HD master
  // seed lives in KMS and only its reference is configured here.
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
  usdcMint: process.env.USDC_MINT ?? '', // per-network SPL mint
  treasuryPubkey: process.env.TREASURY_PUBKEY ?? '', // Squads multisig (cold) address
  depositSeedKmsRef: process.env.DEPOSIT_SEED_KMS_REF ?? '',
  jupiterBase: process.env.JUPITER_BASE ?? 'https://api.jup.ag', // Jupiter Swap API v1 host (the old quote-api.jup.ag/v6 is retired; lite-api is "phase-out")
  jupiterApiKey: process.env.JUPITER_API_KEY ?? '', // optional Portal x-api-key; keyless works at 0.5 RPS — fine for per-deposit swaps
  swapSlippageBps: num('SWAP_SLIPPAGE_BPS', 100), // 1% max slippage on SOL->USDC deposit swaps
  // SOL->USDC deposit swaps need a Jupiter route, which only exists on MAINNET. Off-route networks
  // (devnet) park SOL deposits as 'detected' rows — no swap attempts, no retry spam — until a
  // swap-capable network is configured (the parked rows then swap + credit on the next scan).
  solSwapsEnabled: process.env.SOL_SWAPS_ENABLED
    ? process.env.SOL_SWAPS_ENABLED === 'true'
    : (process.env.USDC_MINT ?? '') === MAINNET_USDC,
  minDepositUsd: num('MIN_DEPOSIT_USD', 1), // dust below this is ignored (uneconomic to sweep)
  minSweepUsd: num('MIN_SWEEP_USD', 10), // don't pay a hot-wallet sweep fee for less than this (anti-griefing)
  minWithdrawalUsd: num('MIN_WITHDRAWAL_USD', 5),
  withdrawalDailyCapUsd: num('WITHDRAWAL_DAILY_CAP_USD', 10_000), // per-user velocity cap
  hotWalletMaxUsd: num('HOT_WALLET_MAX_USD', 25_000), // hot float cap; once hit, drain to the floor below
  hotWalletFloorPct: num('HOT_WALLET_FLOOR_PCT', 20), // % of the cap to LEAVE in hot when draining (working float for withdrawals)
  depositScanMs: num('DEPOSIT_SCAN_MS', 30_000), // deposit scanner cadence
  // P2 ships withdrawals with MANUAL admin approval: 'requested' rows are only signed/broadcast when
  // an operator runs processWithdrawal (or this flag turns on the automated loop — custody P3).
  // Boot recovery of already-signed/broadcast withdrawals always runs (crash safety).
  withdrawalAutoProcess: process.env.WITHDRAWAL_AUTO_PROCESS === 'true',
  withdrawalProcessMs: num('WITHDRAWAL_PROCESS_MS', 30_000), // auto-process cadence (when enabled)
  // Velocity guard on the auto loop (custody P3): rows above this amount are never auto-broadcast —
  // they sit 'requested' (already debited) until an operator runs processWithdrawal explicitly.
  withdrawalAutoApproveMaxUsd: num('WITHDRAWAL_AUTO_APPROVE_MAX_USD', 1_000),
  treasuryPassMs: num('TREASURY_PASS_MS', 60_000), // proof-of-reserves + hot-float worker cadence
  // Operator surface (custody): the /admin routes are only registered when this is set (and only
  // under REAL_FUNDS). Approve/reverse withdrawals, freeze/unfreeze, treasury report — see
  // docs/ops-runbook.md. The key authenticates the operator; signing stays server-side.
  adminApiKey: process.env.ADMIN_API_KEY ?? '',
};

if (config.realFunds) {
  // Real funds (custody P1+, devnet): the deposit path needs its custody config up front.
  // Secrets stay off the config object: DEPOSIT_MASTER_SEED + HOT_WALLET_SECRET are read from
  // the environment directly by services/custody (dev/devnet) so config logging can't leak them.
  const missing = [
    !config.usdcMint && 'USDC_MINT',
    !config.treasuryPubkey && 'TREASURY_PUBKEY',
    !process.env.DEPOSIT_MASTER_SEED && !config.depositSeedKmsRef && 'DEPOSIT_MASTER_SEED (dev) or DEPOSIT_SEED_KMS_REF',
    !process.env.HOT_WALLET_SECRET && 'HOT_WALLET_SECRET',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`REAL_FUNDS=true requires custody config; missing: ${missing.join(', ')}`);
  }
  // MAINNET stays hard-gated until audit + KYC/AML + geofence (custody P4 in
  // docs/real-funds-custody-plan.md). Devnet/testnet runs need no override.
  const mainnetish = /mainnet/i.test(config.solanaRpcUrl) || config.usdcMint === MAINNET_USDC;
  if (mainnetish && process.env.ALLOW_MAINNET_FUNDS !== 'true') {
    throw new Error(
      'REAL_FUNDS on MAINNET is gated behind the audit + KYC/AML + geofence (custody P4). Set ALLOW_MAINNET_FUNDS=true only once those gates are met.',
    );
  }
}

// A weak operator key guards real money — require real entropy or none at all (routes unregistered).
if (config.adminApiKey && config.adminApiKey.length < 32) {
  throw new Error('ADMIN_API_KEY must be at least 32 characters (or unset to disable the /admin routes).');
}

// Never run in production with the committed default JWT secret (would allow token forgery).
if (
  config.env === 'production' &&
  (!process.env.JWT_SECRET || config.jwtSecret === 'dev-insecure-secret-change-me' || config.jwtSecret.length < 32)
) {
  throw new Error('JWT_SECRET must be set to a strong (>= 32 char) value in production.');
}

// Pool-risk knobs must order correctly: ADL force-closes winners, so it must trigger ABOVE the gate
// that pauses new opens — otherwise ADL fires while the pool is still admitting risk. (Both 0 = off.)
if (config.adlPnlFactorBps > 0 && config.maxPnlFactorBps > 0 && config.adlPnlFactorBps < config.maxPnlFactorBps) {
  throw new Error('ADL_PNL_FACTOR_BPS must be >= MAX_PNL_FACTOR_BPS so opens pause (the gate) before ADL force-closes winners.');
}

// Search-and-bet has TWO tiers, gated separately (route registration reads both):
//  - catalogSearchEnabled: the READ-ONLY catalogue search (`/catalog/search`). It only browses the
//    provider catalogue — no risk, no money — so it needs just the feature flag + a provider that can
//    serve it. tcgpl serves the search under BOTH ORACLE_PRIMARY=tcgpricelookup and =scrydex (scrydex
//    runs tcgpl alongside for the cross-check). NOT gated on the NAV caps.
//  - searchAndBetActive: on-demand LISTING (`/markets/ensure`), which CREATES a real-money-tradeable
//    market. It now follows catalogue search directly — the real-funds requirement that all three NAV
//    gates be armed (added 2026-06-12) was REMOVED per operator decision 2026-06-22, so cards list
//    irrespective of the OI/PnL pool gates. NB this lets thin long-tail markets open without those pool
//    defenses armed; the trading/custody paths have their own protections and never crash with gates ~ 0.
export const catalogSearchEnabled =
  config.searchAndBet && (config.oraclePrimary === 'tcgpricelookup' || config.oraclePrimary === 'scrydex');
export const searchAndBetActive = catalogSearchEnabled;

// Scrydex webhooks are the PRIMARY price-update path (§8); without the secret the receiver deny-alls
// every event (safe, but the feed falls back to the slower batch poll). Warn so a cutover doesn't run
// blind on stale prices — not a throw, since polling still updates prices.
if (config.oraclePrimary === 'scrydex' && !config.scrydexWebhookSecret) {
  console.warn(
    '[config] ORACLE_PRIMARY=scrydex but SCRYDEX_WEBHOOK_SECRET is unset: the price webhook will reject ' +
      'every event and prices update only via the slower batch poll. Set the whsec_ secret to enable the ' +
      'primary (webhook) update path.',
  );
}
