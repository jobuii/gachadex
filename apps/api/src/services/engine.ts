import { randomUUID } from 'node:crypto';
import { notional, initialMargin, maintenanceMargin, unrealizedPnl, liquidationPrice, fee, MIN_NOTIONAL_UUSDC } from '@pokex/pricing';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { advisoryXactLock, type Db, type Queryer } from '../db/client.ts';
import { getMarketById, type MarketRow } from './markets.ts';
import { recomputeMark } from './marks.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, getBalance, postTxn } from './ledger.ts';
import { getFeeBps, getLiqFeeBps } from './fees.ts';
import { getBigBetUsd, getBigWinUsd } from './chat-config.ts';
import { emitChatEvent, type ChatEventInput } from './chat.ts';
import { refreshReserved } from './lp.ts';
import { getCumulativeFundingE6, settlePositionFunding } from './funding.ts';
import { openNotionalBySide } from './oi.ts';
import { publish } from './bus.ts';
import { usdc } from '../money.ts';
import { resolveFeeAffiliate, applyFeeDiscount, type FeeAffiliate } from './affiliate.ts';

/** Charge a trading fee, split between LPs and platform revenue (a balanced ledger txn). When the trader
 *  was referred by an affiliate, a second balanced txn pays that affiliate their cashback out of the
 *  house revenue share (never the LP share). */
async function chargeFee(
  q: Queryer,
  userId: string,
  feeAmt: bigint,
  reason: string,
  refId: string,
  cashback?: FeeAffiliate['cashback'],
): Promise<void> {
  if (feeAmt <= 0n) return;
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
  const rev = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
  const lpPart = (feeAmt * BigInt(config.feeLpSharePct)) / 100n;
  const revPart = feeAmt - lpPart;
  await postTxn(q, {
    reason,
    refType: 'fee',
    refId,
    entries: [
      { accountId: coll, amount: -feeAmt },
      { accountId: lp, amount: lpPart },
      { accountId: rev, amount: revPart },
    ],
  });
  // Referral cashback: move a slice of the house revenue share to the referring affiliate. Clamp to
  // revPart so FEE_REVENUE can never go negative (runtime guard, in case feeLpSharePct changed since the
  // terms were set). cashback.userId is always the referrer (never the trader — self-redeem is blocked).
  if (cashback && cashback.bps > 0 && cashback.userId !== userId) {
    const want = (feeAmt * BigInt(cashback.bps)) / 10000n;
    const cb = want > revPart ? revPart : want;
    if (cb > 0n) {
      const affColl = await getOrCreateUserAccount(q, cashback.userId, 'USER_COLLATERAL');
      await postTxn(q, {
        reason: 'REFERRAL_CASHBACK',
        refType: 'fee',
        refId,
        entries: [
          { accountId: rev, amount: -cb },
          { accountId: affColl, amount: cb },
        ],
      });
    }
  }
}

/**
 * The trading engine. One position lifecycle: open / increase / decrease / close, as
 * MARKET orders priced at the current synthetic mark, with the LP pool as counterparty.
 * Isolated margin, up to the market's max leverage. All money math is integer (BigInt)
 * via @pokex/pricing, and all balance changes go through the double-entry ledger.
 *
 * Single-writer per market: operations on the same market serialize through an in-process
 * mutex, and the whole operation runs in one db transaction.
 */

// ---- per-market mutex (single-writer) -------------------------------------
const chains = new Map<string, Promise<unknown>>();
function withMarketLock<T>(marketId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(marketId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(
    marketId,
    run.catch(() => {}),
  );
  return run;
}

// ---- row helpers ----------------------------------------------------------
const POS_COLS = `p.id, p.user_id, p.market_id, p.side, p.qty_e6::text AS qty_e6, p.avg_entry_e6::text AS avg_entry_e6,
  p.margin_uusdc::text AS margin_uusdc, p.leverage_e2, p.liq_price_e6::text AS liq_price_e6,
  p.realized_pnl_uusdc::text AS realized_pnl_uusdc, p.funding_index_snapshot_e6::text AS funding_index_snapshot_e6, p.status`;

export interface PositionRow {
  id: string;
  user_id: string;
  market_id: string;
  side: 'long' | 'short';
  qty_e6: string;
  avg_entry_e6: string;
  margin_uusdc: string;
  leverage_e2: number;
  liq_price_e6: string;
  realized_pnl_uusdc: string;
  funding_index_snapshot_e6: string;
  status: string;
}

async function getOpenPosition(q: Queryer, userId: string, marketId: string, side: string): Promise<PositionRow | null> {
  const r = await q.query<PositionRow>(
    `SELECT ${POS_COLS} FROM positions p WHERE p.user_id=$1 AND p.market_id=$2 AND p.side=$3 AND p.status='open'`,
    [userId, marketId, side],
  );
  return r.rows[0] ?? null;
}

async function getPositionById(q: Queryer, id: string): Promise<PositionRow | null> {
  const r = await q.query<PositionRow>(`SELECT ${POS_COLS} FROM positions p WHERE p.id=$1`, [id]);
  return r.rows[0] ?? null;
}

/**
 * The order row is the in-tx idempotency anchor: insert it first, and a racing duplicate (same
 * user+key) inserts nothing. Returns the canonical order id (the one just inserted, or the prior
 * one on conflict) and whether THIS call won the race — callers replay instead of re-running.
 */
async function anchorOrder(
  q: Queryer,
  o: { id: string; userId: string; marketId: string; idempotencyKey: string; kind: string; side: string; qtyE6: bigint; leverageE2: number; actorPubkey?: string },
): Promise<{ orderId: string; inserted: boolean }> {
  const ins = await q.query<{ id: string }>(
    `INSERT INTO orders(id,user_id,market_id,idempotency_key,kind,side,qty_e6,leverage_e2,actor_pubkey,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'filled')
     ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
    [o.id, o.userId, o.marketId, o.idempotencyKey, o.kind, o.side, o.qtyE6.toString(), o.leverageE2, o.actorPubkey ?? null],
  );
  if (ins.rows[0]) return { orderId: ins.rows[0].id, inserted: true };
  const existing = await q.query<{ id: string }>(`SELECT id FROM orders WHERE user_id=$1 AND idempotency_key=$2`, [o.userId, o.idempotencyKey]);
  return { orderId: existing.rows[0].id, inserted: false };
}

/** Replay an open result from a prior order (used by both the pre-tx fast path and the in-tx anchor). */
async function replayOpen(q: Queryer, orderId: string): Promise<{ orderId: string; positionId: string; duplicate: true }> {
  const f = await q.query<{ position_id: string }>(`SELECT position_id FROM fills WHERE order_id=$1 LIMIT 1`, [orderId]);
  return { orderId, positionId: f.rows[0]?.position_id ?? '', duplicate: true };
}

/** Replay a close result from a prior order (used by both the pre-tx fast path and the in-tx anchor). */
async function replayClose(q: Queryer, orderId: string): Promise<{ orderId: string; realizedPnlUusdc: string; closedQtyE6: string; remainingQtyE6: string }> {
  const f = await q.query<{ realized_pnl_uusdc: string; qty_e6: string; position_id: string }>(
    `SELECT realized_pnl_uusdc::text AS realized_pnl_uusdc, qty_e6::text AS qty_e6, position_id FROM fills WHERE order_id=$1 LIMIT 1`,
    [orderId],
  );
  const remPos = f.rows[0] ? await getPositionById(q, f.rows[0].position_id) : null;
  return {
    orderId,
    realizedPnlUusdc: f.rows[0]?.realized_pnl_uusdc ?? '0',
    closedQtyE6: f.rows[0]?.qty_e6 ?? '0',
    remainingQtyE6: remPos && remPos.status === 'open' ? remPos.qty_e6 : '0',
  };
}

async function getLatestMarkIndex(q: Queryer, marketId: string): Promise<{ markE6: bigint; indexE6: bigint } | null> {
  const r = await q.query<{ m: string; i: string }>(
    `SELECT mark_price_e6::text AS m, index_price_e6::text AS i FROM marks WHERE market_id=$1 ORDER BY computed_at DESC, id DESC LIMIT 1`,
    [marketId],
  );
  return r.rows[0] ? { markE6: BigInt(r.rows[0].m), indexE6: BigInt(r.rows[0].i) } : null;
}

async function lpDepth(q: Queryer): Promise<bigint> {
  // Authoritative NAV = the LP_POOL ledger balance. (lp_pool.total_assets_uusdc is only synced
  // on deposit/withdraw and drifts as trades move the pool, so don't use it as the mark depth.)
  const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
  return getBalance(q, lp);
}

/**
 * B' adaptive price-impact depth for one market (docs/liquidity-hybrid-spec.md §3):
 *   depth = max(LP NAV, depthFloor, α · cumulativeVolume)
 * Per-market and self-deepening — a market starts at the floor and grows less price-sensitive as
 * real volume flows through it. NAV is kept as a lower bound so depth is never shallower than the
 * old NAV-based depth, and the floor stops a thin (0<NAV<skew) pool pinning the premium to its cap.
 * Integer-only, no exp() (fixed-point safe). Reads the market's freshly-bumped volume counter.
 */
async function marketDepth(q: Queryer, marketId: string): Promise<bigint> {
  const r = await q.query<{ v: string }>(`SELECT cumulative_volume_uusdc::text AS v FROM markets WHERE id=$1`, [marketId]);
  const volDepth = (config.depthAlphaE6 * BigInt(r.rows[0]?.v ?? '0')) / 1_000_000n;
  const floored = volDepth > config.depthFloorUusdc ? volDepth : config.depthFloorUusdc;
  const nav = await lpDepth(q);
  return nav > floored ? nav : floored; // depth = max(NAV, floor, α·cumulativeVolume)
}

/**
 * The single seam every fill writer goes through: persist the fill row AND credit the market's
 * cumulative traded volume with the fill's notional (qty × exec price). Routing all of open /
 * increase / close / liquidation (and future ADL) through here keeps volume from ever desyncing
 * from the fills ledger and means a new fill path can't forget to record its volume.
 */
async function insertFill(
  q: Queryer,
  f: { orderId: string; positionId: string; marketId: string; execPriceE6: bigint; qtyE6: bigint; feeUusdc: bigint; realizedPnlUusdc: bigint },
): Promise<void> {
  await q.query(
    `INSERT INTO fills(id,order_id,position_id,market_id,exec_price_e6,qty_e6,fee_uusdc,realized_pnl_uusdc)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), f.orderId, f.positionId, f.marketId, f.execPriceE6.toString(), f.qtyE6.toString(), f.feeUusdc.toString(), f.realizedPnlUusdc.toString()],
  );
  const vol = notional(f.qtyE6, f.execPriceE6);
  if (vol > 0n) {
    await q.query(`UPDATE markets SET cumulative_volume_uusdc = cumulative_volume_uusdc + $1 WHERE id=$2`, [vol.toString(), f.marketId]);
  }
}

