-- GachaDex schema. Money is BIGINT micro-USDC (1 USDC = 1_000_000). Prices/values are
-- BIGINT micro-USD ("*_e6"). Quantities are BIGINT scale-1e6 ("qty_e6"). No floats.
-- IDs are app-generated UUID text (crypto.randomUUID) to avoid extension deps.
-- Idempotent: safe to run repeatedly (CREATE ... IF NOT EXISTS).

-- =========================================================================
-- Chart of accounts + double-entry ledger (the heart of the system)
-- =========================================================================
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                       -- NULL for system accounts
  type        TEXT NOT NULL,              -- USER_COLLATERAL | USER_POSITION_MARGIN | LP_POOL | ...
  currency    TEXT NOT NULL DEFAULT 'USDC',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_user_type ON accounts(user_id, type) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_system_type ON accounts(type) WHERE user_id IS NULL;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  txn_id       TEXT NOT NULL,             -- groups the entries of one atomic operation
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  amount_uusdc BIGINT NOT NULL,           -- signed; +credit / -debit
  reason       TEXT NOT NULL,
  ref_type     TEXT,
  ref_id       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_txn ON ledger_entries(txn_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, id);

-- Materialized balance cache (verified against SUM(ledger_entries) by the reconciler).
CREATE TABLE IF NOT EXISTS balances (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(id),
  amount_uusdc BIGINT NOT NULL DEFAULT 0,
  version      BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hard invariant: the entries of any txn_id must net to zero. Enforced at COMMIT
-- via a deferred constraint trigger (the engine also asserts this in app code).
CREATE OR REPLACE FUNCTION ledger_txn_balanced() RETURNS trigger AS $$
DECLARE s BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_uusdc), 0) INTO s FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'ledger txn % is unbalanced: sum=%', NEW.txn_id, s;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER trg_ledger_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_txn_balanced();

-- =========================================================================
-- Identity / auth (SIWS)
-- =========================================================================
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  solana_pubkey TEXT UNIQUE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  referral_code TEXT,                          -- this user's own code (assigned on signup)
  referred_by   TEXT REFERENCES users(id),     -- who referred this user (set once on redeem)
  referred_at   TIMESTAMPTZ,
  display_name  TEXT,                           -- chat username (unique); falls back to a truncated pubkey
  avatar        TEXT,                            -- profile sprite path under /avatars/, e.g. 'default/151.png' (null = derived from id)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- referral columns added in-place for DBs created before the feature (no-op on a fresh DB)
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_referral_code ON users(referral_code);
-- usernames are unique case-insensitively (no "Ash" vs "ash" impersonation)
DROP INDEX IF EXISTS uq_users_display_name;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_display_name_ci ON users(lower(display_name));
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

