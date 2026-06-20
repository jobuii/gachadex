import { notional } from '@pokex/pricing';
import type { Db } from '../db/client.ts';

/**
 * Read-only account history for the trade-panel tabs: order history, trade (fill) history,
 * transaction (ledger) history, and closed-position history. All amounts are micro-USDC / e6
 * strings over the wire. Everything is scoped to the calling user.
 */

const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? 100, 1), 500);

// orders store the POSITION side; a reduce-only order trades the opposite direction.
function tradeSide(positionSide: string, kind: string): 'Buy' | 'Sell' {
  const dir = kind === 'reduce_only' ? (positionSide === 'long' ? 'short' : 'long') : positionSide;
  return dir === 'long' ? 'Buy' : 'Sell';
}

const notionalE6 = (qtyE6: string, priceE6: string) => notional(BigInt(qtyE6), BigInt(priceE6)).toString();

export interface OrderHistoryRow {
  time: string;
  type: 'Market';
  symbol: string;
  side: 'Buy' | 'Sell';
  priceE6: string;
  filledE6: string;
  valueE6: string;
  reduceOnly: boolean;
  status: string;
  orderId: string;
}

export async function getOrderHistory(db: Db, userId: string, limit?: number): Promise<OrderHistoryRow[]> {
  const r = await db.query<{
    id: string; kind: string; side: string; status: string; created_at: string; symbol: string;
    price_e6: string | null; filled_e6: string | null;
  }>(
    `SELECT o.id, o.kind, o.side, o.status, o.created_at, m.symbol,
            f.exec_price_e6::text AS price_e6, f.qty_e6::text AS filled_e6
     FROM orders o
     JOIN markets m ON m.id = o.market_id
     LEFT JOIN fills f ON f.order_id = o.id
     WHERE o.user_id = $1
     ORDER BY o.created_at DESC
     LIMIT $2`,
    [userId, clampLimit(limit)],
  );
  return r.rows.map((o) => {
    const priceE6 = o.price_e6 ?? '0';
    const filledE6 = o.filled_e6 ?? '0';
    return {
      time: o.created_at,
      type: 'Market' as const,
      symbol: o.symbol,
      side: tradeSide(o.side, o.kind),
      priceE6,
      filledE6,
      valueE6: notionalE6(filledE6, priceE6),
      reduceOnly: o.kind === 'reduce_only',
      status: o.status,
      orderId: o.id,
    };
  });
}

export interface TradeHistoryRow {
  time: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  priceE6: string;
  amountE6: string;
  valueE6: string;
  feeUusdc: string;
  realizedPnlUusdc: string;
  role: 'Taker';
}

export async function getTradeHistory(db: Db, userId: string, limit?: number): Promise<TradeHistoryRow[]> {
  const r = await db.query<{
    created_at: string; price_e6: string; qty_e6: string; fee: string; pnl: string;
    side: string; kind: string; symbol: string;
  }>(
    `SELECT f.created_at, f.exec_price_e6::text AS price_e6, f.qty_e6::text AS qty_e6,
            f.fee_uusdc::text AS fee, f.realized_pnl_uusdc::text AS pnl,
            o.side, o.kind, m.symbol
     FROM fills f
     JOIN orders o ON o.id = f.order_id
     JOIN markets m ON m.id = f.market_id
     WHERE o.user_id = $1
     ORDER BY f.created_at DESC
     LIMIT $2`,
    [userId, clampLimit(limit)],
  );
  return r.rows.map((f) => ({
    time: f.created_at,
    symbol: f.symbol,
    side: tradeSide(f.side, f.kind),
    priceE6: f.price_e6,
    amountE6: f.qty_e6,
    valueE6: notionalE6(f.qty_e6, f.price_e6),
    feeUusdc: f.fee,
    realizedPnlUusdc: f.pnl,
    role: 'Taker' as const,
  }));
}