/** Anchor a system-initiated close (liquidation / ADL) with a 'reduce_only' order. The prefixed key
 *  is unique per event, so these never dedupe (unlike the user paths' idempotent anchorOrder). */
async function insertSystemOrder(q: Queryer, pos: PositionRow, marketId: string, prefix: string): Promise<string> {
  const orderId = randomUUID();
  await q.query(
    `INSERT INTO orders(id,user_id,market_id,idempotency_key,kind,side,qty_e6,leverage_e2,status)
     VALUES($1,$2,$3,$4,'reduce_only',$5,$6,$7,'filled')`,
    [orderId, pos.user_id, marketId, `${prefix}-${pos.id}-${randomUUID()}`, pos.side, pos.qty_e6, pos.leverage_e2],
  );
  return orderId;
}

export interface OpenPositionPnl {
  id: string;
  userId: string;
  marketId: string;
  side: 'long' | 'short';
  qtyE6: bigint;
  entryE6: bigint;
  marginUusdc: bigint;
  markE6: bigint;
  pnlUusdc: bigint;
}

/** Every open position with its current unrealized PnL (marked to each market's latest mark).
 *  Shared by the MAX_PNL_FACTOR gate, the ADL backstop, and the operator analytics so all see the
 *  pool the same way. */
export async function openPositionPnls(q: Queryer): Promise<OpenPositionPnl[]> {
  const r = await q.query<{ id: string; user_id: string; market_id: string; side: string; qty_e6: string; avg_entry_e6: string; margin_uusdc: string; mark: string }>(
    `SELECT p.id, p.user_id, p.market_id, p.side, p.qty_e6::text AS qty_e6, p.avg_entry_e6::text AS avg_entry_e6,
            p.margin_uusdc::text AS margin_uusdc, k.mark_price_e6::text AS mark
     FROM positions p
     JOIN LATERAL (SELECT mark_price_e6 FROM marks WHERE market_id=p.market_id ORDER BY computed_at DESC LIMIT 1) k ON true
     WHERE p.status='open'`,
  );
  return r.rows.map((row) => {
    const side = row.side as 'long' | 'short';
    const qtyE6 = BigInt(row.qty_e6);
    const entryE6 = BigInt(row.avg_entry_e6);
    const markE6 = BigInt(row.mark);
    return { id: row.id, userId: row.user_id, marketId: row.market_id, side, qtyE6, entryE6, marginUusdc: BigInt(row.margin_uusdc), markE6, pnlUusdc: unrealizedPnl(side, qtyE6, entryE6, markE6) };
  });
}

/** A position's signed contribution to what the pool owes: a winner's profit in full; a loser's
 *  loss only down to its margin (isolated margin caps what the pool can collect). This is the
 *  CAPPED ("actually collectable at settlement") number — the raw figure is just `pnlUusdc`. */
export function poolLiabilityOf(p: OpenPositionPnl): bigint {
  return p.pnlUusdc < -p.marginUusdc ? -p.marginUusdc : p.pnlUusdc;
}

/** Net pool liability for an already-fetched position set. The single definition both the gate and
 *  ADL sum against NAV — ADL reuses this on the same `pnls` it scans for the top winner. */
function sumPoolLiability(pnls: OpenPositionPnl[]): bigint {
  return pnls.reduce((sum, p) => sum + poolLiabilityOf(p), 0n);
}

/**
 * The pool's net liability to traders if every open position closed at the current mark right now.
 * This is the figure the MAX_PNL_FACTOR gate (opens) and the ADL backstop (force-close) measure
 * against LP NAV.
 */
async function poolPnlLiability(q: Queryer): Promise<bigint> {
  return sumPoolLiability(await openPositionPnls(q));
}

/** Recompute the market mark from current open-interest skew and persist+publish it.
 *  Exported so the manual-price (admin) path recomputes the mark exactly like a trade does. */
export async function refreshMark(q: Queryer, market: MarketRow, indexE6: bigint): Promise<bigint> {
  const oi = await q.query<{ side: string; q: string }>(
    `SELECT side, COALESCE(SUM(qty_e6),0)::text AS q FROM positions WHERE market_id=$1 AND status='open' GROUP BY side`,
    [market.id],
  );
  let longQ = 0n;
  let shortQ = 0n;
  for (const row of oi.rows) {
    if (row.side === 'long') longQ = BigInt(row.q);
    else shortQ = BigInt(row.q);
  }
  const skewUusdc = ((longQ - shortQ) * indexE6) / 1_000_000n;
  const markE6 = await recomputeMark(q, market, indexE6, skewUusdc, await marketDepth(q, market.id));
  publish(`oi:${market.id}`, 'oi', {
    marketId: market.id,
    longUusdc: ((longQ * indexE6) / 1_000_000n).toString(),
    shortUusdc: ((shortQ * indexE6) / 1_000_000n).toString(),
  });
  return markE6;
}

