import type { Db } from '../db/client.ts';
import { getOrCreateSystemAccount, getBalance } from './ledger.ts';
import { customerFunds } from './custody/treasury.ts';
import { customerLpTotal } from './lp.ts';

/**
 * House P/L breakdown for the admin Overview. The house's actual earned surplus is the FEE_REVENUE
 * balance — what the platform keeps after every customer AND every LP provider is paid what they're
 * owed. So the breakdown has two halves:
 *
 *  • House earnings — FEE_REVENUE decomposed by source (trading / gacha / funding / liq cuts). These
 *    sum EXACTLY to `surplusE6` (= the FEE_REVENUE balance), with `feesOtherE6` the reconciling
 *    remainder (e.g. fees moved to/from the insurance fund).
 *  • LP side — the LP_POOL streams (its share of trading fees, the funding paid into the pool, trader
 *    P/L it absorbed, plus LP capital). These are owed to LP PROVIDERS, NOT house P/L, so they are
 *    shown for transparency only and reconcile to `lpPoolE6` (the LP_POOL balance) — excluded from
 *    the surplus.
 *
 * The funding split was previously mislabeled: `FUNDING` legs on LP_POOL are the LP pool's funding
 * (`fundingLpE6`), while the house's funding cut is the `FUNDING` legs on FEE_REVENUE (`fundingHouseE6`).
 * Strings, not bigints, so the route can return it without per-field serialization.
 */
export interface HousePnlBreakdown {
  // House earnings — these SIX sum EXACTLY to surplusE6 (the FEE_REVENUE balance).
  feesTradingE6: string; // trading-fee house cut: OPEN_FEE + CLOSE_FEE + REFERRAL_CASHBACK (rebate) legs on FEE_REVENUE
  feesGachaE6: string; // gacha house NET = fee income (revenue − referral) − Gold ACTUALLY spent; excludes the reserve FUNDING (unused part → feesOther). = the "Gacha net (house)" box
  fundingHouseE6: string; // funding house cut: FUNDING legs on FEE_REVENUE
  liqHouseE6: string; // liquidation-penalty house cut: LIQUIDATION_FEE legs on FEE_REVENUE
  bonusCreditedE6: string; // bonus credits ISSUED to customers (net of expiry) — a house cost/debit; the UNUSED credit-budget reserve stays in feesOther
  feesOtherE6: string; // reconciling remainder: fees to/from insurance + the UNUSED reserves (credit budget, gacha-rewards budget) + anything uncategorized
  surplusE6: string; // = FEE_REVENUE balance = the house's net earned surplus (the P/L box; excludes the LP pool)

  // LP side — owed to LP providers, NOT house P/L. These four reconcile to lpPoolE6.
  feesLpE6: string; // LP pool's share of trading fees (OPEN_FEE/CLOSE_FEE legs on LP_POOL)
  fundingLpE6: string; // funding paid into the LP pool (FUNDING legs on LP_POOL) — was the mislabeled "funding net kept"
  fundingLpGrossE6: string; // gross (positive) FUNDING legs on LP_POOL
  traderPnlE6: string; // net trader P/L absorbed by the LP pool (REALIZED_PNL legs on LP_POOL; +ve = LP gained vs traders)
  lpOtherE6: string; // LP_POOL remainder (LP capital in/out) so the LP lines reconcile to lpPoolE6
  lpPoolE6: string; // LP_POOL balance — owed to LP providers (excluded from the house surplus)

  insuranceE6: string; // INSURANCE_FUND balance (incl. liq penalties + insurance transfers)
  liqPenaltiesE6: string; // total liquidation penalties collected (LIQUIDATION_FEE; LP + house shares). A memo.
}

