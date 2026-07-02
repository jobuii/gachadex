/**
 * @pokex/shared-types — zod schemas + constants shared by the web app and the api.
 *
 * Money/price fields that cross the wire are encoded as DECIMAL STRINGS of their
 * micro-unit BigInt (e.g. "535220000"), because JSON has no BigInt. The api encodes
 * BigInt -> string; the web app parses string -> BigInt for @pokex/pricing math.
 */
import { z } from 'zod';

// --- enums / constants ------------------------------------------------------

export const MARKET_KINDS = ['card', 'index'];
export const GAMES = ['pokemon', 'onepiece', 'mtg']; // raw prices via scrydex (Pokémon live; OP/MTG pending)
export const SIDES = ['long', 'short'];
export const ORDER_KINDS = ['market', 'reduce_only'];
export const MARKET_STATUS = ['active', 'reduce_only', 'halted', 'delisted'];

// --- index catalogue --------------------------------------------------------
// Three index methodologies (series) over the SAME per-game baskets (docs/index-series-spec.md):
//   GJ      — price-weighted (Dow Jones). The original indices, renamed; the slug stays bare so the
//             market symbol — and thus its history/divisor/open positions — survives the rename.
//   G&P     — equal-weight (S&P 500 Equal Weight): each card contributes its % change equally.
//   Pokedaq — capped price-weight (Nasdaq-100): price-weighted, every card capped at 5%.
// Constituent price = the canonical per-card price (same value the card market uses); eBay is never a
// price input. `weighting` selects the math in the oracle; `tradeable:false` is listed-but-gated until
// the basket's data flows (the ingest flips it live once constituents exist; Sealed has no feed).
const INDEX_TIERS = [
  { tier: 'top-100', topN: 100, top: 'Top 100', num: '100', tracks: 'Top 100 cards by market price' },
  { tier: 'top-250', topN: 250, top: 'Top 250', num: '250', tracks: 'Top 250 cards by market price' },
  { tier: 'graded', topN: null, top: 'Graded (PSA 10)', num: 'Graded (PSA 10)', tracks: 'PSA 10 graded cards', pokemonOnly: true },
  { tier: 'sealed', topN: null, top: 'Sealed', num: 'Sealed', tracks: 'Sealed product', pokemonOnly: true, gjOnly: true, gated: true },
];
/** Pokedaq per-card weight cap (Nasdaq-100 style), in basis points — the single source of truth. */
export const DEFAULT_CAP_BPS = 500; // 5%
const INDEX_SERIES = [
  { series: 'gj', label: 'GJ', weighting: 'price', slugPrefix: '', useNum: false },
  { series: 'gp', label: 'G&P', weighting: 'equal', slugPrefix: 'gp-', useNum: false },
  { series: 'pdq', label: 'Pokedaq', weighting: 'capped', capBps: DEFAULT_CAP_BPS, slugPrefix: 'pdq-', useNum: true },
];

export const INDEX_SERIES_LABELS = { gj: 'GJ', gp: 'G&P', pdq: 'Pokedaq' };

/** Display/sort order of the series (GJ → G&P → Pokedaq), derived from INDEX_SERIES — the single source of
 *  truth the web sorts/groups indices by (was duplicated, once hardcoded, in two components). */
export const SERIES_ORDER = Object.fromEntries(INDEX_SERIES.map((s, i) => [s.series, i]));

/** Which series an index slug belongs to (the web groups by this; the API returns only `indexSlug`). */
export function indexSeries(slug) {
  if (typeof slug === 'string' && slug.startsWith('gp-')) return 'gp';
  if (typeof slug === 'string' && slug.startsWith('pdq-')) return 'pdq';
  return 'gj';
}

export const INDEX_CATALOG = GAMES.flatMap((game) =>
  INDEX_SERIES.flatMap((s) =>
    INDEX_TIERS.filter((t) => !(t.pokemonOnly && game !== 'pokemon') && !(t.gjOnly && s.series !== 'gj')).map((t) => ({
      game,
      series: s.series,
      tier: t.tier,
      slug: s.slugPrefix + t.tier, // GJ: bare tier (preserves the existing symbol); others: prefixed
      name: `${s.label} ${s.useNum ? t.num : t.top}`,
      tracks: t.tracks,
      weighting: s.weighting,
      ...(s.capBps ? { capBps: s.capBps } : {}),
      // gated by default unless it's a Pokémon top-N basket (live today); the rest light up via the ingest.
      tradeable: !t.gated && game === 'pokemon' && (t.tier === 'top-100' || t.tier === 'top-250'),
      topN: t.topN,
    })),
  ),
);