/** Post-mutation refresh: recompute the mark from current skew and the pool's reserved capital. */
async function refreshMarketState(q: Queryer, market: MarketRow, indexE6: bigint): Promise<void> {
  await refreshMark(q, market, indexE6);
  await refreshReserved(q);
}

// ---- public types ---------------------------------------------------------
export interface OpenInput {
  marketId: string;
  side: 'long' | 'short';
  qtyE6: bigint;
  leverage: number;
  // slippage guard (optional): worst acceptable fill mark (micro-USD). long rejects if mark > this;
  // short rejects if mark < this. Bounds the gap between an agent's preview mark and the fill.
  limitPriceE6?: bigint;
  idempotencyKey: string;
  actorPubkey?: string; // delegate pubkey when a trade-scoped key placed it (audit); undefined for master
}
export interface CloseInput {
  positionId: string;
  fractionBps: number;
  idempotencyKey: string;
  actorPubkey?: string;
  // optional worst-acceptable fill for the close leg (resting SL/TP). long = floor, short = cap.
  // unset = no bound (every caller today). Enforced in closePositionInTx.
  slippageE6?: bigint;
}

async function validateMarketAndOrder(q: Queryer, input: OpenInput): Promise<MarketRow> {
  const market = await getMarketById(q, input.marketId);
  if (!market) throw new HttpError(404, 'market not found');
  if (!market.tradeable || market.status !== 'active') throw new HttpError(400, 'market not tradeable', 'market_halted');
  // Price-confidence gate: a card whose oracle signals are thin/disagreeing is reduce-only — no NEW
  // positions against a price we can't trust (closes go through a separate path and stay allowed).
  if (market.low_confidence) throw new HttpError(400, 'market restricted: low price confidence', 'market_restricted');
  const leverageE2 = input.leverage * 100;
  if (input.leverage < 1 || leverageE2 > market.max_leverage_e2) throw new HttpError(400, 'leverage out of range', 'leverage_out_of_range');
  if (input.qtyE6 < BigInt(market.min_qty_e6)) throw new HttpError(400, 'quantity below market minimum', 'quantity_below_min');
  if (input.qtyE6 % BigInt(market.qty_step_e6) !== 0n) throw new HttpError(400, 'quantity not on step', 'quantity_off_step');
  return market;
}

// The $1 dust floor (MIN_NOTIONAL_UUSDC from @pokex/pricing) is enforced on NOTIONAL (qty × mark) below,
// so it's price-aware — a fine qty step alone can't stop sub-$1 positions on cheap cards. Replaces the old
// per-market min_qty dust floor, which (rounded to the 0.01-unit step) inflated to step×price (~$50 on a $5k card).
export async function openPosition(db: Db, userId: string, input: OpenInput): Promise<{ orderId: string; positionId: string; duplicate?: boolean }> {
  // fast-path idempotency, scoped to the user (keys are not a global namespace)
  const prior = await db.query<{ id: string }>(`SELECT id FROM orders WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey]);
  if (prior.rows[0]) return replayOpen(db, prior.rows[0].id);

  // BIG BET action bar — captured inside the tx (where the notional is known), broadcast AFTER commit so
  // a chat failure can never roll back the trade. Stays null on a duplicate/replay, so we don't re-announce.
  const out = await withMarketLock(input.marketId, () =>
    db.tx(async (q) => {
      await advisoryXactLock(q, input.marketId); // DB-level single-writer per market
      return openPositionInTx(q, userId, input);
    }),
  );
  if (out.chat) await emitChatEvent(db, out.chat).catch(() => {}); // post-commit, non-fatal
  return out.result;
}

/**
 * Open/increase a position INSIDE an existing market lock + tx — the caller already holds
 * withMarketLock + db.tx + advisoryXactLock. The public openPosition is a thin wrapper; the
 * resting-order trigger loop (limit fills) calls this directly so a fill runs in one tx with no
 * nested db.tx / withMarketLock re-entry. Returns the result + a post-commit chat event (the caller
 * emits it AFTER commit so a chat failure can't roll back the trade).
 */
async function openPositionInTx(
  q: Queryer,
  userId: string,
  input: OpenInput,
): Promise<{ result: { orderId: string; positionId: string; duplicate?: boolean }; chat: ChatEventInput | null }> {
      let bigBet: ChatEventInput | null = null;
      const market = await validateMarketAndOrder(q, input);
      const mi = await getLatestMarkIndex(q, market.id);
      if (!mi) throw new HttpError(400, 'no price available for market');
      // Freshness invariant (P6): a market reactivated from retirement resets created_at, so its
      // newest mark may predate the current activation (a stale price from before it was delisted).
      // NEVER open a new position against such a mark — wait for a fresh oracle print. Closes and
      // liquidations are intentionally exempt (they must work on any market, stale or not).
      const fresh = await q.query(
        `SELECT 1 FROM marks WHERE market_id = $1 AND computed_at >= (SELECT created_at FROM markets WHERE id = $1) LIMIT 1`,
        [market.id],
      );
      if (!fresh.rows[0]) throw new HttpError(400, 'market is repricing — not yet open for new positions', 'market_repricing');
      const { markE6, indexE6 } = mi;
      if (notional(input.qtyE6, markE6) < MIN_NOTIONAL_UUSDC) {
        throw new HttpError(400, 'order below the $1 minimum', 'below_min_notional');
      }
      // slippage guard: reject if the fill mark moved past the caller's limit (long: cap, short: floor)
      if (input.limitPriceE6 != null && (input.side === 'long' ? markE6 > input.limitPriceE6 : markE6 < input.limitPriceE6)) {
        throw new HttpError(400, 'fill price moved past your limit price', 'slippage_exceeded');
      }
      const leverageE2 = input.leverage * 100;

      // In-tx idempotency guard: the order row is the anchor. A racing duplicate inserts
      // nothing and replays the prior result instead of running the side effects twice.
      const orderId = randomUUID();
      const anchor = await anchorOrder(q, { id: orderId, userId, marketId: market.id, idempotencyKey: input.idempotencyKey, kind: 'market', side: input.side, qtyE6: input.qtyE6, leverageE2, actorPubkey: input.actorPubkey });
      if (!anchor.inserted) return { result: await replayOpen(q, anchor.orderId), chat: null };

      const opp = input.side === 'long' ? 'short' : 'long';
      if (await getOpenPosition(q, userId, market.id, opp)) {
        throw new HttpError(400, `close your ${opp} position before opening a ${input.side}`);
      }

      const notion = notional(input.qtyE6, markE6);
      const margin = initialMargin(notion, leverageE2);
      if (margin <= 0n) throw new HttpError(400, 'order too small');
      const feeAff = await resolveFeeAffiliate(q, userId);
      const openFee = applyFeeDiscount(fee(notion, getFeeBps()), feeAff.discountBps);

      // ---- pool-protection checks (all per side) -----------------------------------------------
      const sideCap = input.side === 'long' ? BigInt(market.max_oi_long_uusdc) : BigInt(market.max_oi_short_uusdc);
      const sideOi = (await openNotionalBySide(q, market.id))[input.side === 'long' ? 'longOi' : 'shortOi'];
      // 1) static per-market OI cap (0 = no static cap) — cheapest, in-memory; reject before any NAV read
      if (sideCap > 0n && sideOi + notion > sideCap) {
        throw new HttpError(400, 'open interest cap reached for this side', 'oi_cap_exceeded');
      }
      // NAV is read once and shared by both NAV-relative checks below (only when one is enabled).
      const nav = config.oiCapNavBps > 0 || config.maxPnlFactorBps > 0 ? await lpDepth(q) : 0n;
      // 2) NAV-relative OI cap (oiCapNavBps>0): one side's OI can't exceed this fraction of LP NAV, so a
      // market's worst-case PnL vs the pool can't outgrow the vault as NAV shrinks (calibration 0.3-0.5×NAV).
      // Always enforced when enabled — at NAV≤0 the cap is 0, so an uncapitalized pool takes no new risk.
      if (config.oiCapNavBps > 0 && sideOi + notion > (nav * BigInt(config.oiCapNavBps)) / 10_000n) {
        throw new HttpError(400, 'open interest cap reached for this side (pool-relative)', 'oi_cap_exceeded');
      }
      // 3) pool-health gate (GMX-style MAX_PNL_FACTOR): once the pool already owes traders more than
      // maxPnlFactor of NAV, pause new opens so a thin/underfunded pool can't be drained by net winners.
      if (config.maxPnlFactorBps > 0) {
        if (nav <= 0n) throw new HttpError(409, 'liquidity pool is not capitalized; new positions are paused', 'pool_paused');
        if ((await poolPnlLiability(q)) > (nav * BigInt(config.maxPnlFactorBps)) / 10_000n) {
          throw new HttpError(409, 'pool risk limit reached; new positions are paused', 'pool_paused');
        }
      }

      const collAcct = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const marginAcct = await getOrCreateUserAccount(q, userId, 'USER_POSITION_MARGIN');
      // lock the collateral row so concurrent opens by the same user (across markets) can't
      // both pass the balance check and overdraw it.
      await q.query('SELECT amount_uusdc FROM balances WHERE account_id=$1 FOR UPDATE', [collAcct]);
      const available = await getBalance(q, collAcct);
      if (available < margin + openFee) throw new HttpError(400, 'insufficient balance', 'insufficient_balance');

      // lock margin, then charge the open fee
      await postTxn(q, {
        reason: 'MARGIN_LOCK',
        refType: 'market',
        refId: market.id,
        entries: [
          { accountId: collAcct, amount: -margin },
          { accountId: marginAcct, amount: margin },
        ],
      });
      await chargeFee(q, userId, openFee, 'OPEN_FEE', market.id, feeAff.cashback);

      // open or increase
      const existing = await getOpenPosition(q, userId, market.id, input.side);
      let positionId: string;
      if (existing) {
        await settlePositionFunding(q, existing, market.id); // settle funding at the old size first
        const oldQty = BigInt(existing.qty_e6);
        const newQty = oldQty + input.qtyE6;
        const newEntry = (oldQty * BigInt(existing.avg_entry_e6) + input.qtyE6 * markE6) / newQty;
        const newMargin = BigInt(existing.margin_uusdc) + margin;
        const liq = liquidationPrice({ side: input.side, entryE6: newEntry, leverageE2, maintMarginBps: market.maint_margin_bps });
        positionId = existing.id;
        await q.query(
          `UPDATE positions SET qty_e6=$1, avg_entry_e6=$2, margin_uusdc=$3, leverage_e2=$4, liq_price_e6=$5, version=version+1 WHERE id=$6`,
          [newQty.toString(), newEntry.toString(), newMargin.toString(), leverageE2, liq.toString(), positionId],
        );
      } else {
        positionId = randomUUID();
        const cum = await getCumulativeFundingE6(q, market.id);
        const liq = liquidationPrice({ side: input.side, entryE6: markE6, leverageE2, maintMarginBps: market.maint_margin_bps });
        await q.query(
          `INSERT INTO positions(id,user_id,market_id,side,qty_e6,avg_entry_e6,margin_uusdc,leverage_e2,liq_price_e6,funding_index_snapshot_e6,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')`,
          [positionId, userId, market.id, input.side, input.qtyE6.toString(), markE6.toString(), margin.toString(), leverageE2, liq.toString(), cum.toString()],
        );
      }

      await insertFill(q, { orderId, positionId, marketId: market.id, execPriceE6: markE6, qtyE6: input.qtyE6, feeUusdc: openFee, realizedPnlUusdc: 0n });

      await refreshMarketState(q, market, indexE6);
      publish(`positions:${userId}`, 'update', { marketId: market.id });
      publish(`balance:${userId}`, 'update', {});
      // BIG BET fires at "$X or more" (>=); BIG WIN fires at "more than $X" (>) — asymmetry is intentional.
      if (notion >= usdc(getBigBetUsd())) {
        bigBet = { userId, marketId: market.id, variant: 'big_bet', side: input.side, notionalE6: notion };
      }
      return { result: { orderId, positionId }, chat: bigBet };
}