// Ledger reasons grouped into the user-facing transaction types. MARGIN_LOCK / MARGIN_RELEASE are
// intentionally excluded — they move funds between the user's own collateral and margin sub-accounts,
// not in/out of the account.
const TXN_TYPE: Record<string, 'Transfer' | 'Realized PNL' | 'Funding Fee' | 'Commission'> = {
  FAUCET: 'Transfer',
  REFERRAL_BONUS: 'Transfer',
  LP_DEPOSIT: 'Transfer',
  LP_WITHDRAW: 'Transfer',
  DEPOSIT: 'Transfer',
  WITHDRAWAL: 'Transfer',
  WITHDRAWAL_REVERSAL: 'Transfer',
  REALIZED_PNL: 'Realized PNL',
  FUNDING: 'Funding Fee',
  OPEN_FEE: 'Commission',
  CLOSE_FEE: 'Commission',
  LIQUIDATION_FEE: 'Commission',
};

export interface TransactionRow {
  time: string;
  type: 'Transfer' | 'Realized PNL' | 'Funding Fee' | 'Commission';
  amountUusdc: string; // signed
  symbol: string | null;
}

export async function getTransactionHistory(db: Db, userId: string, limit?: number): Promise<TransactionRow[]> {
  const reasons = Object.keys(TXN_TYPE);
  const r = await db.query<{ created_at: string; reason: string; amt: string; symbol: string | null }>(
    `SELECT le.created_at, le.reason, le.amount_uusdc::text AS amt,
            COALESCE(m.symbol, pm.symbol) AS symbol
     FROM ledger_entries le
     JOIN accounts a ON a.id = le.account_id
     LEFT JOIN markets m ON m.id = le.ref_id
     LEFT JOIN positions p ON p.id = le.ref_id
     LEFT JOIN markets pm ON pm.id = p.market_id
     WHERE a.user_id = $1 AND a.type = 'USER_COLLATERAL' AND le.reason = ANY($2)
     ORDER BY le.created_at DESC, le.id DESC
     LIMIT $3`,
    [userId, reasons, clampLimit(limit)],
  );
  return r.rows.map((e) => ({
    time: e.created_at,
    type: TXN_TYPE[e.reason],
    amountUusdc: e.amt,
    symbol: e.symbol,
  }));
}

/** On-chain lifecycle of real-funds deposits + withdrawals (custody P1/P2) — the chain-facing
 *  status the ledger doesn't carry (detected/swapped/credited; requested/signed/confirmed/...). */
export interface WalletTransactionRow {
  id: string;
  kind: 'deposit' | 'withdrawal';
  asset: string; // 'USDC' | 'SOL' (deposits may arrive as SOL; withdrawals are USDC-only)
  amountRaw: string; // raw units of `asset` (lamports / micro-USDC)
  usdcE6: string | null; // credited proceeds (deposits) / payout amount (withdrawals)
  status: string;
  sig: string | null;
  dest: string | null; // withdrawals only
  time: string;
}

export async function getWalletTransactions(db: Db, userId: string, limit?: number): Promise<WalletTransactionRow[]> {
  const r = await db.query<WalletTransactionRow>(
    `SELECT * FROM (
       SELECT id, 'deposit' AS kind, asset, amount_in_raw::text AS "amountRaw",
              usdc_credited_e6::text AS "usdcE6", status, onchain_sig AS sig, NULL AS dest,
              observed_at AS time
       FROM deposits WHERE user_id = $1
       UNION ALL
       SELECT id, 'withdrawal' AS kind, 'USDC' AS asset, amount_e6::text AS "amountRaw",
              amount_e6::text AS "usdcE6", status, onchain_sig AS sig, dest_address AS dest,
              requested_at AS time
       FROM withdrawals WHERE user_id = $1
     ) t ORDER BY time DESC LIMIT $2`,
    [userId, clampLimit(limit)],
  );
  return r.rows;
}

export interface PositionHistoryRow {
  marketId: string; // for the share card (fetches the card art) + market navigation
  symbol: string;
  side: 'Long' | 'Short';
  leverage: number;
  status: string; // closed | liquidated | deleveraged
  entryE6: string;
  avgCloseE6: string | null;
  realizedPnlUusdc: string;
  closedQtyE6: string;
  openedAt: string;
  closedAt: string | null;
}

