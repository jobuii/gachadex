import type { Db } from '../db/client.ts';
import { getOrCreateSystemAccount, getBalance } from './ledger.ts';

/**
 * House P/L breakdown for the admin Overview. Decomposes the platform's net equity into where it
 * actually comes from, by summing the house system-account ledger legs by reason. The lines sum
 * EXACTLY to `totalE6` = bal(FEE_REVENUE) + bal(LP_POOL) + bal(INSURANCE_FUND) — the house's ledger
 * equity, which the custody P/L (treasury − customer − pending) tracks.
 *
 * LP_POOL holds several streams (its share of trading fees, funding, trader P/L, plus margin/LP
 * capital), so it's decomposed by reason with `lpOtherE6` as the reconciling remainder. Strings, not
 * bigints, so the route can return it without per-field serialization (the funding-box bug class).
 */
export interface HousePnlBreakdown {
  feesHouseE6: string; // FEE_REVENUE balance — the house's cut of trading fees (net of insurance moves)
  feesLpE6: string; // the LP pool's share of trading fees (OPEN_FEE/CLOSE_FEE legs on LP_POOL)
  fundingNetE6: string; // net funding the house kept (FUNDING legs on LP_POOL)
  traderPnlE6: string; // net trader P/L the house absorbed (REALIZED_PNL legs on LP_POOL; +ve = house gained)
  liqPenaltiesE6: string; // liquidation penalties (LIQUIDATION_FEE legs; sit inside INSURANCE_FUND)
  insuranceE6: string; // INSURANCE_FUND balance (incl. liq penalties + insurance transfers)
  lpOtherE6: string; // LP_POOL remainder (LP capital in/out + insurance draws) so the LP lines reconcile
  totalE6: string; // = feesHouse + LP balance + insurance = the house's ledger equity (≈ the P/L box)
}

export async function housePnlBreakdown(db: Db): Promise<HousePnlBreakdown> {
  const [lp, fee, ins] = await Promise.all([
    getOrCreateSystemAccount(db, 'LP_POOL'),
    getOrCreateSystemAccount(db, 'FEE_REVENUE'),
    getOrCreateSystemAccount(db, 'INSURANCE_FUND'),
  ]);
  const [lpBal, feeBal, insBal, lpRows, liqRows] = await Promise.all([
    getBalance(db, lp),
    getBalance(db, fee),
    getBalance(db, ins),
    // LP_POOL legs split by source (CASE, not FILTER, for PGlite compatibility).
    db.query<{ fees: string; funding: string; pnl: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN reason IN ('OPEN_FEE','CLOSE_FEE') THEN amount_uusdc ELSE 0 END), 0)::text AS fees,
         COALESCE(SUM(CASE WHEN reason = 'FUNDING' THEN amount_uusdc ELSE 0 END), 0)::text AS funding,
         COALESCE(SUM(CASE WHEN reason = 'REALIZED_PNL' THEN amount_uusdc ELSE 0 END), 0)::text AS pnl
       FROM ledger_entries WHERE account_id = $1`,
      [lp],
    ),
    db.query<{ liq: string }>(
      `SELECT COALESCE(SUM(CASE WHEN reason = 'LIQUIDATION_FEE' THEN amount_uusdc ELSE 0 END), 0)::text AS liq
       FROM ledger_entries WHERE account_id = $1`,
      [ins],
    ),
  ]);

  const feesLp = BigInt(lpRows.rows[0].fees);
  const fundingNet = BigInt(lpRows.rows[0].funding);
  const traderPnl = BigInt(lpRows.rows[0].pnl);
  const lpOther = lpBal - feesLp - fundingNet - traderPnl; // whatever else sits in LP (margin/LP capital)
  const total = feeBal + lpBal + insBal;
  return {
    feesHouseE6: feeBal.toString(),
    feesLpE6: feesLp.toString(),
    fundingNetE6: fundingNet.toString(),
    traderPnlE6: traderPnl.toString(),
    liqPenaltiesE6: BigInt(liqRows.rows[0].liq).toString(),
    insuranceE6: insBal.toString(),
    lpOtherE6: lpOther.toString(),
    totalE6: total.toString(),
  };
}