export async function closePosition(db: Db, userId: string, input: CloseInput): Promise<{ orderId: string; realizedPnlUusdc: string; closedQtyE6: string; remainingQtyE6: string }> {
  const prior = await db.query<{ id: string }>(`SELECT id FROM orders WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey]);
  if (prior.rows[0]) return replayClose(db, prior.rows[0].id);

  const pos0 = await getPositionById(db, input.positionId);
  if (!pos0 || pos0.user_id !== userId) throw new HttpError(404, 'position not found');
  if (pos0.status !== 'open') throw new HttpError(400, 'position not open');

  // BIG WIN action bar — captured in the tx (where realized PnL + the closed leg's margin are known),
  // broadcast AFTER commit (non-fatal). Stays null on a duplicate/replay, so we don't re-announce.
  const out = await withMarketLock(pos0.market_id, () =>
    db.tx(async (q) => {
      await advisoryXactLock(q, pos0.market_id); // DB-level single-writer per market
      return closePositionInTx(q, userId, input);
    }),
  );
  if (out.chat) await emitChatEvent(db, out.chat).catch(() => {}); // post-commit, non-fatal
  return out.result;
}

/**
 * Close/reduce a position INSIDE an existing market lock + tx — the caller already holds
 * withMarketLock + db.tx + advisoryXactLock. The public closePosition is a thin wrapper; the
 * resting-order trigger loop (stop-loss / take-profit fills) calls this directly so a close runs in
 * one tx. `input.slippageE6` (optional) bounds the fill. Returns the result + a post-commit chat event.
 */
async function closePositionInTx(
  q: Queryer,
  userId: string,
  input: CloseInput,
): Promise<{ result: { orderId: string; realizedPnlUusdc: string; closedQtyE6: string; remainingQtyE6: string }; chat: ChatEventInput | null }> {
      let bigWin: ChatEventInput | null = null;
      const pos0 = await getPositionById(q, input.positionId);
      if (!pos0 || pos0.user_id !== userId) throw new HttpError(404, 'position not found');
      if (pos0.status !== 'open') throw new HttpError(400, 'position not open');
      const pos = await getOpenPosition(q, userId, pos0.market_id, pos0.side);
      if (!pos || pos.id !== input.positionId) throw new HttpError(400, 'position not open');
      const market = (await getMarketById(q, pos.market_id))!;
      const mi = await getLatestMarkIndex(q, market.id);
      if (!mi) throw new HttpError(400, 'no price available');
      const { markE6, indexE6 } = mi;
      // optional slippage bound (resting SL/TP fills): long close = floor, short close = cap; unset = no bound
      if (input.slippageE6 != null && (pos.side === 'long' ? markE6 < input.slippageE6 : markE6 > input.slippageE6)) {
        throw new HttpError(400, 'fill price moved past the slippage bound', 'slippage_exceeded');
      }

      // an under-margined position must go through liquidation (loss-capped), not a voluntary
      // close that would drive the user's collateral negative.
      if (isLiquidatable(pos, market, markE6)) {
        throw new HttpError(409, 'position is liquidatable and will be liquidated; cannot close manually');
      }

      const qty = BigInt(pos.qty_e6);
      const closeQty = input.fractionBps >= 10_000 ? qty : (qty * BigInt(input.fractionBps)) / 10_000n;
      if (closeQty <= 0n) throw new HttpError(400, 'nothing to close');

      // In-tx idempotency anchor BEFORE any side effects: a racing duplicate (same user+key)
      // replays the prior result instead of re-running margin/PnL/fee.
      const orderId = randomUUID();
      const anchor = await anchorOrder(q, { id: orderId, userId, marketId: market.id, idempotencyKey: input.idempotencyKey, kind: 'reduce_only', side: pos.side, qtyE6: closeQty, leverageE2: pos.leverage_e2, actorPubkey: input.actorPubkey });
      if (!anchor.inserted) return { result: await replayClose(q, anchor.orderId), chat: null };

      await settlePositionFunding(q, pos, market.id); // settle accrued funding first
      const entry = BigInt(pos.avg_entry_e6);
      const pnl = unrealizedPnl(pos.side, closeQty, entry, markE6);
      const marginRel = (BigInt(pos.margin_uusdc) * closeQty) / qty;
      const feeAff = await resolveFeeAffiliate(q, userId);
      const closeFeeAmt = applyFeeDiscount(fee(notional(closeQty, markE6), getFeeBps()), feeAff.discountBps);

      const collAcct = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const marginAcct = await getOrCreateUserAccount(q, userId, 'USER_POSITION_MARGIN');
      const lpAcct = await getOrCreateSystemAccount(q, 'LP_POOL');

      // release proportional margin back to collateral
      await postTxn(q, {
        reason: 'MARGIN_RELEASE',
        refType: 'position',
        refId: pos.id,
        entries: [
          { accountId: marginAcct, amount: -marginRel },
          { accountId: collAcct, amount: marginRel },
        ],
      });
      // settle realized PnL against the LP pool
      if (pnl !== 0n) {
        await postTxn(q, {
          reason: 'REALIZED_PNL',
          refType: 'position',
          refId: pos.id,
          entries: [
            { accountId: collAcct, amount: pnl },
            { accountId: lpAcct, amount: -pnl },
          ],
        });
      }
      // close fee
      await chargeFee(q, userId, closeFeeAmt, 'CLOSE_FEE', pos.id, feeAff.cashback);

      const remQty = qty - closeQty;
      const remMargin = BigInt(pos.margin_uusdc) - marginRel;
      const newRealized = BigInt(pos.realized_pnl_uusdc) + pnl;
      if (remQty <= 0n) {
        await q.query(
          `UPDATE positions SET qty_e6=0, margin_uusdc=0, realized_pnl_uusdc=$1, status='closed', closed_at=now(), version=version+1 WHERE id=$2`,
          [newRealized.toString(), pos.id],
        );
      } else {
        const liq = liquidationPrice({ side: pos.side, entryE6: entry, leverageE2: pos.leverage_e2, maintMarginBps: market.maint_margin_bps });
        await q.query(
          `UPDATE positions SET qty_e6=$1, margin_uusdc=$2, realized_pnl_uusdc=$3, liq_price_e6=$4, version=version+1 WHERE id=$5`,
          [remQty.toString(), remMargin.toString(), newRealized.toString(), liq.toString(), pos.id],
        );
      }

      // fills references the orderId anchored at the top of the tx (guaranteed inserted)
      await insertFill(q, { orderId, positionId: pos.id, marketId: market.id, execPriceE6: markE6, qtyE6: closeQty, feeUusdc: closeFeeAmt, realizedPnlUusdc: pnl });

      await refreshMarketState(q, market, indexE6);
      publish(`positions:${userId}`, 'update', { marketId: market.id });
      publish(`balance:${userId}`, 'update', {});
      if (pnl > usdc(getBigWinUsd())) {
        const roeBps = marginRel > 0n ? Number((pnl * 10_000n) / marginRel) : 0; // return on the closed leg's margin
        bigWin = { userId, marketId: market.id, variant: 'big_win', side: pos.side as 'long' | 'short', notionalE6: notional(closeQty, markE6), pnlE6: pnl, roeBps };
      }
      return { result: { orderId, realizedPnlUusdc: pnl.toString(), closedQtyE6: closeQty.toString(), remainingQtyE6: remQty.toString() }, chat: bigWin };
}

// ---- resting orders (limit / SL / TP) -------------------------------------
// docs/limit-stop-orders-spec.md. P1 = limit (open): a resting trigger that, when the mark crosses
// trigger_price_e6, market-fills at the mark via openPositionInTx (one tx) bounded by the limit as a
// slippage cap. Margin is reserved at placement (a floor, at max(trigger, current mark)) and released to
// collateral at fill so the open's own margin-lock is the single charge. Reduce-only SL/TP land in P2.

export interface RestingOrderInput {
  marketId: string;
  kind: 'limit' | 'stop_loss' | 'take_profit';
  triggerPriceE6: bigint;
  side?: 'long' | 'short';
  qtyE6?: bigint;
  leverage?: number;
  slippageE6?: bigint;
  positionId?: string;
  reduceOnly: boolean;
  idempotencyKey: string;
  actorPubkey?: string;
}

export interface RestingOrderView {
  id: string;
  marketId: string;
  kind: string;
  side: string | null;
  qtyE6: string | null;
  leverage: number | null;
  triggerPriceE6: string;
  slippageE6: string | null;
  reservedMarginUusdc: string;
  createdAt: string;
}

// transient open-rejects: the market is momentarily un-openable — leave the order resting + retry next
// sweep. Anything else is terminal → cancel with the reason. (Codes from openPositionInTx's gates.)
const RESTING_TRANSIENT_CODES = new Set(['market_repricing', 'market_halted', 'market_restricted', 'oi_cap_exceeded', 'pool_paused']);

export async function placeRestingOrder(db: Db, userId: string, input: RestingOrderInput): Promise<{ id: string; duplicate?: boolean }> {
  // P1: only limit-OPEN. reduce-only limit + SL/TP are P2.
  if (input.kind !== 'limit' || input.reduceOnly) throw new HttpError(400, 'only limit (open) resting orders are supported yet', 'unsupported_order');
  if (!input.side || input.qtyE6 == null || input.leverage == null) throw new HttpError(400, 'a limit order needs side, qtyE6 and leverage');
  if (input.triggerPriceE6 <= 0n) throw new HttpError(400, 'invalid trigger price');
  const side = input.side;
  const qtyE6 = input.qtyE6;
  const leverageE2 = input.leverage * 100;
  return withMarketLock(input.marketId, () =>
    db.tx(async (q) => {
      await advisoryXactLock(q, input.marketId);
      const prior = await q.query<{ id: string }>(`SELECT id FROM resting_orders WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey]);
      if (prior.rows[0]) return { id: prior.rows[0].id, duplicate: true };
      const market = await getMarketById(q, input.marketId);
      if (!market) throw new HttpError(404, 'market not found');
      if (leverageE2 < 100 || leverageE2 > market.max_leverage_e2) throw new HttpError(400, `leverage must be 1–${market.max_leverage_e2 / 100}×`);
      if (qtyE6 < BigInt(market.min_qty_e6)) throw new HttpError(400, 'order below the minimum size');
      const cap = config.restingMaxPerUserMarket;
      const cnt = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM resting_orders WHERE user_id=$1 AND market_id=$2 AND status='active'`, [userId, input.marketId]);
      if (Number(cnt.rows[0].n) >= cap) throw new HttpError(400, `too many open orders on this market (max ${cap})`, 'resting_cap');
      // reserve at a conservative basis = max(trigger, current mark): a long fills at the mark ≤ basis, so
      // the reserve covers it; the open re-derives + locks the real margin at fill (reserve is a floor).
      const mi = await getLatestMarkIndex(q, input.marketId);
      const basis = mi && mi.markE6 > input.triggerPriceE6 ? mi.markE6 : input.triggerPriceE6;
      const reserve = initialMargin(notional(qtyE6, basis), leverageE2);
      if (reserve <= 0n) throw new HttpError(400, 'order too small');
      const collAcct = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const restAcct = await getOrCreateUserAccount(q, userId, 'RESTING_ORDER_MARGIN');
      await q.query('SELECT amount_uusdc FROM balances WHERE account_id=$1 FOR UPDATE', [collAcct]); // single-writer on the user's collateral
      if ((await getBalance(q, collAcct)) < reserve) throw new HttpError(400, 'insufficient balance', 'insufficient_balance');
      const id = randomUUID();
      await q.query(
        `INSERT INTO resting_orders(id,user_id,market_id,kind,reduce_only,side,qty_e6,leverage_e2,trigger_price_e6,slippage_e6,reserved_margin_uusdc,status,idempotency_key)
         VALUES($1,$2,$3,'limit',false,$4,$5,$6,$7,$7,$8,'active',$9)`,
        [id, userId, input.marketId, side, qtyE6.toString(), leverageE2, input.triggerPriceE6.toString(), reserve.toString(), input.idempotencyKey],
      );
      await postTxn(q, { reason: 'RESTING_RESERVE', refType: 'resting_order', refId: id, entries: [{ accountId: collAcct, amount: -reserve }, { accountId: restAcct, amount: reserve }] });
      publish(`orders:${userId}`, 'update', {});
      return { id };
    }),
  );
}

export async function cancelRestingOrder(db: Db, userId: string, id: string): Promise<{ cancelled: boolean }> {
  return db.tx(async (q) => {
    // guarded: a racing trigger that already claimed the row flips it off 'active', so this returns 0 rows
    // and no-ops — the reserve is released exactly once, by whichever of cancel/fill won.
    const r = await q.query<{ reserved_margin_uusdc: string }>(
      `UPDATE resting_orders SET status='cancelled', resolved_at=now() WHERE id=$1 AND user_id=$2 AND status='active' RETURNING reserved_margin_uusdc`,
      [id, userId],
    );
    if (!r.rows[0]) return { cancelled: false };
    const reserve = BigInt(r.rows[0].reserved_margin_uusdc);
    if (reserve > 0n) {
      const collAcct = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const restAcct = await getOrCreateUserAccount(q, userId, 'RESTING_ORDER_MARGIN');
      await postTxn(q, { reason: 'RESTING_REFUND', refType: 'resting_order', refId: id, entries: [{ accountId: restAcct, amount: -reserve }, { accountId: collAcct, amount: reserve }] });
    }
    publish(`orders:${userId}`, 'update', {});
    return { cancelled: true };
  });
}

export async function getUserRestingOrders(db: Db, userId: string): Promise<RestingOrderView[]> {
  const r = await db.query<{ id: string; market_id: string; kind: string; side: string | null; qty_e6: string | null; leverage_e2: number | null; trigger_price_e6: string; slippage_e6: string | null; reserved_margin_uusdc: string; created_at: string }>(
    `SELECT id, market_id, kind, side, qty_e6, leverage_e2, trigger_price_e6, slippage_e6, reserved_margin_uusdc, created_at
       FROM resting_orders WHERE user_id=$1 AND status='active' ORDER BY created_at DESC`,
    [userId],
  );
  return r.rows.map((o) => ({
    id: o.id, marketId: o.market_id, kind: o.kind, side: o.side, qtyE6: o.qty_e6,
    leverage: o.leverage_e2 != null ? o.leverage_e2 / 100 : null,
    triggerPriceE6: o.trigger_price_e6, slippageE6: o.slippage_e6,
    reservedMarginUusdc: o.reserved_margin_uusdc, createdAt: o.created_at,
  }));
}

/**
 * One market's resting-order trigger pass (P1: limit fills). Snapshots the latest mark ONCE at the start
 * (so a fill that moves the mark within this pass can't self-trigger another order — spec §1a). For each
 * active limit whose trigger the snapshot crossed, the fill runs in ONE tx (claim → release reserve →
 * open): if the open throws, the whole tx rolls back, leaving the order untouched (still active + reserved).
 * A transient reject is then retried next sweep; a terminal reject cancels + refunds in a fresh tx.
 */
export async function checkRestingOrderTriggers(db: Db, marketId: string): Promise<number> {
  const snap = await db.query<{ mark_price_e6: string }>(`SELECT mark_price_e6 FROM marks WHERE market_id=$1 ORDER BY computed_at DESC LIMIT 1`, [marketId]);
  if (!snap.rows[0]) return 0;
  const oracleMarkE6 = BigInt(snap.rows[0].mark_price_e6);
  // long buys the dip → fills when mark ≤ trigger (trigger ≥ mark); short sells the rip → mark ≥ trigger.
  const due = await db.query<{ id: string }>(
    `SELECT id FROM resting_orders
      WHERE market_id=$1 AND status='active' AND kind='limit'
        AND ((side='long' AND trigger_price_e6 >= $2) OR (side='short' AND trigger_price_e6 <= $2))
      ORDER BY created_at LIMIT $3`,
    [marketId, oracleMarkE6.toString(), config.restingMaxPerSweep],
  );
  let filled = 0;
  for (const { id } of due.rows) {
    let terminal: string | null = null;
    try {
      await withMarketLock(marketId, () =>
        db.tx(async (q) => {
          await advisoryXactLock(q, marketId);
          const claim = await q.query<{ user_id: string; side: string; qty_e6: string; leverage_e2: number; trigger_price_e6: string; reserved_margin_uusdc: string }>(
            `UPDATE resting_orders SET status='filled', resolved_at=now() WHERE id=$1 AND status='active'
             RETURNING user_id, side, qty_e6, leverage_e2, trigger_price_e6, reserved_margin_uusdc`,
            [id],
          );
          if (!claim.rows[0]) throw new HttpError(409, 'order already resolved', 'resting_gone');
          const ro = claim.rows[0];
          const reserve = BigInt(ro.reserved_margin_uusdc);
          if (reserve > 0n) {
            const collAcct = await getOrCreateUserAccount(q, ro.user_id, 'USER_COLLATERAL');
            const restAcct = await getOrCreateUserAccount(q, ro.user_id, 'RESTING_ORDER_MARGIN');
            await postTxn(q, { reason: 'RESTING_RELEASE', refType: 'resting_order', refId: id, entries: [{ accountId: restAcct, amount: -reserve }, { accountId: collAcct, amount: reserve }] });
          }
          // fill at the live mark, bounded by the limit as the slippage cap. If this throws, the whole tx
          // (claim + release) rolls back — the order stays active + reserved, no partial state.
          await openPositionInTx(q, ro.user_id, {
            marketId,
            side: ro.side as 'long' | 'short',
            qtyE6: BigInt(ro.qty_e6),
            leverage: ro.leverage_e2 / 100,
            limitPriceE6: BigInt(ro.trigger_price_e6),
            idempotencyKey: `resting:${id}`,
          });
        }),
      );
      filled++;
    } catch (e) {
      const code = e instanceof HttpError ? e.code : undefined;
      if (code === 'resting_gone' || (code && RESTING_TRANSIENT_CODES.has(code))) continue; // gone / retry next sweep
      terminal = code ?? 'fill_failed';
    }
    if (terminal) {
      // fresh tx: cancel the (rolled-back, still-active) order + refund its reserve. Guarded for the race.
      await db
        .tx(async (q) => {
          const r = await q.query<{ user_id: string; reserved_margin_uusdc: string }>(
            `UPDATE resting_orders SET status='cancelled', reject_reason=$2, resolved_at=now() WHERE id=$1 AND status='active' RETURNING user_id, reserved_margin_uusdc`,
            [id, terminal],
          );
          if (!r.rows[0]) return;
          const reserve = BigInt(r.rows[0].reserved_margin_uusdc);
          if (reserve > 0n) {
            const collAcct = await getOrCreateUserAccount(q, r.rows[0].user_id, 'USER_COLLATERAL');
            const restAcct = await getOrCreateUserAccount(q, r.rows[0].user_id, 'RESTING_ORDER_MARGIN');
            await postTxn(q, { reason: 'RESTING_REFUND', refType: 'resting_order', refId: id, entries: [{ accountId: restAcct, amount: -reserve }, { accountId: collAcct, amount: reserve }] });
          }
          publish(`orders:${r.rows[0].user_id}`, 'update', {});
        })
        .catch(() => {});
    }
  }
  return filled;
}

// ---- read models ----------------------------------------------------------
export interface PositionView {
  id: string;
  marketId: string;
  symbol: string;
  displayName: string;
  side: 'long' | 'short';
  qtyE6: string;
  avgEntryE6: string;
  marginUusdc: string;
  leverage: number;
  liqPriceE6: string;
  markE6: string;
  unrealizedPnlUusdc: string;
  status: string;
  openedAt: string;
}

export async function getUserPositions(db: Db, userId: string): Promise<PositionView[]> {
  const r = await db.query<PositionRow & { symbol: string; display_name: string; mark: string | null; opened_at: string }>(
    `SELECT ${POS_COLS}, p.opened_at, m.symbol, m.display_name,
            (SELECT mark_price_e6::text FROM marks k WHERE k.market_id=p.market_id ORDER BY computed_at DESC LIMIT 1) AS mark
     FROM positions p JOIN markets m ON m.id = p.market_id
     WHERE p.user_id=$1 AND p.status='open' ORDER BY p.opened_at DESC`,
    [userId],
  );
  return r.rows.map((row) => {
    const markE6 = row.mark ? BigInt(row.mark) : BigInt(row.avg_entry_e6);
    const uPnl = unrealizedPnl(row.side, BigInt(row.qty_e6), BigInt(row.avg_entry_e6), markE6);
    return {
      id: row.id,
      marketId: row.market_id,
      symbol: row.symbol,
      displayName: row.display_name,
      side: row.side,
      qtyE6: row.qty_e6,
      avgEntryE6: row.avg_entry_e6,
      marginUusdc: row.margin_uusdc,
      leverage: Math.round(row.leverage_e2 / 100),
      liqPriceE6: row.liq_price_e6,
      markE6: markE6.toString(),
      unrealizedPnlUusdc: uPnl.toString(),
      status: row.status,
      openedAt: row.opened_at,
    };
  });
}

/** Total unrealized PnL across a user's open positions (for equity). */
export async function getUserUnrealizedPnl(db: Db, userId: string): Promise<bigint> {
  const positions = await getUserPositions(db, userId);
  return positions.reduce((a, p) => a + BigInt(p.unrealizedPnlUusdc), 0n);
}

// ---- liquidations ---------------------------------------------------------

/** A position is liquidatable when its equity has fallen to/below maintenance margin. */
function isLiquidatable(pos: PositionRow, market: MarketRow, markE6: bigint): boolean {
  const qty = BigInt(pos.qty_e6);
  const equity = BigInt(pos.margin_uusdc) + unrealizedPnl(pos.side, qty, BigInt(pos.avg_entry_e6), markE6);
  const maint = maintenanceMargin(notional(qty, markE6), market.maint_margin_bps);
  return equity <= maint;
}

/**
 * Force-close a position at the mark. The user's loss is capped at their margin; any shortfall
 * (bad debt, e.g. a gap through the liq price) is drawn from the insurance fund, and whatever
 * the insurance can't cover is socialized to the LP pool. A liquidation penalty (from any
 * remaining equity) tops up the insurance fund. Every leg is a balanced ledger txn.
 */
async function liquidatePositionInTx(q: Queryer, pos: PositionRow, market: MarketRow, markE6: bigint, indexE6: bigint): Promise<void> {
  await settlePositionFunding(q, pos, market.id);

  const qty = BigInt(pos.qty_e6);
  const entry = BigInt(pos.avg_entry_e6);
  const margin = BigInt(pos.margin_uusdc);
  const pnl = unrealizedPnl(pos.side, qty, entry, markE6);
  const lossAbs = pnl < 0n ? -pnl : 0n;
  const liqFee = fee(notional(qty, markE6), getLiqFeeBps());

  const coll = await getOrCreateUserAccount(q, pos.user_id, 'USER_COLLATERAL');
  const marginAcct = await getOrCreateUserAccount(q, pos.user_id, 'USER_POSITION_MARGIN');
  const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
  const insurance = await getOrCreateSystemAccount(q, 'INSURANCE_FUND');

  // release the locked margin back to collateral
  await postTxn(q, { reason: 'MARGIN_RELEASE', refType: 'liquidation', refId: pos.id, entries: [
    { accountId: marginAcct, amount: -margin },
    { accountId: coll, amount: margin },
  ] });

  let lossToUser = 0n;
  let badDebt = 0n;
  let drawn = 0n;
  let socialized = 0n;
  let liqFeeTaken = 0n;

  if (pnl > 0n) {
    await postTxn(q, { reason: 'REALIZED_PNL', refType: 'liquidation', refId: pos.id, entries: [
      { accountId: coll, amount: pnl },
      { accountId: lp, amount: -pnl },
    ] });
  } else if (lossAbs > 0n) {
    lossToUser = lossAbs < margin ? lossAbs : margin; // user can only lose their margin
    await postTxn(q, { reason: 'REALIZED_PNL', refType: 'liquidation', refId: pos.id, entries: [
      { accountId: coll, amount: -lossToUser },
      { accountId: lp, amount: lossToUser },
    ] });
    badDebt = lossAbs - lossToUser;
    if (badDebt > 0n) {
      const insBal = await getBalance(q, insurance);
      drawn = badDebt < insBal ? badDebt : insBal > 0n ? insBal : 0n;
      if (drawn > 0n) {
        await postTxn(q, { reason: 'INSURANCE_TOPUP', refType: 'liquidation', refId: pos.id, entries: [
          { accountId: insurance, amount: -drawn },
          { accountId: lp, amount: drawn },
        ] });
      }
      socialized = badDebt - drawn; // LP bears this (it simply receives less)
    }
  }

  // liquidation penalty from any remaining released margin
  const remaining = margin - lossToUser;
  if (remaining > 0n) {
    liqFeeTaken = liqFee < remaining ? liqFee : remaining;
    if (liqFeeTaken > 0n) {
      await postTxn(q, { reason: 'LIQUIDATION_FEE', refType: 'liquidation', refId: pos.id, entries: [
        { accountId: coll, amount: -liqFeeTaken },
        { accountId: insurance, amount: liqFeeTaken },
      ] });
    }
  }

  await q.query(
    `UPDATE positions SET qty_e6=0, margin_uusdc=0, realized_pnl_uusdc=realized_pnl_uusdc+$1, status='liquidated', closed_at=now(), version=version+1 WHERE id=$2`,
    [pnl.toString(), pos.id],
  );
  const orderId = await insertSystemOrder(q, pos, market.id, 'liq');
  await insertFill(q, { orderId, positionId: pos.id, marketId: market.id, execPriceE6: markE6, qtyE6: qty, feeUusdc: liqFeeTaken, realizedPnlUusdc: pnl });
  await q.query(
    `INSERT INTO liquidations(id,position_id,market_id,user_id,trigger_mark_e6,closed_qty_e6,liquidation_fee_uusdc,bad_debt_uusdc,insurance_drawn_uusdc,socialized_uusdc,mark_guarded)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), pos.id, market.id, pos.user_id, markE6.toString(), qty.toString(), liqFeeTaken.toString(), badDebt.toString(), drawn.toString(), socialized.toString(), market.mark_clamped],
  );

  await refreshMarketState(q, market, indexE6);
  publish(`positions:${pos.user_id}`, 'liquidated', { positionId: pos.id, markE6: markE6.toString() });
  publish(`liquidations:${pos.user_id}`, 'liquidation', { positionId: pos.id, marketId: market.id, badDebtUusdc: badDebt.toString() });
}

