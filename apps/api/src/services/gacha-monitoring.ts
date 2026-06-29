import type { Db } from '../db/client.ts';
import { HttpError } from '../errors.ts';
import { getOrCreateSystemAccount, getBalance, getBalanceForUpdate, postTxn } from './ledger.ts';

/**
 * Classic Gacha economics + activity readout (docs/classic-gacha-cc-packs-spec.md §6/§12, plus operator stats).
 * Pure SQL over the ledger + gacha tables (no web3 dep → loads on the admin path eagerly):
 *   - Economics: sell-back cut revenue (+ optional markup) vs the Gold-rebate cost, the operator net, and the
 *     live sell-back rate (break-even ≈ 57%).
 *   - Activity: packs opened all-time + last 24h, USDC volume, prize value delivered, unique players, withdraws,
 *     biggest pull, and the realized rarity mix (the "live odds") all-time + last 24h.
 *   - Per machine: opens (all-time + 24h), prize value, the operator net (cut + markup − rebate, attributed via
 *     the ledger ref), and the realized rarity mix all-time + 24h.
 * A turbo auto-sell has no `rarity` row (it's always a Common) → counted as common.
 */
type RarityCounts = Record<string, number>;
export interface GachaMachineStats {
  code: string;
  opens: number; opens24h: number;
  prizeValueE6: string;
  revenueE6: string; rebateE6: string; netE6: string;
  rarity: RarityCounts; rarity24h: RarityCounts;
}
export interface GachaMonitoring {
  // economics
  sellBackCutE6: string; markupE6: string; revenueE6: string; rebateCostE6: string; netE6: string; rewardsBudgetE6: string; feeRevenueE6: string;
  deliveredCards: number; soldBack: number; kept: number; sellBackRatePct: number;
  // activity
  packsOpened: number; packsOpened24h: number; volumeUsdcE6: string; goldPacks: number; prizeValueE6: string;
  biggestPullE6: string; players: number; withdraws: number;
  rarity: RarityCounts; rarity24h: RarityCounts;
  stuckSelling: number; stuckWithdrawing: number; // in-flight rows a crash could strand → the reconciler clears these
  stuckPaidOpens: number; stuckPaidE6: string; oldestStuckPaidMins: number; // aged 'paid' opens (charged, undelivered) the auto-reconciler should refund — non-zero = investigate
  // per machine
  machines: GachaMachineStats[];
}

// PGlite may hand back a SUM(numeric)::text / TEXT amount as a string OR a number; take the leading integer
// part (amounts are whole micro-USDC) and fall back to 0 for null/empty/unparseable.
const intStr = (v: string | number | null | undefined): bigint => {
  if (v == null) return 0n;
  const m = String(v).trim().match(/^-?\d+/);
  return m ? BigInt(m[0]) : 0n;
};
const num = (v: string | number | null | undefined): number => Number(v ?? 0) || 0;

