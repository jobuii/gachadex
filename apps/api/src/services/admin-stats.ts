import { notional } from '@pokex/pricing';
import type { Db } from '../db/client.ts';
import { openPositionPnls, poolLiabilityOf } from './engine.ts';

/**
 * Operator analytics (admin dashboard, main view): per-asset trading stats + the platform's net
 * payout exposure. All figures are USER-signed: a POSITIVE net P/L means players are up (the platform
 * owes / is exposed); negative means players are down (the platform is set to collect).
 *
 * Two net numbers, because isolated margin caps a loser's loss at their posted margin:
 *   - netCapped: winners' full profit minus losers' loss DOWN TO their margin — what the pool would
 *     actually net at settlement (the real exposure). This is the primary figure.
 *   - netRaw: straight mark-to-market (winners' profit minus losers' FULL paper loss). Secondary.
 */
export interface MarketStat {
  marketId: string;
  volume24hE6: string; // traded notional (uUSDC) in the last 24h
  lockedE6: string; // margin locked in open positions on this asset
  netCappedE6: string; // capped net player P/L (collectable at settlement)
  netRawE6: string; // raw mark-to-market net player P/L
  longNotionalE6: string; // Σ entry notional, long side
  shortNotionalE6: string; // Σ entry notional, short side
}

export interface MarketStatsReport {
  markets: MarketStat[];
  totals: { netCappedE6: string; netRawE6: string };
}

export async function marketStats(db: Db): Promise<MarketStatsReport> {
  const pnls = await openPositionPnls(db); // one scan: every open position marked to its latest mark

  // 24h traded notional per market (uUSDC): qty/price are 1e6 fixed-point, so notional = Σ(qty·price)/1e6.
  const vol = await db.query<{ market_id: string; usd_e6: string }>(
    `SELECT market_id, FLOOR(SUM(qty_e6::numeric * exec_price_e6::numeric) / 1000000)::text AS usd_e6
       FROM fills WHERE created_at > now() - interval '24 hours' GROUP BY market_id`,
  );
  const volByMarket = new Map(vol.rows.map((r) => [r.market_id, BigInt(r.usd_e6)]));

  type Agg = { locked: bigint; capped: bigint; raw: bigint; long: bigint; short: bigint };
  const fresh = (): Agg => ({ locked: 0n, capped: 0n, raw: 0n, long: 0n, short: 0n });
  const agg = new Map<string, Agg>();
  let totalCapped = 0n;
  let totalRaw = 0n;
  for (const p of pnls) {
    const a = agg.get(p.marketId) ?? fresh();
    a.locked += p.marginUusdc;
    a.capped += poolLiabilityOf(p);
    a.raw += p.pnlUusdc;
    const notion = notional(p.qtyE6, p.entryE6);
    if (p.side === 'long') a.long += notion;
    else a.short += notion;
    agg.set(p.marketId, a);
    totalCapped += poolLiabilityOf(p);
    totalRaw += p.pnlUusdc;
  }

  const markets: MarketStat[] = [];
  for (const id of new Set([...agg.keys(), ...volByMarket.keys()])) {
    const a = agg.get(id) ?? fresh();
    markets.push({
      marketId: id,
      volume24hE6: (volByMarket.get(id) ?? 0n).toString(),
      lockedE6: a.locked.toString(),
      netCappedE6: a.capped.toString(),
      netRawE6: a.raw.toString(),
      longNotionalE6: a.long.toString(),
      shortNotionalE6: a.short.toString(),
    });
  }
  return { markets, totals: { netCappedE6: totalCapped.toString(), netRawE6: totalRaw.toString() } };
}
