import type { Db } from '../../db/client.ts';
import { toE6 } from '@pokex/pricing';
import { ProviderBudgetError } from './limiter.ts';
import {
  rawPriceUsd,
  type TcgPriceLookupClient,
  type TplCard,
  type TplHistoryPoint,
  type TplHistoryRow,
} from './tcgpricelookup.ts';

/**
 * Chart seeding (post-cutover): one-time backfill of a market's chart from the provider's daily
 * price history, so a freshly listed market doesn't start with an empty chart. Seeded points land
 * in `chart_seed` — NEVER in marks/oracle_prices — because they are the card market's prior prices,
 * not prices anyone could have traded at on this venue (see the schema comment). getCandles only
 * surfaces seed days that precede the market's first real mark.
 */

const HISTORY_PERIOD = '1y'; // the longest Trader-tier window — match the chart's 1Y timeframe

/** Reassemble one day's history rows into the TplCard prices envelope, so the day is priced by the
 *  SAME rawPriceUsd chain as the live feed (one definition of "the raw price", never two). */
function rawShape(rows: TplHistoryRow[]): NonNullable<TplCard['prices']>['raw'] {
  const raw: NonNullable<NonNullable<TplCard['prices']>['raw']> = {};
  for (const r of rows) {
    if (!r.condition || r.grader) continue; // graded rows never feed the raw series
    const slot = (raw[r.condition] ??= {});
    if (r.source === 'tcgplayer') slot.tcgplayer = { market: r.price_market ?? undefined };
    else if (r.source === 'ebay') slot.ebay = { avg_7d: r.avg_7d ?? undefined };
  }
  return raw;
}

/** Daily raw-price points from a history response. Sparse input stays sparse output (no fill). */
export function dailySeedPoints(points: TplHistoryPoint[]): { day: string; priceUsd: number }[] {
  const out: { day: string; priceUsd: number }[] = [];
  for (const p of points) {
    // The shape check alone admits '2026-13-01', which would only blow up later inside the INSERT's
    // ::date cast — and that failure would be retried (with a paid fetch) every sweep.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '') || Number.isNaN(Date.parse(p.date))) continue;
    const price = rawPriceUsd({ prices: { raw: rawShape(p.prices ?? []) } });
    if (price > 0) out.push({ day: p.date, priceUsd: price });
  }
  return out;
}

/** Fetch + store one market's seed series — a single statement per market (prod Postgres is remote;
 *  row-by-row inserts would round-trip ~365×). ON CONFLICT guards a concurrent seeder (ops script vs
 *  the server loop). A market whose provider history is empty would be retried every sweep by the
 *  NOT EXISTS filter — pin a 0-price sentinel on today instead; getCandles drops non-positive rows. */
export async function seedMarketHistory(
  db: Db,
  client: TcgPriceLookupClient,
  market: { id: string; providerCardId: string },
): Promise<number> {
  const history = await client.getCardHistory(market.providerCardId, HISTORY_PERIOD, 'discovery');
  const points = dailySeedPoints(history);
  if (points.length === 0) {
    await db.query(
      `INSERT INTO chart_seed(market_id, day, price_e6) VALUES($1, CURRENT_DATE, 0)
       ON CONFLICT(market_id, day) DO NOTHING`,
      [market.id],
    );
    return 0;
  }
  await db.query(
    `INSERT INTO chart_seed(market_id, day, price_e6)
     SELECT $1, u.d::date, u.p::bigint FROM unnest($2::text[], $3::text[]) AS u(d, p)
     ON CONFLICT(market_id, day) DO NOTHING`,
    [market.id, points.map((p) => p.day), points.map((p) => toE6(p.priceUsd).toString())],
  );
  return points.length;
}

// Tracked card markets that have no seed series yet (the shared eligibility for count + sweep).
const UNSEEDED = `FROM markets m
  WHERE m.kind = 'card' AND m.provider_card_id IS NOT NULL AND m.status != 'delisted'
    AND NOT EXISTS (SELECT 1 FROM chart_seed s WHERE s.market_id = m.id)`;

/** How many tracked markets still need a seed — the cheap probe the hourly loop + dry run share. */
export async function countMissingHistory(db: Db): Promise<number> {
  const r = await db.query<{ n: string }>(`SELECT count(*)::text AS n ${UNSEEDED}`);
  return Number(r.rows[0].n);
}

export interface SeedReport {
  markets: number; // markets that needed seeding
  seeded: number; // markets successfully seeded (may have 0 points if the provider has no history)
  points: number; // total points written
  failed: number;
}

/** Seed every tracked card market that has no seed series yet (one history request per market).
 *  Naturally resumable: a re-run only touches the still-unseeded remainder. */
export async function seedMissingHistory(
  db: Db,
  client: TcgPriceLookupClient,
  opts: { log?: (msg: string) => void } = {},
): Promise<SeedReport> {
  const log = opts.log ?? (() => {});
  const rows = await db.query<{ id: string; provider_card_id: string; display_name: string }>(
    `SELECT m.id, m.provider_card_id, m.display_name ${UNSEEDED} ORDER BY m.display_name`,
  );
  const report: SeedReport = { markets: rows.rows.length, seeded: 0, points: 0, failed: 0 };
  for (const m of rows.rows) {
    try {
      const n = await seedMarketHistory(db, client, { id: m.id, providerCardId: m.provider_card_id });
      report.seeded++;
      report.points += n;
      log(`✓ ${m.display_name} — ${n} points`);
    } catch (e) {
      if (e instanceof ProviderBudgetError) {
        // The daily tier is spent — every remaining market would fail the same way, each burning a
        // provider_rate row lock. Stop now; the next sweep (post-reset) picks up the remainder.
        report.failed += rows.rows.length - report.seeded - report.failed;
        log(`✗ budget exhausted — ${report.failed} markets deferred to the next sweep`);
        break;
      }
      report.failed++;
      log(`✗ ${m.display_name} — ${(e as Error).message}`);
    }
  }
  return report;
}