/** Valid index slugs (drives MarketSchema.indexSlug) — derived from the catalogue. */
export const INDEX_SLUGS = [...new Set(INDEX_CATALOG.map((i) => i.slug))];

export const MAX_LEVERAGE = 20;

// A BigInt-as-decimal-string field (micro-units over the wire).
export const MicroStr = z.string().regex(/^-?\d+$/, 'expected an integer micro-unit string');

// --- entities ---------------------------------------------------------------

export const MarketSchema = z.object({
  id: z.string(),
  kind: z.enum(MARKET_KINDS),
  game: z.enum(GAMES),
  symbol: z.string(),
  displayName: z.string(),
  cardId: z.string().nullable().optional(),
  variant: z.string().nullable().optional(),
  indexSlug: z.enum(INDEX_SLUGS).nullable().optional(),
  imageSmall: z.string().nullable().optional(),
  status: z.enum(MARKET_STATUS),
  tradeable: z.boolean(),
  maxLeverage: z.number().int().positive().max(MAX_LEVERAGE),
  maintMarginBps: z.number().int().positive(),
  // effective trading fee (bps of notional, charged on open + close) — so clients preview the
  // real fee + required balance instead of guessing (the live value, operator-overridable).
  feeBps: z.number().int().nonnegative().optional(),
  // latest market data (micro-unit strings)
  markE6: MicroStr.optional(),
  indexE6: MicroStr.optional(),
  change24hPct: z.number().optional(),
});
export const MarketsResponse = z.array(MarketSchema);

export const PositionSchema = z.object({
  id: z.string(),
  marketId: z.string(),
  symbol: z.string(),
  side: z.enum(SIDES),
  qtyE6: MicroStr,
  avgEntryE6: MicroStr,
  marginUusdc: MicroStr,
  leverage: z.number().positive(),
  liqPriceE6: MicroStr,
  markE6: MicroStr,
  unrealizedPnlUusdc: MicroStr,
  status: z.enum(['open', 'closed', 'liquidated']),
});

export const BalanceSchema = z.object({
  availableUusdc: MicroStr,
  lockedMarginUusdc: MicroStr,
  equityUusdc: MicroStr,
});

// --- requests ----------------------------------------------------------------

export const OrderRequest = z.object({
  marketId: z.string(),
  side: z.enum(SIDES),
  // quantity in synthetic units, micro-string (e.g. "1500000" = 1.5 units)
  qtyE6: MicroStr,
  leverage: z.number().int().positive().max(MAX_LEVERAGE),
  kind: z.enum(ORDER_KINDS).default('market'),
  // slippage guard (optional): the worst acceptable fill price, micro-USD (non-negative — a negative
  // bound would silently disable the guard). A long fills only if the mark is <= this; a short fills
  // only if the mark is >= this. Bounds the gap between an agent's preview mark and the actual fill
  // (the engine rejects with code 'slippage_exceeded').
  limitPriceE6: z.string().regex(/^\d+$/, 'expected a non-negative micro-unit string').optional(),
  idempotencyKey: z.string().min(8),
});

export const ClosePositionRequest = z.object({
  positionId: z.string(),
  // fraction to close in bps (10000 = full close). default full.
  fractionBps: z.number().int().positive().max(10_000).default(10_000),
  idempotencyKey: z.string().min(8),
});