/**
 * Auto-deleverage one profitable position: force-close it at the mark, paying its realized gain from
 * the LP pool and releasing its margin. Unlike a liquidation there's no bad debt or penalty — this
 * removes a winner's *forward* upside to protect the pool, not because the trader did anything wrong.
 * Returns false (no-op) if the position is no longer in profit. Mirrors liquidatePositionInTx.
 */
async function adlClosePositionInTx(q: Queryer, pos: PositionRow, market: MarketRow, markE6: bigint, indexE6: bigint): Promise<boolean> {
  await settlePositionFunding(q, pos, market.id);
  const qty = BigInt(pos.qty_e6);
  const pnl = unrealizedPnl(pos.side, qty, BigInt(pos.avg_entry_e6), markE6);
  if (pnl <= 0n) return false; // ADL only force-closes winners — losers don't drain the pool

  const coll = await getOrCreateUserAccount(q, pos.user_id, 'USER_COLLATERAL');
  const marginAcct = await getOrCreateUserAccount(q, pos.user_id, 'USER_POSITION_MARGIN');
  const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
  const margin = BigInt(pos.margin_uusdc);

  await postTxn(q, { reason: 'MARGIN_RELEASE', refType: 'adl', refId: pos.id, entries: [
    { accountId: marginAcct, amount: -margin },
    { accountId: coll, amount: margin },
  ] });
  await postTxn(q, { reason: 'REALIZED_PNL', refType: 'adl', refId: pos.id, entries: [
    { accountId: coll, amount: pnl },
    { accountId: lp, amount: -pnl },
  ] });
  await q.query(
    `UPDATE positions SET qty_e6=0, margin_uusdc=0, realized_pnl_uusdc=realized_pnl_uusdc+$1, status='deleveraged', closed_at=now(), version=version+1 WHERE id=$2`,
    [pnl.toString(), pos.id],
  );
  const orderId = await insertSystemOrder(q, pos, market.id, 'adl');
  await insertFill(q, { orderId, positionId: pos.id, marketId: market.id, execPriceE6: markE6, qtyE6: qty, feeUusdc: 0n, realizedPnlUusdc: pnl });
  await refreshMarketState(q, market, indexE6);
  publish(`positions:${pos.user_id}`, 'deleveraged', { positionId: pos.id, markE6: markE6.toString(), pnlUusdc: pnl.toString() });
  // notify channel (Toasts subscribes here, same as liquidation) — ADL force-closed a winner
  publish(`liquidations:${pos.user_id}`, 'deleveraged', { positionId: pos.id, marketId: market.id, pnlUusdc: pnl.toString() });
  return true;
}

