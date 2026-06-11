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
    admin: num('RL_ADMIN', 30), // operator endpoints (also brute-force defense on the admin key)
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

  // Price source (server-side only)
  pokemontcgApiKey: process.env.POKEMONTCG_API_KEY ?? '', // optional; keyless works
  pokemontcgBase: 'https://api.pokemontcg.io/v2',
  oracleRefreshMs: num('ORACLE_REFRESH_MS', 6 * 60 * 60 * 1000), // 6h; source updates ~daily
  oraclePageSize: num('ORACLE_PAGE_SIZE', 250), // pokemontcg.io v2 caps pageSize at 250 (clamps silently); >250 is a no-op

  // JustTCG graded (PSA-10) pricing — server-side, optional. When set, the Graded index
  // becomes tradeable; without it, Graded stays gated.
  justtcgApiKey: process.env.JUSTTCG_API_KEY ?? '',
  justtcgBase: process.env.JUSTTCG_BASE ?? 'https://api.justtcg.com',
  gradedConstituents: num('GRADED_CONSTITUENTS', 100), // top-N cards for the Graded index

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
  jupiterBase: process.env.JUPITER_BASE ?? 'https://quote-api.jup.ag',
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