// Resting orders (limit / stop-loss / take-profit — docs/limit-stop-orders-spec.md). All are TRIGGERS
// that market-fill at the mark when it crosses trigger_price; for a 'limit' the trigger price doubles as
// the slippage cap (fill mark-or-better). P1 ships 'limit' (open: needs side + qtyE6 + leverage);
// reduce_only SL/TP (needs positionId) land in P2.
export const RESTING_ORDER_KINDS = ['limit', 'stop_loss', 'take_profit'];
export const RestingOrderRequest = z.object({
  marketId: z.string(),
  kind: z.enum(RESTING_ORDER_KINDS),
  triggerPriceE6: z.string().regex(/^\d+$/, 'expected a non-negative micro-unit string'),
  side: z.enum(SIDES).optional(), // limit-open
  qtyE6: MicroStr.optional(), // limit
  leverage: z.number().int().positive().max(MAX_LEVERAGE).optional(), // limit-open
  slippageE6: z.string().regex(/^\d+$/, 'expected a non-negative micro-unit string').optional(),
  positionId: z.string().optional(), // SL/TP
  reduceOnly: z.boolean().default(false),
  idempotencyKey: z.string().min(8),
});

export const FaucetRequest = z.object({
  amountUsd: z.number().positive().max(100_000).default(10_000),
});

// --- operator manual price override (admin; ROADMAP §2) -----------------------
export const SetPriceRequest = z.object({
  priceE6: MicroStr, // micro-USD price to set for the market (card or index)
  pin: z.boolean().optional(), // default true server-side; pin so the auto-oracle won't overwrite
  force: z.boolean().optional(), // bypass the fat-finger guard (>10x move)
  note: z.string().max(200).optional(), // audit note (source/why)
});

// Operator allocates house funds (fees or treasury surplus) to/from the insurance buffer (admin op).
export const InsuranceFundRequest = z.object({
  amountUusdc: MicroStr, // micro-USDC
});

// Operator-tunable custody limits (admin panel). All optional — only the provided keys are updated.
// USD fields are plain dollar numbers (the server converts to micro-USDC); swapSlippageBps is bps.
// Bounds mirror validateLimit() in apps/api/src/services/custody/limits.ts — keep the two in sync.
const LimitUsd = z.coerce.number().nonnegative().max(1_000_000_000);
export const CustodyLimitsRequest = z
  .object({
    minDepositUsd: LimitUsd.optional(),
    minSweepUsd: LimitUsd.optional(),
    minWithdrawalUsd: LimitUsd.optional(),
    withdrawalDailyCapUsd: LimitUsd.optional(),
    hotWalletMaxUsd: LimitUsd.optional(),
    hotWalletFloorPct: z.coerce.number().int().min(0).max(100).optional(),
    withdrawalAutoApproveMaxUsd: LimitUsd.optional(),
    swapSlippageBps: z.coerce.number().int().min(0).max(1000).optional(),
  })
  .strict();

// Live-tunable trading fee. bps of notional (1 bps = 0.01%), charged on both open + close; 0-1000 (<=10%).
// The admin panel takes a percentage from the operator and converts (pct * 100 = bps).
export const FeeRequest = z.object({ bps: z.coerce.number().int().min(0).max(1000) }).strict();

// Live-tunable funding factor — the max hourly funding rate (bps) at full skew; 0-100 (<=1%/hour). The
// admin panel takes a percentage and converts (pct * 100 = bps). Scaled by the book's skew each hour.
export const FundingFactorRequest = z.object({ bps: z.coerce.number().int().min(0).max(100) }).strict();

// Live-tunable mark-guard clamp (§6a) — the per-update cap, in bps, on an UNCORROBORATED mark move
// (ORACLE_PRIMARY=scrydex). 100-9000 (1%-90%); default 2500 (25%). Lower = more user protection
// (price creeps), higher = more pool protection (adopts moves faster).
export const MarkClampRequest = z.object({ bps: z.coerce.number().int().min(100).max(9000) }).strict();

// LP revenue-share knobs — the whole-percent (0–100) of a fee/funding/liquidation source routed to the pool.
export const LpSharePctRequest = z.object({ pct: z.coerce.number().int().min(0).max(100) }).strict();

// Admin toggle for automatic withdrawal approval. When false, all withdrawals require manual approval.
export const WithdrawalAutoProcessRequest = z.object({ enabled: z.boolean() }).strict();

// --- real-funds wallet (custody P2) -------------------------------------------
// Withdrawals need a step-up: the wallet signs a server-rendered message over the EXACT
// (amount, dest, nonce) — get the message from /wallet/withdraw/nonce, sign it, submit both.

export const WithdrawNonceRequest = z.object({
  amountE6: MicroStr, // micro-USDC, canonical (no float rounding between nonce + submit)
  dest: z.string().min(32).max(64), // Solana address; validity checked server-side
});