/** Sweep a market: liquidate every open position whose equity is at/below maintenance margin. */
export async function liquidateEligible(db: Db, marketId: string): Promise<number> {
  const mi = await getLatestMarkIndex(db, marketId);
  const market = await getMarketById(db, marketId);
  if (!mi || !market) return 0;
  const open = await db.query<PositionRow>(`SELECT ${POS_COLS} FROM positions p WHERE p.market_id=$1 AND p.status='open'`, [marketId]);
  let count = 0;
  for (const candidate of open.rows) {
    if (!isLiquidatable(candidate, market, mi.markE6)) continue;
    await withMarketLock(marketId, () =>
      db.tx(async (q) => {
        await advisoryXactLock(q, marketId);
        const fresh = await getOpenPosition(q, candidate.user_id, marketId, candidate.side);
        if (!fresh || fresh.id !== candidate.id) return;
        const mi2 = await getLatestMarkIndex(q, marketId);
        // Re-read the market INSIDE the tx so the liquidation check and the mark_guarded audit flag use
        // within-tx-consistent state (an ingest could flip mark_clamped between the sweep load and here).
        const m2 = await getMarketById(q, marketId);
        if (!mi2 || !m2 || !isLiquidatable(fresh, m2, mi2.markE6)) return;
        await liquidatePositionInTx(q, fresh, m2, mi2.markE6, mi2.indexE6);
        count++;
      }),
    );
  }
  return count;
}