-- Codes a user previously held (freed by a rename). Reserved permanently so a renamed-away code
-- can't be re-registered by anyone else (anti-hijack) and old ?ref= links keep resolving to the
-- original owner. Uniqueness of a code spans BOTH users.referral_code and this table.
CREATE TABLE IF NOT EXISTS referral_code_aliases (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_alias_user ON referral_code_aliases(user_id);

-- Affiliate / KOL referral economics (operator-set, per affiliate user). The affiliate's shared code is
-- their users.referral_code; their referees link via the usual users.referred_by. Two knobs:
--   fee_discount_bps  — % off the affiliate's OWN trading fees (open + close; liquidation excluded).
--   cashback_bps      — % of each referee's trading fee paid back to the affiliate, taken from the house
--                       FEE_REVENUE share only (never the LP share), credited as withdrawable USDC.
-- Guard (set-time + runtime): feeLpSharePct% + cashback% must stay <= 100% so house revenue never underflows.
CREATE TABLE IF NOT EXISTS affiliate_terms (
  user_id          TEXT PRIMARY KEY REFERENCES users(id),
  cashback_bps     INT NOT NULL DEFAULT 0,
  fee_discount_bps INT NOT NULL DEFAULT 0,
  label            TEXT,                                  -- operator note ("Streamer X")
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Cashback lookups (an affiliate's lifetime total on the Portfolio card + the admin list) filter
-- ledger_entries by account + reason; index it so /account/balance never scans a trader's full ledger.
CREATE INDEX IF NOT EXISTS idx_ledger_account_reason ON ledger_entries(account_id, reason);

-- Usernames a user previously held (freed by a rename). Reserved permanently so a renamed-away
-- handle can't be claimed by someone else to impersonate them in chat (the handle is the @mention
-- target and reply-quote header). Uniqueness of a display_name spans BOTH users.display_name and this
-- table, case-insensitively (name_lower is the key) — same anti-hijack pattern as referral_code_aliases.
CREATE TABLE IF NOT EXISTS display_name_aliases (
  name_lower TEXT PRIMARY KEY,        -- lower(display_name) of a handle this user previously held
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_display_alias_user ON display_name_aliases(user_id);

-- Global community chat (a single public room for the MVP).
CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  reply_to   TEXT REFERENCES chat_messages(id), -- parent message when this is a reply
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to TEXT REFERENCES chat_messages(id);
-- 'message' (a user post) | 'event' (a BIG BET / BIG WIN action bar); meta carries the structured payload
-- the client renders the bar from (variant, side, notionalE6, pnlE6, roeBps, marketName).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message';
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS meta JSONB;
-- moderation: soft-delete (the row stays for audit; listChat filters it out). deleted_by = mod user id.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_by TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, kind); -- listChatUsers (admin) groups posters by user

-- Emoji reactions: one row per (message, user, emoji). Toggling deletes/inserts the row.
CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg ON chat_reactions(message_id);

-- Chat moderation flags on users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_mod BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_muted_until TIMESTAMPTZ; -- muted while > now()
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_banned BOOLEAN NOT NULL DEFAULT false;

-- Mod-action audit trail. mod_user_id NULL = operator (admin key). Append-only.
CREATE TABLE IF NOT EXISTS chat_mod_actions (
  id                TEXT PRIMARY KEY,
  mod_user_id       TEXT REFERENCES users(id),       -- the acting mod; NULL for operator (admin key)
  action            TEXT NOT NULL,                   -- delete|mute|unmute|ban|unban|grant_mod|revoke_mod
  target_user_id    TEXT REFERENCES users(id),
  target_message_id TEXT,
  detail            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_mod_actions_created ON chat_mod_actions(created_at DESC);

-- DROP pot tips (docs/chat-social-spec.md F6). A player contributes real USDC to the giveaway pot
-- (USER_COLLATERAL -> DROP_POOL ledger account). round_id stays NULL until the round worker (Phase 2b)
-- associates tips with an open round.
CREATE TABLE IF NOT EXISTS drop_tips (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  amount_uusdc BIGINT NOT NULL,
  round_id     TEXT,
  txn_id       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drop_tips_created ON drop_tips(created_at DESC);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  pubkey     TEXT NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  refresh_hash TEXT NOT NULL,
  family       TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Delegated trading keys (perp-dex "agent wallets"). A master wallet authorizes a fresh ed25519
-- keypair to TRADE on its account — open/close positions, never withdraw or move funds — with
-- optional expiry and instant revocation. Bots/agents run on a delegate key and never touch the
-- master key; a leaked delegate caps damage at "bad trades until revoked". A delegate logs in via
-- the normal SIWS flow with its OWN pubkey and is mapped to the master's user_id at a 'trade' scope.
-- The pubkey is the PRIMARY KEY (a key delegates for at most one account) and, once revoked, the
-- row is permanent (the pubkey is burned — re-authorizing a revoked key is rejected). See
-- docs/cli-spec.md Part 1.
CREATE TABLE IF NOT EXISTS delegated_keys (
  pubkey     TEXT PRIMARY KEY,                    -- delegate's ed25519 pubkey (base58)
  user_id    TEXT NOT NULL REFERENCES users(id),  -- the MASTER account this key trades for
  label      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,                          -- NULL = no expiry
  revoked_at TIMESTAMPTZ                           -- NULL = active; once set the row is permanent
);
CREATE INDEX IF NOT EXISTS idx_delegated_keys_user ON delegated_keys(user_id);

-- Sessions carry their scope + delegate so refresh can't silently re-mint a delegate's session as
-- full-scope, and so revocation re-checks the delegate row on rotation (added in-place; no-op on a
-- fresh DB). delegate_pubkey is NULL for a normal (master, full-scope) session.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope           TEXT NOT NULL DEFAULT 'full';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS delegate_pubkey TEXT REFERENCES delegated_keys(pubkey);

-- Nonce purpose tag (login | withdraw | delegate). Cheap defense-in-depth on top of the per-purpose
-- message rendering: a nonce minted for one flow can't be claimed by another.
ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'login';

-- =========================================================================
-- Markets (cards AND indices) + index composition
-- =========================================================================
CREATE TABLE IF NOT EXISTS markets (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,            -- 'card' | 'index'
  game               TEXT NOT NULL DEFAULT 'pokemon', -- 'pokemon' | 'onepiece' | 'mtg'
  symbol             TEXT UNIQUE NOT NULL,
  display_name       TEXT NOT NULL,
  card_id            TEXT,
  variant            TEXT,
  index_slug         TEXT,
  image_small        TEXT,
  image_large        TEXT,
  set_logo           TEXT,                            -- pokemontcg set.images.logo
  metadata           JSONB,                           -- { hp, retreat, attacks[], setName }
  graded_psa10_e6    BIGINT,                          -- PSA-10 price (JustTCG), null until sourced
  status             TEXT NOT NULL DEFAULT 'active',  -- active|reduce_only|halted|delisted
  tradeable          BOOLEAN NOT NULL DEFAULT true,
  max_leverage_e2    INT NOT NULL DEFAULT 2000,       -- 20.00x
  init_margin_bps    INT NOT NULL DEFAULT 500,        -- 5%
  maint_margin_bps   INT NOT NULL DEFAULT 250,        -- 2.5%
  max_oi_long_uusdc  BIGINT NOT NULL DEFAULT 0,
  max_oi_short_uusdc BIGINT NOT NULL DEFAULT 0,
  skew_k_e6          BIGINT NOT NULL DEFAULT 1000000, -- k = 1.0
  premium_cap_e6     BIGINT NOT NULL DEFAULT 100000,  -- ±10%
  max_dev_bps        INT NOT NULL DEFAULT 1500,       -- ±15% anchor clamp
  min_qty_e6         BIGINT NOT NULL DEFAULT 100,     -- 0.0001 units (dollar floor is the $1 min-notional in the engine)
  qty_step_e6        BIGINT NOT NULL DEFAULT 100,     -- 0.0001 units
  price_tick_e6      BIGINT NOT NULL DEFAULT 10000,   -- $0.01
  price_pinned       BOOLEAN NOT NULL DEFAULT false,  -- operator manual-price override; auto-oracle skips pinned markets
  low_confidence     BOOLEAN NOT NULL DEFAULT false,  -- oracle price-quality gate: thin/disagreeing signals -> reduce-only (see priceCard)
  -- Mark guard (§6a, ORACLE_PRIMARY=scrydex): an uncorroborated >clamp% jump caps the per-update mark
  -- move so a bad/glitched print can't wrongfully liquidate. mark_clamped = clamped right now;
  -- mark_candidate_e6 = the un-clamped candidate we're creeping toward (NULL when not clamped).
  mark_clamped       BOOLEAN NOT NULL DEFAULT false,
  clamped_since      TIMESTAMPTZ,
  mark_candidate_e6  BIGINT,
  cumulative_volume_uusdc BIGINT NOT NULL DEFAULT 0,   -- Σ traded notional; drives B' adaptive mark depth
  -- Stable cross-provider identity (tcgpricelookup migration P0): symbol/card_id are provider DISPLAY
  -- ids (pokemontcg today, tcgpricelookup UUIDs later) and differ per provider, so a feed cutover must
  -- join on something stable. tcgplayer_id = TCGplayer product id of the canonical variant (shared
  -- across providers); provider_card_id = the tcgpricelookup card UUID once matched/created.
  tcgplayer_id       BIGINT,
  provider_card_id   TEXT,
  scrydex_card_id    TEXT,                            -- Scrydex card id (ORACLE_PRIMARY=scrydex); matched once, then the batch poll fetches by it
  scrydex_expansion_id TEXT,                          -- Scrydex expansion id of the matched card; the prices.raw_updated webhook (§8) carries expansion_ids, so this maps an event to our tracked markets
  -- Priced ONLY by Scrydex (no tcgpl side: the JPY set + Scrydex-only EN). Under tcgpl-primary these have
  -- no mark, so the /markets list HIDES them until ORACLE_PRIMARY=scrydex, then they auto-reveal.
  requires_scrydex   BOOLEAN NOT NULL DEFAULT false,
  -- Japanese-market card (the JPY>$threshold set; price quoted in JPY). Drives the GachaDex JPY on/off
  -- filter — the main top-250/game is English; JPY cards show only when the toggle is on.
  jpy                BOOLEAN NOT NULL DEFAULT false,
  -- Featured = index-constituent eligible (the discovery top-250 per game). The TRACKED universe
  -- (everything priced) and the INDEX basket (featured only) are deliberately distinct sets, so
  -- on-demand long-tail markets (P6 search-and-bet) can never mutate the Top-100/250 baskets.
  featured           BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_markets_kind ON markets(kind, status);
-- upgrade existing DBs (no-op on a fresh schema)
ALTER TABLE markets ADD COLUMN IF NOT EXISTS image_large TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS game TEXT NOT NULL DEFAULT 'pokemon';
ALTER TABLE markets ADD COLUMN IF NOT EXISTS scrydex_card_id TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS scrydex_expansion_id TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS requires_scrydex BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS jpy BOOLEAN NOT NULL DEFAULT false;
-- The prices.raw_updated webhook (§8) carries expansion_ids; this index makes "which tracked markets are
-- in these expansions" a fast lookup on the hot webhook path.
CREATE INDEX IF NOT EXISTS idx_markets_scrydex_expansion ON markets(scrydex_expansion_id) WHERE scrydex_expansion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_markets_game ON markets(game, kind, status);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS set_logo TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS price_pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS graded_psa10_e6 BIGINT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS cumulative_volume_uusdc BIGINT NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS tcgplayer_id BIGINT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS provider_card_id TEXT;
-- One market per provider card / per TCGplayer product (partial: legacy rows are NULL until backfilled).
-- This is the duplicate-market guard: a second create for the same physical card must conflict, not insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_provider_card ON markets(provider_card_id) WHERE provider_card_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_tcgplayer ON markets(tcgplayer_id) WHERE tcgplayer_id IS NOT NULL;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS low_confidence BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS mark_clamped BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS clamped_since TIMESTAMPTZ;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS mark_candidate_e6 BIGINT;

-- Append-only audit of the oracle's price-confidence gate flipping a card market between tradeable and
-- restricted (reduce-only). Powers the admin "restricted now" + "flipped today" views; one row per flip.
CREATE TABLE IF NOT EXISTS market_restriction_events (
  id          BIGSERIAL PRIMARY KEY,
  market_id   TEXT NOT NULL REFERENCES markets(id),
  restricted  BOOLEAN NOT NULL,  -- true = became low-confidence/reduce-only; false = recovered to tradeable
  reason      TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restriction_events_at ON market_restriction_events(at DESC);
CREATE INDEX IF NOT EXISTS idx_restriction_events_market ON market_restriction_events(market_id, at DESC);

-- Append-only audit of the mark guard (§6a) engaging/disengaging on a card market: one row per flip,
-- carrying the candidate (un-clamped) vs adopted (clamped) mark at the transition. Powers the admin
-- "mark guards" panel + the engage/disengage history, mirroring market_restriction_events.
CREATE TABLE IF NOT EXISTS mark_clamp_events (
  id           BIGSERIAL PRIMARY KEY,
  market_id    TEXT NOT NULL REFERENCES markets(id),
  clamped      BOOLEAN NOT NULL,  -- true = guard engaged (mark capped); false = disengaged (candidate adopted)
  candidate_e6 BIGINT NOT NULL,   -- the un-clamped candidate mark at the flip
  adopted_e6   BIGINT NOT NULL,   -- the mark actually written this update
  reason       TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clamp_events_at ON mark_clamp_events(at DESC);
CREATE INDEX IF NOT EXISTS idx_clamp_events_market ON mark_clamp_events(market_id, at DESC);

CREATE TABLE IF NOT EXISTS index_constituents (
  id        TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES markets(id),
  card_id   TEXT NOT NULL,
  weight_e6 BIGINT NOT NULL,
  as_of     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_constituents_market ON index_constituents(market_id, as_of);

CREATE TABLE IF NOT EXISTS index_divisors (
  market_id    TEXT PRIMARY KEY REFERENCES markets(id),
  divisor_e6   BIGINT NOT NULL,
  base_value_e6 BIGINT NOT NULL,
  as_of        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================================
-- Oracle prints + computed marks
-- =========================================================================
CREATE TABLE IF NOT EXISTS oracle_prices (
  id                 BIGSERIAL PRIMARY KEY,
  market_id          TEXT NOT NULL REFERENCES markets(id),
  index_price_e6     BIGINT NOT NULL,
  raw_payload        JSONB,
  source_observed_at TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_accepted        BOOLEAN NOT NULL DEFAULT true,
  reject_reason      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_oracle_market_observed ON oracle_prices(market_id, source_observed_at);

CREATE TABLE IF NOT EXISTS marks (
  id             BIGSERIAL PRIMARY KEY,
  market_id      TEXT NOT NULL REFERENCES markets(id),
  mark_price_e6  BIGINT NOT NULL,
  index_price_e6 BIGINT NOT NULL,
  skew_uusdc     BIGINT NOT NULL DEFAULT 0,
  premium_e6     BIGINT NOT NULL DEFAULT 0,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marks_market ON marks(market_id, computed_at);

-- Provider-sourced pre-listing price history (tcgpricelookup /cards/:id/history), seeded once per
-- market so charts aren't empty on day one. Kept SEPARATE from marks on purpose: a mark is a price
-- someone could have traded at on THIS venue; these are the card market's prior prices. getCandles
-- only reads seed days that precede the market's first mark — real marks always win. A single
-- price_e6=0 row is the "provider has no history" sentinel (renders nowhere, stops re-fetching).
CREATE TABLE IF NOT EXISTS chart_seed (
  market_id TEXT NOT NULL REFERENCES markets(id),
  day       DATE NOT NULL,
  price_e6  BIGINT NOT NULL,
  PRIMARY KEY (market_id, day)
);

-- Cross-provider price data lake (docs/scrydex-pricing-build-spec.md §15): one row per TCGplayer
-- product (the globally-unique cross-provider join key), holding the raw TCGplayer market price + the
-- FULL price payload from BOTH feeds for every card whose raw market is ≥ the listing floor in either
-- feed. Built by scripts/build-price-index.ts (Scrydex enum + tcgpl crawl). NOT the live trading
-- universe — it's the analysis/derivation substrate (rank top-N per game by best-available price) and
-- the on-demand listing-eligibility set. Re-runnable; full payloads stored so re-derivation never
-- needs a re-fetch.
CREATE TABLE IF NOT EXISTS price_index (
  tcgplayer_id         BIGINT PRIMARY KEY,        -- TCGplayer product id (unique across all products/games)
  game                 TEXT NOT NULL,             -- 'pokemon' | 'onepiece' | 'mtg'
  name                 TEXT,
  -- Scrydex side (raw = TCGplayer ungraded market, FX→USD if the printing is JPY)
  scrydex_card_id      TEXT,
  scrydex_expansion_id TEXT,
  scrydex_variant      TEXT,
  scrydex_raw_usd      NUMERIC,
  scrydex_prices       JSONB,                     -- full variant prices[] (raw + graded + trends)
  -- tcgpricelookup side (TCGplayer market is USD; eBay averages kept for cross-check/refinement)
  tcgpl_card_id        TEXT,                      -- the tcgpl card UUID (= markets.provider_card_id)
  tcgpl_set            TEXT,
  tcgpl_number         TEXT,
  tcgpl_raw_usd        NUMERIC,
  tcgpl_ebay_7d        NUMERIC,
  tcgpl_prices         JSONB,                     -- full prices object (raw {tcgplayer,ebay} + graded)
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_index_game_scrydex ON price_index(game, scrydex_raw_usd DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_price_index_game_tcgpl   ON price_index(game, tcgpl_raw_usd   DESC NULLS LAST);

-- =========================================================================
-- Positions / orders / fills
-- =========================================================================
CREATE TABLE IF NOT EXISTS positions (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id),
  market_id                 TEXT NOT NULL REFERENCES markets(id),
  side                      TEXT NOT NULL,            -- long | short
  qty_e6                    BIGINT NOT NULL,
  avg_entry_e6              BIGINT NOT NULL,
  margin_uusdc              BIGINT NOT NULL,
  leverage_e2               INT NOT NULL,
  realized_pnl_uusdc        BIGINT NOT NULL DEFAULT 0,
  funding_index_snapshot_e6 BIGINT NOT NULL DEFAULT 0,
  liq_price_e6              BIGINT NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'open',  -- open|closed|liquidated|deleveraged
  opened_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at                 TIMESTAMPTZ,
  version                   BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_position ON positions(user_id, market_id, side) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  market_id       TEXT NOT NULL REFERENCES markets(id),
  idempotency_key TEXT NOT NULL,
  kind            TEXT NOT NULL,           -- market | reduce_only
  side            TEXT NOT NULL,
  qty_e6          BIGINT NOT NULL,
  leverage_e2     INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  reject_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idempotency is scoped per user, not global, so one user's key can't collide with another's.
-- On upgraded DBs the old global UNIQUE survives CREATE TABLE IF NOT EXISTS; drop it so the
-- composite (user_id, idempotency_key) is the only uniqueness (no-op on a fresh DB).
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_idempotency_key_key;
DROP INDEX IF EXISTS orders_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_user_idem ON orders(user_id, idempotency_key);
-- Audit: which key actually placed the order. NULL = the account's own (master) key; set to the
-- delegate pubkey when a trade-scoped delegated key placed it. (no-op on a fresh DB)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS actor_pubkey TEXT;

CREATE TABLE IF NOT EXISTS fills (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders(id),
  position_id        TEXT NOT NULL REFERENCES positions(id),
  market_id          TEXT NOT NULL REFERENCES markets(id),
  exec_price_e6      BIGINT NOT NULL,
  qty_e6             BIGINT NOT NULL,
  fee_uusdc          BIGINT NOT NULL DEFAULT 0,
  impact_e6          BIGINT NOT NULL DEFAULT 0,
  realized_pnl_uusdc BIGINT NOT NULL DEFAULT 0,
  txn_id             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fills_position ON fills(position_id, created_at);
-- the retirement sweep's "no volume in N days" anti-join probes by market + recency (P6)
CREATE INDEX IF NOT EXISTS idx_fills_market_created ON fills(market_id, created_at);

-- =========================================================================
-- Funding / LP pool / liquidations
-- =========================================================================
CREATE TABLE IF NOT EXISTS funding_rates (
  id                  BIGSERIAL PRIMARY KEY,
  market_id           TEXT NOT NULL REFERENCES markets(id),
  interval_start      TIMESTAMPTZ NOT NULL,
  interval_end        TIMESTAMPTZ NOT NULL,
  rate_e6             BIGINT NOT NULL,        -- signed
  skew_uusdc          BIGINT NOT NULL DEFAULT 0,
  cumulative_index_e6 BIGINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_funding_market ON funding_rates(market_id, interval_end);

CREATE TABLE IF NOT EXISTS lp_pool (
  id                    TEXT PRIMARY KEY,
  total_assets_uusdc    BIGINT NOT NULL DEFAULT 0,
  total_shares          BIGINT NOT NULL DEFAULT 0,
  reserved_for_oi_uusdc BIGINT NOT NULL DEFAULT 0,
  version               BIGINT NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lp_positions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  shares           BIGINT NOT NULL DEFAULT 0,
  cost_basis_uusdc BIGINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lp_user ON lp_positions(user_id);

CREATE TABLE IF NOT EXISTS liquidations (
  id                    TEXT PRIMARY KEY,
  position_id           TEXT NOT NULL REFERENCES positions(id),
  market_id             TEXT NOT NULL REFERENCES markets(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  trigger_mark_e6       BIGINT NOT NULL,
  closed_qty_e6         BIGINT NOT NULL,
  liquidation_fee_uusdc BIGINT NOT NULL DEFAULT 0,
  bad_debt_uusdc        BIGINT NOT NULL DEFAULT 0,
  insurance_drawn_uusdc BIGINT NOT NULL DEFAULT 0,
  socialized_uusdc      BIGINT NOT NULL DEFAULT 0,
  txn_id                TEXT,
  mark_guarded          BOOLEAN NOT NULL DEFAULT false, -- the mark was clamped (§6a guard engaged) at liquidation time
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE liquidations ADD COLUMN IF NOT EXISTS mark_guarded BOOLEAN NOT NULL DEFAULT false;

-- =========================================================================
-- Real-funds custody (P0 foundation — tables only; deposit/withdraw paths
-- land behind REAL_FUNDS in later phases). See docs/real-funds-custody-plan.md.
-- =========================================================================
-- One HD-derived Solana deposit address per user (master seed lives in KMS, never here).
CREATE TABLE IF NOT EXISTS deposit_addresses (
  user_id          TEXT PRIMARY KEY REFERENCES users(id),
  address          TEXT UNIQUE NOT NULL,
  derivation_index INT  UNIQUE NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inbound deposits. UNIQUE(onchain_sig, asset) makes crediting idempotent (re-scans can't
-- double-credit) while allowing one tx to carry both SOL and USDC. USDC rows credit directly;
-- SOL rows are swapped in place via Jupiter and NEVER credit — the swap's USDC proceeds land on
-- the deposit address and are detected + credited as their own USDC row (sig = the swap tx),
-- which makes the swap crash-safe and double-credit structurally impossible. Sub-minimum dust is
-- recorded as a terminal 'ignored' row so it is never re-parsed (and never credits).
CREATE TABLE IF NOT EXISTS deposits (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  onchain_sig      TEXT NOT NULL,                    -- inbound transfer signature
  asset            TEXT NOT NULL,                    -- 'USDC' | 'SOL'
  amount_in_raw    BIGINT NOT NULL,                  -- raw units of `asset` (lamports / micro-USDC)
  usdc_credited_e6 BIGINT,                           -- ACTUAL credited proceeds; never clamped (USDC rows)
  swap_sig         TEXT,                             -- Jupiter swap signature (SOL rows)
  sweep_sig        TEXT,                             -- deposit-wallet -> treasury sweep signature
  status           TEXT NOT NULL DEFAULT 'detected', -- detected|swapping|swapped|credited|ignored
  txn_id           TEXT,                             -- ledger txn id once credited
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_sig_asset ON deposits(onchain_sig, asset);
CREATE INDEX IF NOT EXISTS idx_deposits_user   ON deposits(user_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
-- upgrade DBs created on the P0/P1 schema (no-ops on fresh)
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS sweep_sig TEXT;
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_onchain_sig_key;

-- Deposit-scan high-water marks: the newest fully-processed signature per scanned chain address
-- and asset. The scanner pages the RPC signature history backwards only until this mark, so a
-- backlog (or adversarial dust-spam) larger than one RPC page can never evict — and thereby
-- permanently strand — an unprocessed deposit. Advanced only after the pass's deposits rows are
-- recorded, and only when the pagination completed (crash/backlog-safe in both directions).
CREATE TABLE IF NOT EXISTS deposit_scan_cursors (
  address    TEXT NOT NULL REFERENCES deposit_addresses(address),
  asset      TEXT NOT NULL,                -- 'USDC' | 'SOL' (scanned via different chain addresses)
  high_sig   TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (address, asset)
);

-- Operational flags. Today: 'withdrawals_frozen' — set automatically by the treasury worker when
-- proof-of-reserves breaches (on-chain custody < ledger liabilities); cleared ONLY by an operator
-- (a PoR breach is an incident, not a self-healing condition). Deposits continue while frozen.
CREATE TABLE IF NOT EXISTS system_flags (
  key        TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbound withdrawals. Two-phase: ledger debited at `signed`, BEFORE broadcast; signed_tx +
-- onchain_sig persisted at signing so a crash can only re-broadcast the SAME tx (idempotent),
-- never double-pay. Reversed only when the sig is definitively absent + abandoned.
CREATE TABLE IF NOT EXISTS withdrawals (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  dest_address    TEXT NOT NULL,
  amount_e6       BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'requested', -- requested|signed|broadcast|confirmed|failed|reversed
  signed_tx       TEXT,                              -- base64 signed tx (persisted before broadcast)
  onchain_sig     TEXT UNIQUE,                       -- known at signing time (globally unique — it's a chain sig)
  idempotency_key TEXT NOT NULL,                     -- per-user idempotency (see composite index below)
  txn_id          TEXT,                              -- ledger debit txn id (two-phase)
  reason          TEXT,                              -- failure / reversal note
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_at       TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user   ON withdrawals(user_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
-- Idempotency is scoped per user, not global (mirror orders): a global UNIQUE would let a malicious
-- user pre-claim a predictable key to grief another user's withdrawal (denial-of-funds) and leak
-- cross-account activity via the unique-violation error. Drop the legacy global UNIQUE created by the
-- P0 schema; the composite (user_id, idempotency_key) is the only uniqueness (no-op on a fresh DB).
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_idempotency_key_key;
DROP INDEX IF EXISTS withdrawals_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawals_user_idem ON withdrawals(user_id, idempotency_key);

-- Operator-tunable settings (key/value). Backs the live-editable custody limits in the admin panel;
-- absent keys fall back to the config.ts/env defaults. Generic so other runtime knobs can reuse it.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global rate-limit/budget state for external price providers (one row per provider key). The limit is
-- per API KEY, not per process, so the token-bucket state must live in the DB: every instance claims its
-- next slot here (SELECT .. FOR UPDATE), which serializes requests globally at the provider's pace and
-- counts the shared daily budget. See services/providers/limiter.ts.
CREATE TABLE IF NOT EXISTS provider_rate (
  key          TEXT PRIMARY KEY,            -- provider name, e.g. 'tcgpricelookup'
  next_slot_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- when the next request may be sent
  day          DATE NOT NULL DEFAULT CURRENT_DATE, -- which day used_today counts
  used_today   INT  NOT NULL DEFAULT 0
);

-- Set release-year cache. Seeded on boot from the committed static table (services/providers/
-- set-years.data.ts) — the price oracle carries no release dates, so there is nothing to fetch at
-- runtime. Every card maps to its set's year by slug (or game+name) with no per-card provider call;
-- a set with no known year is simply absent (or release_year NULL) → that card shows no year.
CREATE TABLE IF NOT EXISTS tcg_sets (
  game         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  name         TEXT,
  release_year INT,  -- the only field the UI reads
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game, slug)  -- slugs are per-game; (game, slug) avoids a cross-game collision clobbering a row
);
CREATE INDEX IF NOT EXISTS idx_tcg_sets_game_name ON tcg_sets(game, name);

-- Single-leader leases for background loops (oracle ingest, discovery rebalance): with N API
-- instances only the lease holder runs a pass, so work isn't duplicated N× (the rate LIMIT is already
-- safe via provider_rate; this guards the budget + duplicate writes). Expired leases are taken over.
CREATE TABLE IF NOT EXISTS worker_leases (
  key        TEXT PRIMARY KEY, -- loop name, e.g. 'oracle-ingest'
  holder     TEXT NOT NULL,    -- per-process random id
  expires_at TIMESTAMPTZ NOT NULL
);

-- Min order size (idempotent backfill): shrink the qty step to 0.0001 units so the $1 min-notional floor
-- (enforced in the engine) is reachable on high-priced cards — the old 0.01-unit step inflated the floor
-- to step×price (~$50 on a $5k card). The dollar dust floor is the notional check, so a flat fine min_qty
-- is safe. Runs every boot but no-ops once every market is already at the fine step.
ALTER TABLE markets ALTER COLUMN min_qty_e6 SET DEFAULT 100;
ALTER TABLE markets ALTER COLUMN qty_step_e6 SET DEFAULT 100;
UPDATE markets SET qty_step_e6 = 100 WHERE qty_step_e6 <> 100;
UPDATE markets SET min_qty_e6 = 100 WHERE min_qty_e6 <> 100;

-- =========================================================================
-- Games surface (docs/games-spec.md). Provably-fair real-money games whose prize is a tokenized card
-- that settles to USDC at the platform oracle mark. Wagers/prizes move through the GAME_POOL ledger
-- account; the reconciler proves every play balances. Idempotent (CREATE ... IF NOT EXISTS).
-- =========================================================================

-- Per-user provable-fairness state for the SOLO (instant) games — the rotating commit-reveal seed.
-- The commit hash + client seed + nonce are shown up front; nonce++ per play; the server seed is
-- revealed (and a new one committed) when the player rotates their client seed.
CREATE TABLE IF NOT EXISTS game_seeds (
  user_id          TEXT PRIMARY KEY REFERENCES users(id),
  server_seed      TEXT NOT NULL,      -- secret until rotation
  server_seed_hash TEXT NOT NULL,      -- sha256(server_seed) — the public commitment
  client_seed      TEXT NOT NULL,      -- player-chosen (or a fresh default)
  nonce            BIGINT NOT NULL DEFAULT 0,
  rotated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multiplayer / round audit (created now; exercised by the PvP/round games in later phases). Resolution
-- uses the shared worker_leases table (lease.ts), same as the oracle/funding loops.
CREATE TABLE IF NOT EXISTS game_rounds (
  id               TEXT PRIMARY KEY,
  game_type        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',  -- open | resolving | settled | cancelled
  server_seed      TEXT,
  server_seed_hash TEXT,
  pot_uusdc        BIGINT NOT NULL DEFAULT 0,
  prize_uusdc      BIGINT NOT NULL DEFAULT 0,
  params           JSONB,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);

-- Every play. Replay-safe via UNIQUE(user_id, idempotency_key) (the engine's anchorOrder pattern): a
-- duplicate request returns the prior result instead of re-running. `result` is the game-specific
-- reveal payload; the fairness columns let any play be recomputed from (server_seed, client_seed, nonce).
CREATE TABLE IF NOT EXISTS game_plays (
  id               TEXT PRIMARY KEY,
  game_type        TEXT NOT NULL,
  round_id         TEXT REFERENCES game_rounds(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  idempotency_key  TEXT NOT NULL,
  wager_uusdc      BIGINT NOT NULL,
  result           JSONB,
  payout_uusdc     BIGINT NOT NULL DEFAULT 0,
  server_seed_hash TEXT,
  client_seed      TEXT,
  nonce            BIGINT,
  txn_id           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_game_plays_user_key ON game_plays(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_game_plays_user ON game_plays(user_id, created_at DESC);
-- At most one OPEN Set Poker hand per user — backstops the race between two concurrent deals (whose
-- "another open hand?" checks both pass while the new rows still have a NULL status): the second hand's
-- UPDATE to status='open' then fails this constraint and rolls back, instead of leaving two open hands.
CREATE UNIQUE INDEX IF NOT EXISTS uq_setpoker_open_hand ON game_plays(user_id) WHERE game_type = 'set-poker' AND result->>'status' = 'open';
-- The Break: list a case's entrants (every game_plays row in the round settles on fill).
CREATE INDEX IF NOT EXISTS idx_game_plays_round ON game_plays(round_id) WHERE round_id IS NOT NULL;
-- Card Fantasy: at most one roster per user per league (multi-entry is a v2 feature).
CREATE UNIQUE INDEX IF NOT EXISTS uq_fantasy_one_entry ON game_plays(round_id, user_id) WHERE game_type = 'card-fantasy';
-- Draft Arena: at most one seat per user per lobby.
CREATE UNIQUE INDEX IF NOT EXISTS uq_arena_one_entry ON game_plays(round_id, user_id) WHERE game_type = 'draft-arena';
-- At most one OPEN round per game type — backstops the race between two concurrent The Break joins that
-- both find no open case and create one; the second create then fails this constraint and rolls back.
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_round_per_game ON game_rounds(game_type) WHERE status = 'open';

-- A won card. value_e6 = the oracle mark captured AT WIN; on sell-back it settles to USDC at the live
-- mark minus the buyback spread (recorded in sell_value_e6). status: held (just won) | sold | kept.
CREATE TABLE IF NOT EXISTS game_prizes (
  id            TEXT PRIMARY KEY,
  play_id       TEXT REFERENCES game_plays(id),
  round_id      TEXT REFERENCES game_rounds(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  market_id     TEXT NOT NULL REFERENCES markets(id),
  value_e6      BIGINT NOT NULL,        -- oracle mark at win
  sell_value_e6 BIGINT,                 -- USDC actually paid on sell-back
  status        TEXT NOT NULL DEFAULT 'held',  -- held | sold | kept
  txn_id        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);
-- Buyback terms SNAPSHOT at win time so the sell-back honours the contract the player won under, even if
-- the source game's config is retuned afterwards (and so each game's prize uses ITS own spread/cap).
ALTER TABLE game_prizes ADD COLUMN IF NOT EXISTS spread_bps INT;
ALTER TABLE game_prizes ADD COLUMN IF NOT EXISTS max_prize_e6 BIGINT;
-- Value multiplier applied to the card's live mark at sell-back (Grade Gamble's rolled grade). 10000 = 1×
-- (Pack Rip / Set Poker prizes leave it at the default, so they sell at the plain mark).
ALTER TABLE game_prizes ADD COLUMN IF NOT EXISTS multiplier_bps INT NOT NULL DEFAULT 10000;
CREATE INDEX IF NOT EXISTS idx_game_prizes_user ON game_prizes(user_id, status);

-- ─────────────────────────── Classic Gacha (docs/classic-gacha-cc-packs-spec.md) ───────────────────────────
-- Real Collector Crypt graded-card packs. P0 = read-only lobby; P1 = buy → open → sell-back (these tables).
-- A pack purchase/open: the idempotency anchor + state machine. The receipt row is written BEFORE the
-- on-chain payment (crash-safe — a paid-but-undelivered pack is finished by the reconciler). status:
-- pending (anchored) | paid (CC paid, awaiting reveal) | opened (NFT held) | turbo_sold (Common auto-sold)
-- | refunded (CC refunded) | failed (no payment ever landed). A row with payment_sig is NEVER auto-failed.
CREATE TABLE IF NOT EXISTS gacha_pack_opens (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  idempotency_key  TEXT NOT NULL,
  machine_code     TEXT NOT NULL,                    -- CC packType, e.g. 'pokemon_50'
  price_e6         BIGINT NOT NULL,                  -- charged price (micro-USDC)
  paid_with        TEXT NOT NULL DEFAULT 'usdc',     -- usdc | gold (P4 loyalty)
  turbo            BOOLEAN NOT NULL DEFAULT false,
  cc_memo          TEXT UNIQUE,                      -- CC receipt; set after generatePack
  payment_sig      TEXT,                             -- on-chain payment signature (set ⇒ money may have moved ⇒ never auto-fail)
  payment_attempted_at TIMESTAMPTZ,                  -- stamped right before submitTransaction ⇒ a CC payment was attempted (may have landed). NULL ⇒ sold-out generatePack / pre-submit fail ⇒ no money reached CC ⇒ safe to refund now
  custody_pubkey   TEXT,                             -- the user's dedicated NFT-custody wallet (payer + NFT recipient)
  status           TEXT NOT NULL DEFAULT 'pending',
  nft_mint         TEXT, nft_name TEXT, nft_image TEXT, grade TEXT, insured_value_e6 BIGINT, rarity TEXT,
  nft_market_id    TEXT,                              -- matched GDEX market (P3 trade tie-in; often NULL)
  nft_year         TEXT,                              -- card year, for the reveal "Issued" beat
  turbo_refund_e6  BIGINT,                            -- USDC paid on a turbo Common auto-sell (deferred)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at        TIMESTAMPTZ,
  settled_at       TIMESTAMPTZ
);
ALTER TABLE IF EXISTS gacha_pack_opens ADD COLUMN IF NOT EXISTS payment_attempted_at TIMESTAMPTZ; -- additive: pre-submit "no money reached CC" marker (existing DBs)
CREATE UNIQUE INDEX IF NOT EXISTS uq_gacha_opens_user_idem ON gacha_pack_opens(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_gacha_opens_user ON gacha_pack_opens(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gacha_opens_paid ON gacha_pack_opens(status) WHERE status = 'paid'; -- reconciler scan

-- A won NFT held in the user's GDEX custody wallet (the Portfolio → Inventory source; mirrored vs DAS).
-- status: held | selling (mid-buyback) | sold (CC buyback done) | withdrawing | withdrawn (real NFT sent out — P2).
CREATE TABLE IF NOT EXISTS gacha_nft_inventory (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  open_id          TEXT REFERENCES gacha_pack_opens(id),
  mint             TEXT NOT NULL,                   -- on-chain truth; NOT globally unique (see the partial unique below)
  custody_pubkey   TEXT NOT NULL,
  name TEXT, grade TEXT, set_name TEXT, year TEXT, image_url TEXT,
  insured_value_e6 BIGINT,                           -- CC insured value at win (advisory)
  market_id        TEXT REFERENCES markets(id),      -- matched GDEX market (often NULL — most CC cards aren't featured)
  status           TEXT NOT NULL DEFAULT 'held',
  sell_value_e6    BIGINT, sell_cut_e6 BIGINT, txn_id TEXT,
  withdraw_dest    TEXT, withdraw_sig TEXT,           -- P2 (withdraw the real slab)
  acquired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gacha_inventory_user ON gacha_nft_inventory(user_id, status);
-- A mint is unique only among ACTIVE holders: CC's buyback returns a sold-back NFT to its pool, where it can be
-- re-rolled to a NEW owner — so historical 'sold'/'withdrawn' rows for the same mint must NOT block the new
-- delivery's row (the old global UNIQUE(mint) did, causing "paid but no card in inventory"). Drop it; enforce
-- the real invariant (one active holder per mint), and move recordReveal's idempotency to the open (one row/open).
ALTER TABLE IF EXISTS gacha_nft_inventory DROP CONSTRAINT IF EXISTS gacha_nft_inventory_mint_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gacha_inv_active_mint ON gacha_nft_inventory(mint) WHERE status IN ('held','withdrawing');
CREATE UNIQUE INDEX IF NOT EXISTS uq_gacha_inv_open ON gacha_nft_inventory(open_id);

-- Loyalty Gold (P4; 1 Gold = $0.001). A per-player points currency, separate from the USDC ledger and from
-- on-chain $GDEX: non-transferable, non-withdrawable. Earned on paid (USDC) opens; spent to buy packs. The
-- reconciler invariant is Σ gold_ledger.delta == gold_balances.balance per user (no Σ=0 cross-account partner).
-- Renamed from token_balances/token_ledger — idempotent + data-preserving (the ALTERs run before the CREATEs).
ALTER TABLE IF EXISTS token_balances RENAME TO gold_balances;
ALTER TABLE IF EXISTS token_ledger RENAME TO gold_ledger;
ALTER INDEX IF EXISTS idx_token_ledger_user RENAME TO idx_gold_ledger_user;
CREATE TABLE IF NOT EXISTS gold_balances (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  balance BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS gold_ledger (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  delta      BIGINT NOT NULL,                         -- signed Gold; + earn / - spend
  reason     TEXT NOT NULL,                           -- PACK_OPEN_EARN | PACK_BUY_GOLD | GDEX_HOLD_EARN | TRADE_EARN | LP_EARN
  ref_type   TEXT, ref_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gold_ledger_user ON gold_ledger(user_id, created_at DESC);

-- Classic Gacha: persisted CC machine stock + a restock log, so the operator sees restocks that happened
-- while no admin tab was open (a poll worker upserts the latest stock and appends an event on any increase).
CREATE TABLE IF NOT EXISTS gacha_machine_stock (
  machine_code TEXT NOT NULL,
  tier         TEXT NOT NULL,
  stock        INT  NOT NULL,                          -- latest CC count (updated every poll, incl. decreases)
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_code, tier)
);
CREATE TABLE IF NOT EXISTS gacha_restock_events (
  id           BIGSERIAL PRIMARY KEY,
  machine_code TEXT NOT NULL,
  tier         TEXT NOT NULL,
  from_stock   INT  NOT NULL,
  to_stock     INT  NOT NULL,
  delta        INT  NOT NULL,                          -- to_stock − from_stock, always > 0 (an increase = a restock)
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gacha_restock_recent ON gacha_restock_events(detected_at DESC);

-- Resting orders: limit / stop-loss / take-profit (docs/limit-stop-orders-spec.md). A trigger that, when
-- the mark crosses trigger_price_e6, market-fills at the mark via the engine's *InTx primitives in ONE tx.
-- P1 wires 'limit' (open); SL/TP (reduce-only, position-attached) land in P2. All additive + idempotent.
CREATE TABLE IF NOT EXISTS resting_orders (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id),
  market_id             TEXT NOT NULL REFERENCES markets(id),
  position_id           TEXT REFERENCES positions(id),     -- stop_loss / take_profit only
  kind                  TEXT NOT NULL,                     -- limit | stop_loss | take_profit
  reduce_only           BOOLEAN NOT NULL DEFAULT false,
  side                  TEXT,                              -- limit-open only; NULL for reduce-only (derived)
  qty_e6                BIGINT,                            -- limit only; SL/TP store full-close intent
  leverage_e2           INT,                               -- limit-open only
  trigger_price_e6      BIGINT NOT NULL,                   -- the price the mark must cross
  slippage_e6           BIGINT,                            -- worst acceptable fill; for a limit = trigger price
  reserved_margin_uusdc BIGINT NOT NULL DEFAULT 0,         -- limit-open reservation (a floor)
  status                TEXT NOT NULL DEFAULT 'active',    -- active | filled | cancelled
  reject_reason         TEXT,
  idempotency_key       TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_resting_user_idem ON resting_orders(user_id, idempotency_key);
-- one active SL + one active TP per position (P2)
CREATE UNIQUE INDEX IF NOT EXISTS uq_resting_pos_kind ON resting_orders(position_id, kind) WHERE status='active' AND reduce_only;
-- the trigger sweep range-scans active orders per market
CREATE INDEX IF NOT EXISTS idx_resting_active ON resting_orders(market_id, kind, trigger_price_e6) WHERE status='active';
