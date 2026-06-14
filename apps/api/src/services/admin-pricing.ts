import { advisoryXactLock, type Db } from '../db/client.ts';
import { HttpError } from '../errors.ts';
import { getMarketById } from './markets.ts';
import { refreshMark } from './engine.ts';
import { applyConfidence } from './oracle.ts';

/**
 * Operator manual price override (see ROADMAP §2). The automated oracle only covers pokemontcg.io
 * (Pokémon, ~daily). For sources without an API (eBay sold listings, other marketplaces), an
 * operator sets the price by hand. A manual price is recorded as an accepted oracle print and the
 * mark is recomputed exactly like a trade (refreshMark), so it flows into mark/liquidation/staleness.
 * Setting a price PINS the market by default so the 6h auto-ingest won't overwrite it until unpinned.
 */

// Fat-finger guard: reject a price more than this factor away from the last accepted price unless
// the operator explicitly forces it.
const MAX_MANUAL_FACTOR = 10n;

export interface ManualPriceOpts {
  pin?: boolean; // default true — pin so auto-ingest doesn't overwrite
  force?: boolean; // bypass the fat-finger guard
  note?: string; // free-text audit note (source/why)
  operator?: string; // audit: which operator key/label set it
}

export async function setManualPrice(
  db: Db,
  marketId: string,
  priceE6: bigint,
  opts: ManualPriceOpts = {},
): Promise<{ markE6: string; indexE6: string; pinned: boolean }> {
  if (priceE6 <= 0n) throw new HttpError(400, 'price must be positive');
  return db.tx(async (q) => {
    await advisoryXactLock(q, marketId); // serialize with trades/funding/liquidations on this market
    const market = await getMarketById(q, marketId);
    if (!market) throw new HttpError(404, 'market not found');
    if (market.status === 'delisted') throw new HttpError(400, 'market is delisted');

    if (!opts.force) {
      const last = await q.query<{ v: string }>(
        `SELECT index_price_e6::text AS v FROM oracle_prices WHERE market_id=$1 AND is_accepted
         ORDER BY source_observed_at DESC LIMIT 1`,
        [marketId],
      );
      const prev = last.rows[0] ? BigInt(last.rows[0].v) : 0n;
      if (prev > 0n && (priceE6 > prev * MAX_MANUAL_FACTOR || priceE6 * MAX_MANUAL_FACTOR < prev)) {
        throw new HttpError(400, `price is more than ${MAX_MANUAL_FACTOR}x from the last price (${prev} uUSD); pass force to override`);
      }
    }

    const observedAt = new Date();
    const payload = { source: 'manual', operator: opts.operator ?? null, note: opts.note ?? null, at: observedAt.toISOString() };
    await q.query(
      `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, is_accepted, reject_reason)
       VALUES($1, $2, $3, $4, true, NULL)
       ON CONFLICT(market_id, source_observed_at) DO NOTHING`,
      [marketId, priceE6.toString(), JSON.stringify(payload), observedAt.toISOString()],
    );

    const pinned = opts.pin !== false; // pin by default
    await q.query(`UPDATE markets SET price_pinned=$2 WHERE id=$1`, [marketId, pinned]);
    // A manual price is an operator-trusted price: clear the confidence gate so the market is tradeable
    // again (the auto-oracle's thin/disagreeing-signal restriction no longer applies to a pinned price).
    await applyConfidence(q, marketId, true, 'manual price set by operator');

    // recompute mark from current skew + depth, like a trade; refreshMark returns the new mark
    const markE6 = await refreshMark(q, market, priceE6);
    return { markE6: markE6.toString(), indexE6: priceE6.toString(), pinned };
  });
}

/** Pin/unpin a market's price. Unpinning lets the automated oracle resume overwriting it. */
export async function setPricePin(db: Db, marketId: string, pinned: boolean): Promise<void> {
  const market = await getMarketById(db, marketId);
  if (!market) throw new HttpError(404, 'market not found');
  await db.query(`UPDATE markets SET price_pinned=$2 WHERE id=$1`, [marketId, pinned]);
}