export async function gachaMonitoring(db: Db): Promise<GachaMonitoring> {
  const OPENED = `status IN ('opened', 'turbo_sold')`;
  const [fee, rebate, budget, feeBal, inv, activity, perMachine, machineNet] = await Promise.all([
    // FEE_REVENUE credited per gacha reason (join to the unique system account to isolate the fee leg).
    db.query<{ reason: string; total: string }>(
      `SELECT le.reason, COALESCE(SUM(le.amount_uusdc::numeric), 0)::text AS total
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id IS NULL AND a.type = 'FEE_REVENUE'
          AND le.reason IN ('GACHA_SELLBACK', 'GACHA_TURBO_SELL', 'GACHA_PACK_BUY', 'GACHA_REFUND')
        GROUP BY le.reason`,
    ),
    // Rebate cost = USDC drawn from the rewards budget to fund gold-bought packs (the budget legs are negative).
    db.query<{ total: string }>(
      `SELECT COALESCE(SUM(-le.amount_uusdc::numeric), 0)::text AS total
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id IS NULL AND a.type = 'GACHA_REWARDS_BUDGET' AND le.reason = 'PACK_BUY_GOLD_FUND'`,
    ),
    db.query<{ amount_uusdc: string }>(
      `SELECT b.amount_uusdc FROM balances b JOIN accounts a ON a.id = b.account_id
        WHERE a.user_id IS NULL AND a.type = 'GACHA_REWARDS_BUDGET'`,
    ),
    // FEE_REVENUE balance = the earned platform fees available to sweep into the rewards budget.
    db.query<{ amount_uusdc: string }>(
      `SELECT b.amount_uusdc FROM balances b JOIN accounts a ON a.id = b.account_id
        WHERE a.user_id IS NULL AND a.type = 'FEE_REVENUE'`,
    ),
    // Inventory by status → sell-back rate (sold) + the withdraw count.
    db.query<{ status: string; n: string }>(`SELECT status, COUNT(*)::text AS n FROM gacha_nft_inventory GROUP BY status`),
    // Overall activity (one pass over the opens).
    db.query<{ opened: string; opened_24h: string; turbo_sold: string; volume_usdc: string; gold_packs: string; prize_value: string; biggest: string; players: string; stuck_paid: string; stuck_paid_e6: string; oldest_stuck_paid_mins: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE ${OPENED})::text AS opened,
         COUNT(*) FILTER (WHERE ${OPENED} AND created_at >= now() - interval '24 hours')::text AS opened_24h,
         COUNT(*) FILTER (WHERE status = 'turbo_sold')::text AS turbo_sold,
         COALESCE(SUM(price_e6) FILTER (WHERE ${OPENED} AND paid_with = 'usdc'), 0)::text AS volume_usdc,
         COUNT(*) FILTER (WHERE ${OPENED} AND paid_with = 'gold')::text AS gold_packs,
         COALESCE(SUM(insured_value_e6) FILTER (WHERE ${OPENED}), 0)::text AS prize_value,
         COALESCE(MAX(insured_value_e6) FILTER (WHERE ${OPENED}), 0)::text AS biggest,
         COUNT(DISTINCT user_id) FILTER (WHERE ${OPENED})::text AS players,
         COUNT(*) FILTER (WHERE status = 'paid' AND created_at < now() - interval '90 seconds')::text AS stuck_paid,
         COALESCE(SUM(price_e6) FILTER (WHERE status = 'paid' AND created_at < now() - interval '90 seconds'), 0)::text AS stuck_paid_e6,
         COALESCE(ROUND(EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE status = 'paid' AND created_at < now() - interval '90 seconds'))) / 60), 0)::text AS oldest_stuck_paid_mins
       FROM gacha_pack_opens`,
    ),
    // Per machine × rarity, all-time + last-24h counts + prize value (turbo auto-sells count as common).
    // LOWER(rarity): the DB stores capitalized tiers ('Common'/'Uncommon'/'Rare'/'Epic') but the web's
    // RARITY_TIERS keys are lowercase — without this the odds box reads 0% for every real (non-null) pull.
    db.query<{ machine_code: string; rarity: string; n: string; n_24h: string; prize_value: string }>(
      `SELECT machine_code, COALESCE(LOWER(rarity), 'common') AS rarity,
              COUNT(*)::text AS n,
              COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::text AS n_24h,
              COALESCE(SUM(insured_value_e6), 0)::text AS prize_value
         FROM gacha_pack_opens WHERE ${OPENED}
        GROUP BY machine_code, COALESCE(LOWER(rarity), 'common')`,
    ),
    // Per-machine operator net: FEE_REVENUE (cut + markup) − rewards-budget draw, attributed to the machine via
    // the ledger ref (gacha_open → the open; gacha_prize → the prize's open).
    db.query<{ machine_code: string; revenue: string; rebate: string }>(
      `WITH attrib AS (
         SELECT le.reason, a.type AS acct, le.amount_uusdc::numeric AS amt,
                COALESCE(o.machine_code, oi.machine_code) AS machine_code
           FROM ledger_entries le
           JOIN accounts a ON a.id = le.account_id AND a.user_id IS NULL
           LEFT JOIN gacha_pack_opens o ON le.ref_type = 'gacha_open' AND o.id = le.ref_id
           LEFT JOIN gacha_nft_inventory ginv ON le.ref_type = 'gacha_prize' AND ginv.id = le.ref_id
           LEFT JOIN gacha_pack_opens oi ON oi.id = ginv.open_id
          WHERE (a.type = 'FEE_REVENUE' AND le.reason IN ('GACHA_SELLBACK', 'GACHA_TURBO_SELL', 'GACHA_PACK_BUY', 'GACHA_REFUND'))
             OR (a.type = 'GACHA_REWARDS_BUDGET' AND le.reason = 'PACK_BUY_GOLD_FUND')
       )
       SELECT machine_code,
              COALESCE(SUM(amt) FILTER (WHERE acct = 'FEE_REVENUE'), 0)::text AS revenue,
              COALESCE(SUM(-amt) FILTER (WHERE acct = 'GACHA_REWARDS_BUDGET'), 0)::text AS rebate
         FROM attrib WHERE machine_code IS NOT NULL GROUP BY machine_code`,
    ),
  ]);

  // economics
  let sellBackCut = 0n;
  let markup = 0n;
  for (const r of fee.rows) {
    if (r.reason === 'GACHA_PACK_BUY' || r.reason === 'GACHA_REFUND') markup += intStr(r.total); // GACHA_REFUND fee leg = the −markup reversal, so a refunded buy nets out of "markup banked"
    else sellBackCut += intStr(r.total);
  }
  const rebateCost = intStr(rebate.rows[0]?.total);
  const rewardsBudget = intStr(budget.rows[0]?.amount_uusdc);
  const totalInv = inv.rows.reduce((a, r) => a + num(r.n), 0);
  const sold = num(inv.rows.find((r) => r.status === 'sold')?.n);
  const withdraws = num(inv.rows.find((r) => r.status === 'withdrawn')?.n);
  const stuckSelling = num(inv.rows.find((r) => r.status === 'selling')?.n);
  const stuckWithdrawing = num(inv.rows.find((r) => r.status === 'withdrawing')?.n);
  const a0 = activity.rows[0];
  // delivered = inventory rows (opened NFTs) + turbo auto-sells (which write no inventory row, always Common).
  const packsOpened = num(a0?.opened);
  const turboSold = num(a0?.turbo_sold);
  const delivered = totalInv + turboSold;
  const soldBack = sold + turboSold;
  const revenue = sellBackCut + markup;

  // per-machine pivot (also aggregates the overall rarity mix)
  const netByMachine = new Map(machineNet.rows.map((r) => [r.machine_code, { revenue: intStr(r.revenue), rebate: intStr(r.rebate) }]));
  const byCode = new Map<string, GachaMachineStats>();
  const rarityAll: RarityCounts = {};
  const rarity24hAll: RarityCounts = {};
  for (const r of perMachine.rows) {
    const m = byCode.get(r.machine_code) ?? { code: r.machine_code, opens: 0, opens24h: 0, prizeValueE6: '0', revenueE6: '0', rebateE6: '0', netE6: '0', rarity: {}, rarity24h: {} };
    const n = num(r.n);
    const n24 = num(r.n_24h);
    m.opens += n;
    m.opens24h += n24;
    m.prizeValueE6 = (BigInt(m.prizeValueE6) + intStr(r.prize_value)).toString();
    m.rarity[r.rarity] = (m.rarity[r.rarity] ?? 0) + n;
    if (n24) m.rarity24h[r.rarity] = (m.rarity24h[r.rarity] ?? 0) + n24;
    rarityAll[r.rarity] = (rarityAll[r.rarity] ?? 0) + n;
    if (n24) rarity24hAll[r.rarity] = (rarity24hAll[r.rarity] ?? 0) + n24;
    byCode.set(r.machine_code, m);
  }
  for (const m of byCode.values()) {
    const net = netByMachine.get(m.code);
    if (net) { m.revenueE6 = net.revenue.toString(); m.rebateE6 = net.rebate.toString(); m.netE6 = (net.revenue - net.rebate).toString(); }
  }
  const machines = [...byCode.values()].sort((x, y) => y.opens - x.opens);

  return {
    sellBackCutE6: sellBackCut.toString(),
    markupE6: markup.toString(),
    revenueE6: revenue.toString(),
    rebateCostE6: rebateCost.toString(),
    netE6: (revenue - rebateCost).toString(),
    rewardsBudgetE6: rewardsBudget.toString(),
    feeRevenueE6: intStr(feeBal.rows[0]?.amount_uusdc).toString(),
    deliveredCards: delivered,
    soldBack,
    kept: delivered - soldBack,
    sellBackRatePct: delivered > 0 ? Math.round((soldBack / delivered) * 1000) / 10 : 0,
    packsOpened,
    packsOpened24h: num(a0?.opened_24h),
    volumeUsdcE6: intStr(a0?.volume_usdc).toString(),
    goldPacks: num(a0?.gold_packs),
    prizeValueE6: intStr(a0?.prize_value).toString(),
    biggestPullE6: intStr(a0?.biggest).toString(),
    players: num(a0?.players),
    withdraws,
    rarity: rarityAll,
    rarity24h: rarity24hAll,
    stuckSelling,
    stuckWithdrawing,
    stuckPaidOpens: num(a0?.stuck_paid),
    stuckPaidE6: intStr(a0?.stuck_paid_e6).toString(),
    oldestStuckPaidMins: num(a0?.oldest_stuck_paid_mins),
    machines,
  };
}

/**
 * Pre-fund the Gold rewards budget by sweeping earned platform fees into it. A pure ledger reallocation
 * FEE_REVENUE → GACHA_REWARDS_BUDGET (Σ=0, no on-chain move — both are house buckets backed by the same
 * treasury/hot-wallet USDC). Capped at the current FEE_REVENUE balance: you can only earmark fees you've
 * actually earned, never invent USDC or drive FEE_REVENUE negative. The budget is what funds Gold-bought packs
 * (PACK_BUY_GOLD_FUND debits it), so the operator runs this before enabling pay-with-Gold.
 */
export async function fundGachaRewardsBudget(db: Db, amountE6: bigint): Promise<{ rewardsBudgetE6: string; feeRevenueE6: string; movedE6: string }> {
  if (amountE6 <= 0n) throw new HttpError(400, 'amount must be positive');
  return db.tx(async (q) => {
    const fee = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
    const budget = await getOrCreateSystemAccount(q, 'GACHA_REWARDS_BUDGET');
    // Lock the FEE_REVENUE balance row so concurrent debits (another sweep, a fee→insurance move) can't both
    // pass the cap and over-draw it.
    if ((await getBalanceForUpdate(q, fee)) < amountE6) throw new HttpError(400, 'amount exceeds the earned fee revenue available to sweep', 'insufficient_fee_revenue');
    await postTxn(q, {
      reason: 'GACHA_REWARDS_FUND', refType: 'admin', refId: null,
      entries: [{ accountId: fee, amount: -amountE6 }, { accountId: budget, amount: amountE6 }],
    });
    return {
      rewardsBudgetE6: (await getBalance(q, budget)).toString(),
      feeRevenueE6: (await getBalance(q, fee)).toString(),
      movedE6: amountE6.toString(),
    };
  });
}