/** Liquidate every eligible (underwater) position across all live markets — the per-market sweep over
 *  the tradeable active/reduce-only universe. Shared by the background liquidation loop and the operator
 *  "liquidate now" admin action, so both flatten the underwater book identically. */
export async function liquidateAllEligible(db: Db): Promise<{ liquidated: number; markets: number }> {
  const r = await db.query<{ id: string }>(`SELECT id FROM markets WHERE tradeable AND status IN ('active','reduce_only')`);
  let liquidated = 0;
  for (const m of r.rows) liquidated += await liquidateEligible(db, m.id);
  return { liquidated, markets: r.rows.length };
}

/** Hard cap on force-closes per sweep — a runaway-loop backstop; real convergence is the break below. */
const ADL_MAX_PER_SWEEP = 1000;

/**
 * Auto-deleverage backstop (docs/liquidity-hybrid-spec.md §6, Phase 3). When the pool's net liability
 * to traders exceeds adlPnlFactorBps of NAV, force-close the most profitable positions (at the mark,
 * pool-wide across all markets) until liability is back under target. This is the active complement to
 * the MAX_PNL_FACTOR open-gate: the gate stops *new* risk, ADL *reduces* existing risk. Disabled when
 * adlPnlFactorBps=0. Meant to run each liquidation sweep.
 */