export const WithdrawRequest = WithdrawNonceRequest.extend({
  idempotencyKey: z.string().min(8),
  message: z.string(), // the signed step-up message (server re-renders + verifies)
  signature: z.string(), // base58 wallet signature over `message`
});

// --- social (referrals) ------------------------------------------------------

export const ReferralRedeemRequest = z.object({
  code: z.string().trim().min(4).max(32),
});

export const ReferralCodeRequest = z.object({
  code: z.string().trim().min(4).max(20), // server normalizes + validates charset
});

export const ChatPostRequest = z.object({
  body: z.string().trim().min(1).max(280),
  replyTo: z.string().min(1).optional(), // parent message id when replying
});

export const UsernameRequest = z.object({
  username: z.string().trim().min(3).max(20).regex(/^[A-Za-z0-9_-]+$/, 'letters, numbers, _ and - only'),
});

// Profile avatar: a sprite path under /avatars/, e.g. 'default/151.png' or 'shiny/25.png'.
export const AvatarRequest = z.object({
  avatar: z.string().trim().regex(/^(default|shiny)\/\d{1,4}\.png$/, 'invalid avatar'),
});

// The chat identity colors (avatar box + username). SINGLE SOURCE shared by the avatar/color picker, the
// chat renderer, and server-side validation. A user's chat_color is null until they pick one, in which case
// the client derives a stable color from their handle (see colorFor).
export const CHAT_COLORS = ['#f0c040', '#3fb950', '#58a6ff', '#e74c3c', '#bc8cff', '#f78166', '#39d3bb'];
// Pick a chat identity color — must be one of CHAT_COLORS.
export const ColorRequest = z.object({
  color: z.string().refine((c) => CHAT_COLORS.includes(c), 'invalid color'),
});

// --- chat moderation ---------------------------------------------------------

// Mute a user for N minutes (1 min – 30 days); omitted -> server default.
export const ChatMuteRequest = z.object({
  minutes: z.number().int().min(1).max(43_200).optional(),
});

// Operator chat-moderation action on a user (admin-key CHAT view). grant/revoke toggle MOD; unmute/unban
// clear a mute/ban. The :userId path segment may be an internal id OR a wallet pubkey (resolved server-side).
export const ChatModActionRequest = z.object({
  action: z.enum(['grant', 'revoke', 'unmute', 'unban']),
});