export async function housePnlBreakdown(db: Db): Promise<HousePnlBreakdown> {
  const [lp, fee, ins] = await Promise.all([
    getOrCreateSystemAccount(db, 'LP_POOL'),
    getOrCreateSystemAccount(db, 'FEE_REVENUE'),
    getOrCreateSystemAccount(db, 'INSURANCE_FUND'),
  ]);
  const [lpBal, feeBal, insBal, feeRows, lpRows, liqRows, goldRebateRow, bonusRow] = await Promise.all([
    getBalance(db, lp),
    getBalance(db, fee),
    getBalance(db, ins),
    // FEE_REVENUE legs split by source — the house's actual earnings (CASE, not FILTER, for PGlite).
    db.query<{ trading: string; gacha: string; funding: string; liq: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN reason IN ('OPEN_FEE','CLOSE_FEE','REFERRAL_CASHBACK') THEN amount_uusdc ELSE 0 END), 0)::text AS trading,
         COALESCE(SUM(CASE WHEN (reason LIKE 'GACHA%' AND reason <> 'GACHA_REWARDS_FUND') OR reason = 'GAME_REVENUE_SHARE' THEN amount_uusdc ELSE 0 END), 0)::text AS gacha,
         COALESCE(SUM(CASE WHEN reason = 'FUNDING' THEN amount_uusdc ELSE 0 END), 0)::text AS funding,
         COALESCE(SUM(CASE WHEN reason = 'LIQUIDATION_FEE' THEN amount_uusdc ELSE 0 END), 0)::text AS liq
       FROM ledger_entries WHERE account_id = $1`,
      [fee],
    ),
    // LP_POOL legs split by source — informational (owed to LP providers, not house P/L).
    db.query<{ fees: string; funding: string; funding_gross: string; pnl: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN reason IN ('OPEN_FEE','CLOSE_FEE') THEN amount_uusdc ELSE 0 END), 0)::text AS fees,
         COALESCE(SUM(CASE WHEN reason = 'FUNDING' THEN amount_uusdc ELSE 0 END), 0)::text AS funding,
         COALESCE(SUM(CASE WHEN reason = 'FUNDING' AND amount_uusdc > 0 THEN amount_uusdc ELSE 0 END), 0)::text AS funding_gross,
         COALESCE(SUM(CASE WHEN reason = 'REALIZED_PNL' THEN amount_uusdc ELSE 0 END), 0)::text AS pnl
       FROM ledger_entries WHERE account_id = $1`,
      [lp],
    ),
    // Liquidation penalties split LP_POOL + FEE_REVENUE. Sum the positive (credit) legs across BOTH for
    // the memo total; the house share is also counted in liqHouse, the LP share in lpOther.
    db.query<{ liq: string }>(
      `SELECT COALESCE(SUM(CASE WHEN reason = 'LIQUIDATION_FEE' AND amount_uusdc > 0 THEN amount_uusdc ELSE 0 END), 0)::text AS liq
       FROM ledger_entries WHERE account_id IN ($1, $2)`,
      [lp, fee],
    ),
    // Net USDC actually spent on Gold packs = drawn from the rewards budget minus refunds (PACK_BUY_GOLD_FUND +
    // GACHA_REFUND on GACHA_REWARDS_BUDGET). Deducted from gacha earnings below; the UNUSED budget funding stays in feesOther.
    db.query<{ t: string }>(
      `SELECT COALESCE(SUM(-le.amount_uusdc), 0)::text AS t FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id IS NULL AND a.type = 'GACHA_REWARDS_BUDGET' AND le.reason IN ('PACK_BUY_GOLD_FUND', 'GACHA_REFUND')`,
    ),
    // Bonus credits ISSUED to customers (net of clawbacks) — the credit-budget analogue of the Gold spend:
    // SIGNUP_BONUS + DEPOSIT_BONUS − BONUS_EXPIRE on customer collateral. Its own house-cost line; the UNUSED
    // credit-budget reserve stays in feesOther (mirrors gold: spent → own line, unspent → Other).
    db.query<{ t: string }>(
      `SELECT COALESCE(SUM(le.amount_uusdc), 0)::text AS t FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE a.type = 'USER_COLLATERAL' AND le.reason IN ('SIGNUP_BONUS', 'DEPOSIT_BONUS', 'BONUS_EXPIRE')`,
    ),
  ]);

  // House earnings: FEE_REVENUE decomposed; feesOther is the remainder so the lines sum to the balance.
  const feesTrading = BigInt(feeRows.rows[0].trading);
  // Gacha house earnings = gacha fee income (revenue − referral) MINUS the Gold ACTUALLY spent on packs. The
  // gacha-rewards budget FUNDING is excluded from the `gacha` sum above (it's a reserve, not a cut) → its UNUSED
  // portion falls into feesOther, matching how the bonus/credit budget funding is treated. Equals the "Gacha net" box.
  const feesGacha = BigInt(feeRows.rows[0].gacha) - BigInt(goldRebateRow.rows[0].t);
  const fundingHouse = BigInt(feeRows.rows[0].funding);
  const liqHouse = BigInt(feeRows.rows[0].liq);
  // Bonus credits issued to customers — a house cost (debit) on its own line (a customer-acquisition cost, not a
  // gacha/trading cut). `bonusRow` sums the POSITIVE credits net of expiry, so negate it into a debit.
  const bonusCredited = -BigInt(bonusRow.rows[0].t);
  const feesOther = feeBal - feesTrading - feesGacha - fundingHouse - liqHouse - bonusCredited;

  // LP side: LP_POOL decomposed; lpOther is the remainder so the lines sum to the pool balance.
  const feesLp = BigInt(lpRows.rows[0].fees);
  const fundingLp = BigInt(lpRows.rows[0].funding);
  const traderPnl = BigInt(lpRows.rows[0].pnl);
  const lpOther = lpBal - feesLp - fundingLp - traderPnl;

  return {
    feesTradingE6: feesTrading.toString(),
    feesGachaE6: feesGacha.toString(),
    fundingHouseE6: fundingHouse.toString(),
    liqHouseE6: liqHouse.toString(),
    bonusCreditedE6: bonusCredited.toString(),
    feesOtherE6: feesOther.toString(),
    surplusE6: feeBal.toString(),
    feesLpE6: feesLp.toString(),
    fundingLpE6: fundingLp.toString(),
    fundingLpGrossE6: BigInt(lpRows.rows[0].funding_gross).toString(),
    traderPnlE6: traderPnl.toString(),
    lpOtherE6: lpOther.toString(),
    lpPoolE6: lpBal.toString(),
    insuranceE6: insBal.toString(),
    liqPenaltiesE6: BigInt(liqRows.rows[0].liq).toString(),
  };
}

