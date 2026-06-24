import { notional } from '@pokex/pricing';
import { advisoryXactLock, type Db, type Queryer } from '../db/client.ts';
import { openNotionalBySide } from './oi.ts';
import { getFundingFactorBps, getLpFundingPct } from './fees.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn } from './ledger.ts';

/**
 * Funding balances long/short skew given that the external index barely moves intraday.
 * A cumulative funding index advances each interval by a skew-proportional rate; positions
 * settle LAZILY (their snapshot vs the current cumulative) on their next interaction.
 * Convention: cumulative rises when longs are heavy -> longs pay, shorts receive.
 * The LP pool intermediates (it is the counterparty); funding flows position <-> LP_POOL, with the house
 * keeping a configurable cut — getLpFundingPct() of each settlement goes to the pool, the rest to FEE_REVENUE.
 */

export async function getCumulativeFundingE6(q: Queryer, marketId: string): Promise<bigint> {
  const r = await q.query<{ c: string }>(
    `SELECT cumulative_index_e6::text AS c FROM funding_rates WHERE market_id=$1 ORDER BY interval_end DESC LIMIT 1`,
    [marketId],
  );
  return r.rows[0] ? BigInt(r.rows[0].c) : 0n;
}

/** Append a funding interval, advancing the cumulative index by a skew-proportional rate. */
export async function accrueFunding(db: Db, marketId: string): Promise<{ rateE6: string; cumulativeE6: string }> {
  return db.tx(async (q) => {
    await advisoryXactLock(q, marketId); // serialize with trades/liquidations on this market
    const { longOi, shortOi } = await openNotionalBySide(q, marketId);
    const oi = longOi + shortOi;
    let skewBps = 0;
    if (oi > 0n) {
      const skewRatio = Number(longOi - shortOi) / Number(oi); // -1..1
      skewBps = Math.round(getFundingFactorBps() * skewRatio); // operator-tunable max (admin panel)
    }
    const rateE6 = BigInt(Math.round((skewBps / 10_000) * 1_000_000)); // bps -> 1e6 fraction
    const cumulative = (await getCumulativeFundingE6(q, marketId)) + rateE6;
    const now = new Date().toISOString();
    await q.query(
      `INSERT INTO funding_rates(market_id, interval_start, interval_end, rate_e6, skew_uusdc, cumulative_index_e6)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [marketId, now, now, rateE6.toString(), (longOi - shortOi).toString(), cumulative.toString()],
    );
    return { rateE6: rateE6.toString(), cumulativeE6: cumulative.toString() };
  });
}

export interface FundablePosition {
  id: string;
  user_id: string;
  side: 'long' | 'short';
  qty_e6: string;
  avg_entry_e6: string;
  funding_index_snapshot_e6: string;
}

/** Settle a position's accrued funding (called before close/increase). Returns signed amount paid. */
export async function settlePositionFunding(q: Queryer, position: FundablePosition, marketId: string): Promise<bigint> {
  const cumNow = await getCumulativeFundingE6(q, marketId);
  const snapshot = BigInt(position.funding_index_snapshot_e6 ?? '0');
  const delta = cumNow - snapshot;
  let signed = 0n;
  if (delta !== 0n) {
    const notion = notional(BigInt(position.qty_e6), BigInt(position.avg_entry_e6));
    const base = (notion * delta) / 1_000_000n;
    signed = position.side === 'long' ? base : -base; // long pays when delta>0
    if (signed !== 0n) {
      const coll = await getOrCreateUserAccount(q, position.user_id, 'USER_COLLATERAL');
      const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
      const rev = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
      const lpPart = (signed * BigInt(getLpFundingPct())) / 100n; // LP's configured share; the house keeps the rest
      // One balanced txn in either direction: payer's collateral <-> (LP share + house share). postTxn drops
      // any zero leg, so a 100% LP share still nets clean, and the house shares both inflows and outflows.
      await postTxn(q, { reason: 'FUNDING', refType: 'position', refId: position.id, entries: [
        { accountId: coll, amount: -signed },
        { accountId: lp, amount: lpPart },
        { accountId: rev, amount: signed - lpPart },
      ] });
    }
  }
  await q.query(`UPDATE positions SET funding_index_snapshot_e6=$1 WHERE id=$2`, [cumNow.toString(), position.id]);
  return signed;
}