// Live-tunable chat action-bar thresholds (admin CHAT view), whole USD. Partial update — only the provided
// keys change (a blank field in the panel is left unchanged). Bounds mirror chat-config.ts.
export const ChatThresholdsRequest = z
  .object({
    bigBetUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
    bigWinUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();

// Live-tunable DROP config (admin CHAT view). Partial update; bounds mirror drop-config.ts. packTiers is a
// list of positive-integer USD pack sizes (the round opens the largest the pot can afford).
export const DropConfigRequest = z
  .object({
    intervalMin: z.coerce.number().int().min(1).max(43_200).optional(),
    houseFloorUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
    packTiers: z.array(z.coerce.number().int().positive().max(10_000_000)).min(1).max(12).optional(),
    gdexMin: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

// Player tips real USDC into the DROP pot. A whole/fractional dollar amount; the server re-checks it
// against the DROP_TIP_MIN/MAX config + the tipper's available balance, and converts to micro-USDC.
export const ChatTipRequest = z.object({
  amountUsd: z.coerce.number().positive().max(10_000_000),
});

// The allowed chat reaction emojis — shared by the server (validation) and the client (picker).
export const CHAT_REACTIONS = ['👍', '❤️', '😂', '🔥', '🚀', '💯', '😮', '😢'];

// Toggle a reaction on a message. The emoji must be one of CHAT_REACTIONS (re-checked server-side).
export const ReactRequest = z.object({
  emoji: z.string().min(1).max(16),
});

// --- auth (SIWS) -------------------------------------------------------------

export const NonceRequest = z.object({ pubkey: z.string().min(32) });
export const NonceResponse = z.object({ message: z.string(), nonce: z.string() });
export const VerifyRequest = z.object({
  pubkey: z.string().min(32),
  message: z.string(),
  signature: z.string(), // base58
});

// --- delegated trading keys (docs/cli-spec.md Part 1) -------------------------
// The master wallet (already authenticated) authorizes a fresh delegate pubkey to trade. Get the
// challenge from /auth/delegate/nonce, sign it with the MASTER key, submit to /auth/delegate.
// label: printable ASCII only (no newlines — they could forge message lines). expiresAt: ISO-8601
// UTC, future, server-capped at DELEGATE_MAX_TTL.
const DelegateLabel = z.string().regex(/^[\x20-\x7E]{0,64}$/, 'label: printable ASCII, max 64, no newlines');
export const DelegateNonceRequest = z.object({
  delegatePubkey: z.string().min(32).max(64),
  label: DelegateLabel.optional(),
  expiresAt: z.string().datetime().optional(),
});
export const DelegateCreateRequest = DelegateNonceRequest.extend({
  message: z.string(), // the signed delegation message (carries the nonce; server re-renders + verifies)
  signature: z.string(), // base58 MASTER-wallet signature over `message`
});

// --- games (docs/games-spec.md) ----------------------------------------------

// Rotate the provably-fair client seed (1–64 printable ASCII chars).
export const ClientSeedRequest = z.object({
  clientSeed: z.string().trim().min(1).max(64).regex(/^[\x20-\x7E]+$/, 'client seed: printable ASCII only'),
});

// Open a pack: a tier price (whole USD, validated against the live config server-side) + an idempotency key.
export const PackRipOpenRequest = z.object({
  tier: z.coerce.number().int().positive().max(10_000_000),
  idempotencyKey: z.string().min(8),
});

// Sell a held prize back for USDC.
export const PrizeSellRequest = z.object({
  prizeId: z.string().min(1),
});

// Set Poker: deal a hand / swap one of the player's five cards (slot 0..4). Each carries an idempotency key.
export const SetPokerDealRequest = z.object({
  idempotencyKey: z.string().min(8),
});
export const SetPokerSwapRequest = z.object({
  slot: z.coerce.number().int().min(0).max(4),
  idempotencyKey: z.string().min(8),
});
// Settle the open hand; an optional playId targets a specific hand for an idempotent retry.
export const SetPokerSettleRequest = z.object({
  playId: z.string().optional(),
});

// Grade Gamble: pay an ante tier to draw + grade a card.
export const GradeOpenRequest = z.object({
  tier: z.coerce.number().int().positive().max(10_000_000),
  idempotencyKey: z.string().min(8),
});

// The Break: buy a spot in the open case.
export const BreakJoinRequest = z.object({
  idempotencyKey: z.string().min(8),
});
// Admin: cancel + refund an open case.
export const BreakCancelRequest = z.object({
  roundId: z.string().min(1),
});

// Price Duel: quick-match with a picked card / the creator backs out of an unmatched duel.
export const DuelJoinRequest = z.object({
  marketId: z.string().min(1).max(128),
  idempotencyKey: z.string().min(8).max(128),
});
export const DuelCancelRequest = z.object({
  duelId: z.string().min(1).max(128),
});

// Card Fantasy: enter the open league with a roster of distinct card market ids.
export const FantasyEnterRequest = z.object({
  marketIds: z.array(z.string().min(1).max(128)).min(2).max(15),
  idempotencyKey: z.string().min(8).max(128),
});

// Draft Arena: join the open lobby with a ranked wishlist over the pool / admin cancel an unfilled lobby.
export const ArenaJoinRequest = z.object({
  wishlist: z.array(z.string().min(1).max(128)).min(2).max(200),
  idempotencyKey: z.string().min(8).max(128),
});
export const ArenaCancelRequest = z.object({
  roundId: z.string().min(1).max(128),
});

// Live-tunable games config (admin Games view). Partial — only provided keys change. Bounds mirror
// game-config.ts; `tiers` nests a per-tier weighted value-band table the rip draws from.
const PackBandReq = z.object({
  minUsd: z.coerce.number().int().min(0).max(10_000_000),
  maxUsd: z.coerce.number().int().min(0).max(10_000_000),
  weight: z.coerce.number().min(0).max(1_000_000_000),
});
const PackTierReq = z.object({
  price: z.coerce.number().int().positive().max(10_000_000),
  bands: z.array(PackBandReq).min(1).max(12),
});
export const GameConfigRequest = z
  .object({
    packRip: z
      .object({
        enabled: z.boolean().optional(),
        buybackSpreadBps: z.coerce.number().int().min(0).max(9000).optional(),
        maxPrizeUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        bigWinUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
        tiers: z.array(PackTierReq).min(1).max(12).optional(),
      })
      .strict()
      .optional(),
    setPoker: z
      .object({
        enabled: z.boolean().optional(),
        anteUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        swapFeeUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
        maxSwaps: z.coerce.number().int().min(0).max(25).optional(),
        buybackSpreadBps: z.coerce.number().int().min(0).max(9000).optional(),
        maxPrizeUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        bigWinUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
        bands: z.array(PackBandReq).min(1).max(12).optional(),
      })
      .strict()
      .optional(),
    gradeGamble: z
      .object({
        enabled: z.boolean().optional(),
        buybackSpreadBps: z.coerce.number().int().min(0).max(9000).optional(),
        maxPrizeUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        bigWinUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
        tiers: z.array(PackTierReq).min(1).max(12).optional(),
        grades: z.array(z.object({
          label: z.string().min(1).max(24),
          multBps: z.coerce.number().int().min(1).max(100_000_000),
          weight: z.coerce.number().min(0).max(1_000_000_000),
        })).min(2).max(12).optional(),
      })
      .strict()
      .optional(),
    theBreak: z
      .object({
        enabled: z.boolean().optional(),
        spots: z.coerce.number().int().min(2).max(100).optional(),
        entryUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        buybackSpreadBps: z.coerce.number().int().min(0).max(9000).optional(),
        maxPrizeUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        bigWinUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
        bands: z.array(PackBandReq).min(1).max(12).optional(),
      })
      .strict()
      .optional(),
    priceDuel: z
      .object({
        enabled: z.boolean().optional(),
        anteUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        windowHours: z.coerce.number().int().min(1).max(720).optional(),
        rakeBps: z.coerce.number().int().min(0).max(5000).optional(),
        bigWinUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
      })
      .strict()
      .optional(),
    cardFantasy: z
      .object({
        enabled: z.boolean().optional(),
        entryUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        capUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        rosterSize: z.coerce.number().int().min(2).max(15).optional(),
        windowHours: z.coerce.number().int().min(1).max(720).optional(),
        rakeBps: z.coerce.number().int().min(0).max(5000).optional(),
        minEntries: z.coerce.number().int().min(2).max(1000).optional(),
        bigWinUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
      })
      .strict()
      .optional(),
    draftArena: z
      .object({
        enabled: z.boolean().optional(),
        entryUsd: z.coerce.number().int().min(1).max(10_000_000).optional(),
        spots: z.coerce.number().int().min(2).max(12).optional(),
        rosterSize: z.coerce.number().int().min(2).max(10).optional(),
        poolSize: z.coerce.number().int().min(4).max(200).optional(),
        rakeBps: z.coerce.number().int().min(0).max(5000).optional(),
        windowHours: z.coerce.number().int().min(1).max(720).optional(),
        lobbyTimeoutHours: z.coerce.number().int().min(1).max(720).optional(),
        bigWinUsd: z.coerce.number().int().min(0).max(10_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Seed the GAME_POOL bankroll (play-money) — a whole/fractional dollar amount.
export const GamePoolSeedRequest = z.object({
  amountUsd: z.coerce.number().positive().max(10_000_000),
});

// --- websocket protocol ------------------------------------------------------

export const WS_PUBLIC_CHANNELS = ['mark', 'stats', 'oi', 'funding']; // channel:{marketId}
export const WS_PRIVATE_CHANNELS = ['positions', 'orders', 'balance', 'liquidations', 'lp'];

export const WsClientMsg = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sub'), channels: z.array(z.string()) }),
  z.object({ op: z.literal('unsub'), channels: z.array(z.string()) }),
  z.object({ op: z.literal('auth'), token: z.string() }),
  z.object({ op: z.literal('ping') }),
]);

/** Server push envelope: { ch, type, seq, data }. */
export const WsServerMsg = z.object({
  ch: z.string(),
  type: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.unknown(),
});