export interface HouseEconomics {
  freeE6: string; // total customer free collateral
  lockedE6: string; // total customer margin locked in open positions
  customerLpE6: string; // total current value of customers' LP-pool stakes
  insuranceE6: string; // insurance-fund balance
  surplusE6: string; // house net earned surplus = FEE_REVENUE balance (fees earned, excl. the LP pool) — the P/L box
  feeRevenueE6: string; // = surplus (kept for the fees → insurance allocatable readout)
  fundingHouseE6: string; // house cut of funding (FUNDING legs on FEE_REVENUE)
  fundingLpE6: string; // funding paid into the LP pool (FUNDING legs on LP_POOL) — owed to LP providers, NOT house
  fundingCollectedE6: string; // gross funding into the LP pool (positive FUNDING legs on LP_POOL)
  gachaNetE6: string; // net gacha fees to the house = gacha revenue − Gold rebate − referral share (matches the Gacha-tab NET)
  referralFeesPaidE6: string; // total paid OUT to referrers: REFERRAL_CASHBACK (perps) + GAME_REVENUE_SHARE (gacha)
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

/** Gacha/referral totals for the operator Overview (ledger-derived). gachaNet is computed the SAME way as the
 *  Gacha-tab NET (gacha-monitoring.ts) so the two agree: NARROW gacha revenue (the 4 GACHA_* FEE_REVENUE reasons)
 *  − Gold rebate (budget draw) − gacha referral share. NB do NOT use feesGachaE6 − rebate: feesGachaE6's broad
 *  `GACHA%` filter also nets the GACHA_REWARDS_FUND budget top-up, so that would double-count the gold flow.
 *  referralPaid = total paid OUT to referrers: perps (REFERRAL_CASHBACK) + gacha (GAME_REVENUE_SHARE); both are
 *  negative legs on FEE_REVENUE, so SUM(-amount) is the positive amount paid. */
async function gachaEconomicsExtras(db: Db): Promise<{ gachaNet: bigint; referralPaid: bigint }> {
  const [fee, rebate] = await Promise.all([
    // one pass over FEE_REVENUE (CASE, mirroring housePnlBreakdown): narrow gacha revenue, the gacha referral
    // share (subtracted from gacha net), and total referral paid across perps + gacha (both negative legs).
    db.query<{ rev: string; gacha_ref: string; all_ref: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN reason IN ('GACHA_SELLBACK','GACHA_TURBO_SELL','GACHA_PACK_BUY','GACHA_REFUND') THEN amount_uusdc ELSE 0 END), 0)::text AS rev,
         COALESCE(SUM(CASE WHEN reason = 'GAME_REVENUE_SHARE' THEN -amount_uusdc ELSE 0 END), 0)::text AS gacha_ref,
         COALESCE(SUM(CASE WHEN reason IN ('REFERRAL_CASHBACK','GAME_REVENUE_SHARE') THEN -amount_uusdc ELSE 0 END), 0)::text AS all_ref
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
      WHERE a.user_id IS NULL AND a.type = 'FEE_REVENUE'`,
    ),
    db.query<{ t: string }>(
      `SELECT COALESCE(SUM(-le.amount_uusdc), 0)::text AS t FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id IS NULL AND a.type = 'GACHA_REWARDS_BUDGET' AND le.reason IN ('PACK_BUY_GOLD_FUND', 'GACHA_REFUND')`,
    ),
  ]);
  const f = fee.rows[0];
  return {
    gachaNet: BigInt(f.rev) - BigInt(rebate.rows[0].t) - BigInt(f.gacha_ref), // = Gacha-tab NET (revenue − rebate − referral)
    referralPaid: BigInt(f.all_ref),
  };
}

/**
 * House economics for the admin Overview — ALL ledger-derived (no chain reads, no real-funds
 * requirement), so it renders in BOTH play-money and real-funds modes. The chain/custody figures
 * (hot/cold, on-chain total, proof-of-reserves, pending payouts) stay in the real-funds-only
 * /admin/treasury endpoint and layer on top of this when present.
 */
export async function houseEconomics(db: Db): Promise<HouseEconomics> {
  const [cust, customerLp, bd, flows, gx] = await Promise.all([
    customerFunds(db),
    customerLpTotal(db),
    housePnlBreakdown(db),
    customerFlowTotals(db),
    gachaEconomicsExtras(db),
  ]);
  return {
    freeE6: cust.freeE6.toString(),
    lockedE6: cust.lockedE6.toString(),
    customerLpE6: customerLp.toString(),
    insuranceE6: bd.insuranceE6, // INSURANCE_FUND balance (same source as treasuryState's)
    surplusE6: bd.surplusE6, // FEE_REVENUE balance — the house's earned surplus (the P/L box)
    feeRevenueE6: bd.surplusE6, // = surplus; kept for the fees → insurance allocatable readout
    fundingHouseE6: bd.fundingHouseE6, // house's funding cut (FUNDING on FEE_REVENUE)
    fundingLpE6: bd.fundingLpE6, // funding paid into the LP pool (FUNDING on LP_POOL) — owed to LP providers
    // gross + LP funding come from the SAME query (housePnlBreakdown's LP scan), so gross >= the net LP
    // share always holds — no race between two snapshots (the same approach treasuryState uses).
    fundingCollectedE6: bd.fundingLpGrossE6,
    gachaNetE6: gx.gachaNet.toString(), // = Gacha-tab NET: narrow gacha revenue − Gold rebate − gacha referral share
    referralFeesPaidE6: gx.referralPaid.toString(),
    totalDepositsE6: flows.deposits.toString(),
    totalWithdrawalsE6: flows.withdrawals.toString(),
    pnlBreakdown: bd,
  };
}