export async function getPositionHistory(db: Db, userId: string, limit?: number): Promise<PositionHistoryRow[]> {
  const positions = await db.query<{
    id: string; market_id: string; side: string; leverage_e2: number; status: string; pnl: string; entry_e6: string;
    opened_at: string; closed_at: string | null; symbol: string;
  }>(
    `SELECT p.id, p.market_id, p.side, p.leverage_e2, p.status, p.realized_pnl_uusdc::text AS pnl,
            p.avg_entry_e6::text AS entry_e6, p.opened_at, p.closed_at, m.symbol
     FROM positions p JOIN markets m ON m.id = p.market_id
     WHERE p.user_id = $1 AND p.status IN ('closed', 'liquidated', 'deleveraged')
     ORDER BY p.closed_at DESC NULLS LAST
     LIMIT $2`,
    [userId, clampLimit(limit)],
  );

  // volume-weighted close price + total closed qty from reduce-only fills, scoped to THIS page's
  // positions (uses idx_fills_position; avoids an unbounded scan of every reduce-only fill ever).
  const ids = positions.rows.map((p) => p.id);
  const closes = ids.length
    ? await db.query<{ position_id: string; qty: string; notional: string }>(
        `SELECT f.position_id, SUM(f.qty_e6)::text AS qty, SUM(f.qty_e6 * f.exec_price_e6)::text AS notional
         FROM fills f JOIN orders o ON o.id = f.order_id
         WHERE f.position_id = ANY($1) AND o.kind = 'reduce_only'
         GROUP BY f.position_id`,
        [ids],
      )
    : { rows: [] as { position_id: string; qty: string; notional: string }[] };

  const closeByPos = new Map(closes.rows.map((c) => [c.position_id, c]));
  return positions.rows.map((p) => {
    const c = closeByPos.get(p.id);
    const qty = c ? BigInt(c.qty) : 0n;
    return {
      marketId: p.market_id,
      symbol: p.symbol,
      side: p.side === 'long' ? 'Long' : 'Short',
      leverage: Math.round(p.leverage_e2 / 100),
      status: p.status,
      entryE6: p.entry_e6,
      avgCloseE6: c && qty > 0n ? (BigInt(c.notional) / qty).toString() : null,
      realizedPnlUusdc: p.pnl,
      closedQtyE6: qty.toString(),
      openedAt: p.opened_at,
      closedAt: p.closed_at,
    };
  });
}

export interface CustomerHistoryRow {
  kind: 'Deposit' | 'Withdrawal' | 'Trade';
  time: string;
  symbol: string | null; // the market (trades); null for wallet movements
  detail: string | null; // deposit asset / withdrawal dest / trade "Long 5x"
  amountUusdc: string; // signed micro-USDC: deposit +, withdrawal -, trade = realized P/L
  status: string;
}

/**
 * Admin customer-detail history: deposits + withdrawals (getWalletTransactions) and completed trades
 * (getPositionHistory), normalized into ONE reverse-chronological list. Reuses the existing per-user
 * history queries — no new SQL — so the admin view matches what the customer sees.
 */
export async function getCustomerHistory(db: Db, userId: string, limit?: number): Promise<CustomerHistoryRow[]> {
  const [wallet, trades] = await Promise.all([
    getWalletTransactions(db, userId, limit),
    getPositionHistory(db, userId, limit),
  ]);
  const rows: CustomerHistoryRow[] = [];
  for (const w of wallet) {
    const usd = w.usdcE6 ?? '0'; // micro-USDC (credited proceeds / payout); 0 while a deposit is uncredited
    rows.push({
      kind: w.kind === 'deposit' ? 'Deposit' : 'Withdrawal',
      time: w.time,
      symbol: null,
      detail: w.kind === 'deposit' ? w.asset : w.dest,
      amountUusdc: w.kind === 'deposit' ? usd : `-${usd}`,
      status: w.status,
    });
  }
  for (const t of trades) {
    rows.push({
      kind: 'Trade',
      time: t.closedAt ?? t.openedAt,
      symbol: t.symbol,
      detail: `${t.side} ${t.leverage}x`,
      amountUusdc: t.realizedPnlUusdc,
      status: t.status,
    });
  }
  rows.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  return rows.slice(0, clampLimit(limit));
}
