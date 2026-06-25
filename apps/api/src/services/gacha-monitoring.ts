import type { Db } from '../db/client.ts';

/**
 * Classic Gacha economics readout (docs/classic-gacha-cc-packs-spec.md §6/§12). Lets the operator watch the
 * launch net — sell-back cut revenue (+ optional markup) vs the Token-rebate cost — and the live sell-back rate
 * (break-even ≈ 57%; turn on the markup knob if it drifts there). Pure SQL over the ledger + gacha tables — no
 * web3 dependency, so it loads on the admin path eagerly.
 */
export interface GachaMonitoring {
  sellBackCutE6: string; // FEE_REVENUE earned on GACHA_SELLBACK + GACHA_TURBO_SELL (GDEX's cut of buybacks)
  markupE6: string; // FEE_REVENUE earned on GACHA_PACK_BUY (the optional purchase markup)
  revenueE6: string; // sellBackCut + markup
  rebateCostE6: string; // real USDC spent funding token-bought packs (the loyalty rebate)
  netE6: string; // revenue − rebateCost
  rewardsBudgetE6: string; // current GACHA_REWARDS_BUDGET balance (pre-funded, drawn down by token packs)
  deliveredCards: number; // opened NFTs + turbo auto-sold commons
  soldBack: number; // inventory 'sold' + turbo_sold
  kept: number; // delivered − soldBack
  sellBackRatePct: number; // soldBack / delivered × 100 (0 when none)
}

// PGlite may hand back a SUM(numeric)::text / TEXT amount as a string OR a number; take the leading integer
// part (amounts are whole micro-USDC) and fall back to 0 for null/empty/unparseable.
const intStr = (v: string | number | null | undefined): bigint => {
  if (v == null) return 0n;
  const m = String(v).trim().match(/^-?\d+/);
  return m ? BigInt(m[0]) : 0n;
};

export async function gachaMonitoring(db: Db): Promise<GachaMonitoring> {
  // All five reads are independent → run them together.
  const [fee, rebate, budget, inv, turbo] = await Promise.all([
    // FEE_REVENUE credited per gacha reason (join to the unique system account to isolate the fee leg).
    db.query<{ reason: string; total: string }>(
      `SELECT le.reason, COALESCE(SUM(le.amount_uusdc::numeric), 0)::text AS total
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id IS NULL AND a.type = 'FEE_REVENUE'
          AND le.reason IN ('GACHA_SELLBACK', 'GACHA_TURBO_SELL', 'GACHA_PACK_BUY')
        GROUP BY le.reason`,
    ),
    // Rebate cost = USDC drawn from the rewards budget to fund token-bought packs (the budget legs are negative).
    db.query<{ total: string }>(
      `SELECT COALESCE(SUM(-le.amount_uusdc::numeric), 0)::text AS total
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id IS NULL AND a.type = 'GACHA_REWARDS_BUDGET' AND le.reason = 'PACK_BUY_TOKENS_FUND'`,
    ),
    db.query<{ amount_uusdc: string }>(
      `SELECT b.amount_uusdc FROM balances b JOIN accounts a ON a.id = b.account_id
        WHERE a.user_id IS NULL AND a.type = 'GACHA_REWARDS_BUDGET'`,
    ),
    // Sell-back rate: of every delivered card (inventory rows + turbo auto-sells), the fraction sold back.
    db.query<{ status: string; n: string }>(`SELECT status, COUNT(*)::text AS n FROM gacha_nft_inventory GROUP BY status`),
    db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM gacha_pack_opens WHERE status = 'turbo_sold'`),
  ]);

  let sellBackCut = 0n;
  let markup = 0n;
  for (const r of fee.rows) {
    if (r.reason === 'GACHA_PACK_BUY') markup += intStr(r.total);
    else sellBackCut += intStr(r.total);
  }
  const rebateCost = intStr(rebate.rows[0]?.total);
  const rewardsBudget = intStr(budget.rows[0]?.amount_uusdc);
  const totalInv = inv.rows.reduce((a, r) => a + Number(r.n), 0);
  const sold = Number(inv.rows.find((r) => r.status === 'sold')?.n ?? 0);
  const turboSold = Number(turbo.rows[0]?.n ?? 0);
  const delivered = totalInv + turboSold;
  const soldBack = sold + turboSold;

  const revenue = sellBackCut + markup;
  return {
    sellBackCutE6: sellBackCut.toString(),
    markupE6: markup.toString(),
    revenueE6: revenue.toString(),
    rebateCostE6: rebateCost.toString(),
    netE6: (revenue - rebateCost).toString(),
    rewardsBudgetE6: rewardsBudget.toString(),
    deliveredCards: delivered,
    soldBack,
    kept: delivered - soldBack,
    sellBackRatePct: delivered > 0 ? Math.round((soldBack / delivered) * 1000) / 10 : 0,
  };
}
