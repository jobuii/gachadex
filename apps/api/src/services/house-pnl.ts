import type { Db } from '../db/client.ts';
import { getOrCreateSystemAccount, getBalance } from './ledger.ts';
import { customerFunds } from './custody/treasury.ts';
import { customerLpTotal } from './lp.ts';

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
  fundingGrossE6: string; // gross funding customers paid in (positive FUNDING legs on LP_POOL)
  traderPnlE6: string; // net trader P/L the house absorbed (REALIZED_PNL legs on LP_POOL; +ve = house gained)
  liqPenaltiesE6: string; // total liquidation penalties collected (LIQUIDATION_FEE; split LP_POOL + FEE_REVENUE). A memo — the shares are already counted inside feesHouse + lpOther.
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
    db.query<{ fees: string; funding: string; funding_gross: string; pnl: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN reason IN ('OPEN_FEE','CLOSE_FEE') THEN amount_uusdc ELSE 0 END), 0)::text AS fees,
         COALESCE(SUM(CASE WHEN reason = 'FUNDING' THEN amount_uusdc ELSE 0 END), 0)::text AS funding,
         COALESCE(SUM(CASE WHEN reason = 'FUNDING' AND amount_uusdc > 0 THEN amount_uusdc ELSE 0 END), 0)::text AS funding_gross,
         COALESCE(SUM(CASE WHEN reason = 'REALIZED_PNL' THEN amount_uusdc ELSE 0 END), 0)::text AS pnl
       FROM ledger_entries WHERE account_id = $1`,
      [lp],
    ),
    // Liquidation penalties now split LP_POOL + FEE_REVENUE (no longer routed to insurance). Sum the
    // positive (credit) legs across BOTH for the memo total; the shares already sit inside feesHouse + lpOther.
    db.query<{ liq: string }>(
      `SELECT COALESCE(SUM(CASE WHEN reason = 'LIQUIDATION_FEE' AND amount_uusdc > 0 THEN amount_uusdc ELSE 0 END), 0)::text AS liq
       FROM ledger_entries WHERE account_id IN ($1, $2)`,
      [lp, fee],
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
    fundingGrossE6: BigInt(lpRows.rows[0].funding_gross).toString(),
    traderPnlE6: traderPnl.toString(),
    liqPenaltiesE6: BigInt(liqRows.rows[0].liq).toString(),
    insuranceE6: insBal.toString(),
    lpOtherE6: lpOther.toString(),
    totalE6: total.toString(),
  };
}

export interface HouseEconomics {
  freeE6: string; // total customer free collateral
  lockedE6: string; // total customer margin locked in open positions
  customerLpE6: string; // total current value of customers' LP-pool stakes
  insuranceE6: string; // insurance-fund balance
  feeRevenueE6: string; // house cut of trading fees (FEE_REVENUE)
  fundingCollectedE6: string; // gross funding customers paid in
  fundingRevenueE6: string; // net funding the house kept
  totalDepositsE6: string; // lifetime credited customer deposits (real-funds; 0 in play-money)
  totalWithdrawalsE6: string; // lifetime confirmed customer withdrawals (real-funds; 0 in play-money)
  pnlBreakdown: HousePnlBreakdown;
}

/** Lifetime customer cash flows from the custody tables — credited deposits + confirmed withdrawals.
 *  Empty (0) in play-money mode, where those tables aren't used. */
async function customerFlowTotals(db: Db): Promise<{ deposits: bigint; withdrawals: bigint }> {
  const [dep, wd] = await Promise.all([
    db.query<{ s: string }>(`SELECT COALESCE(SUM(usdc_credited_e6), 0)::text AS s FROM deposits WHERE status = 'credited'`),
    db.query<{ s: string }>(`SELECT COALESCE(SUM(amount_e6), 0)::text AS s FROM withdrawals WHERE status = 'confirmed'`),
  ]);
  return { deposits: BigInt(dep.rows[0].s), withdrawals: BigInt(wd.rows[0].s) };
}

/**
 * House economics for the admin Overview — ALL ledger-derived (no chain reads, no real-funds
 * requirement), so it renders in BOTH play-money and real-funds modes. The chain/custody figures
 * (hot/cold, on-chain total, proof-of-reserves, pending payouts) stay in the real-funds-only
 * /admin/treasury endpoint and layer on top of this when present.
 */
export async function houseEconomics(db: Db): Promise<HouseEconomics> {
  const [cust, customerLp, bd, flows] = await Promise.all([
    customerFunds(db),
    customerLpTotal(db),
    housePnlBreakdown(db),
    customerFlowTotals(db),
  ]);
  return {
    freeE6: cust.freeE6.toString(),
    lockedE6: cust.lockedE6.toString(),
    customerLpE6: customerLp.toString(),
    insuranceE6: bd.insuranceE6, // INSURANCE_FUND balance (same source as treasuryState's)
    feeRevenueE6: bd.feesHouseE6, // FEE_REVENUE balance
    // gross + net funding come from the SAME query (housePnlBreakdown's LP scan), so gross >= net always
    // holds — no race between two snapshots (the same approach treasuryState uses).
    fundingCollectedE6: bd.fundingGrossE6,
    fundingRevenueE6: bd.fundingNetE6,
    totalDepositsE6: flows.deposits.toString(),
    totalWithdrawalsE6: flows.withdrawals.toString(),
    pnlBreakdown: bd,
  };
}