export async function autoDeleverage(db: Db): Promise<number> {
  if (config.adlPnlFactorBps <= 0) return 0;
  let count = 0;
  for (let pass = 0; pass < ADL_MAX_PER_SWEEP; pass++) {
    const nav = await lpDepth(db);
    const pnls = await openPositionPnls(db);
    if (sumPoolLiability(pnls) <= (nav * BigInt(config.adlPnlFactorBps)) / 10_000n) break;

    let top: OpenPositionPnl | null = null;
    for (const p of pnls) if (p.pnlUusdc > 0n && (top === null || p.pnlUusdc > top.pnlUusdc)) top = p;
    if (top === null) break; // no profitable position left to deleverage
    const winner = top;
    const market = await getMarketById(db, winner.marketId);
    if (!market) break;

    const closed = await withMarketLock(winner.marketId, () =>
      db.tx(async (q) => {
        await advisoryXactLock(q, winner.marketId);
        const fresh = await getOpenPosition(q, winner.userId, winner.marketId, winner.side);
        if (!fresh || fresh.id !== winner.id) return false;
        const mi = await getLatestMarkIndex(q, winner.marketId);
        if (!mi) return false;
        return adlClosePositionInTx(q, fresh, market, mi.markE6, mi.indexE6);
      }),
    );
    if (!closed) break; // the chosen winner flipped/vanished; let the next sweep retry rather than spin
    count++;
  }
  return count;
}

/**
 * Circuit breaker: halt any tradeable market (card OR index) whose latest accepted oracle print
 * is older than the staleness window, and symmetrically re-activate a halted market once a fresh
 * print arrives. Only ever moves between 'active' <-> 'reduce_only' (never touches halted/delisted).
 */
export async function haltStaleMarkets(db: Db, staleMs: number): Promise<{ halted: number; reactivated: number }> {
  const fresh = `SELECT market_id FROM oracle_prices WHERE is_accepted AND ingested_at > now() - ($1 || ' milliseconds')::interval`;
  const halted = await db.query<{ id: string }>(
    `UPDATE markets SET status='reduce_only'
     WHERE tradeable AND status='active' AND id NOT IN (${fresh}) RETURNING id`,
    [String(staleMs)],
  );
  const reactivated = await db.query<{ id: string }>(
    `UPDATE markets SET status='active'
     WHERE tradeable AND status='reduce_only' AND id IN (${fresh}) RETURNING id`,
    [String(staleMs)],
  );
  return { halted: halted.rows.length, reactivated: reactivated.rows.length };
}
