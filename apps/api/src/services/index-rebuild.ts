/**
 * Index HISTORY rebuild (2026-10 index audit). Replays every past oracle pass through the CURRENT index
 * methodology — the same buildBaskets (index-baskets.ts) and chainStep (index-weighting.ts) the live ingest uses —
 * from the card prints already in the DB, so the whole published history of every index is computed one
 * consistent, correct way (singles-only card tiers, fresh-price eligibility, leavers counted, Jevons G&P, Dutot
 * GJ, the outlier guard).
 *
 * plan (read-only) → apply (writes, reversible via history-repair.ts). Run both inside withIngestLease. Apply backs
 * up every changed value, rewrites the index prints, rescales the index marks (mark × new/old index — a mark's
 * premium over its index is preserved), inserts a point on a UTC day that had NO pass at all (only when fresh card
 * data exists for it, i.e. after the gap backfill), and leaves the final basket as the snapshot the next live pass
 * chains off.
 *
 * Known approximations (the history needed for exactness was never stored): eligibility uses each card's CURRENT
 * `featured` flag and stored product type (no history of either), and only freshness — not the market's status at
 * the time (live also drops halted/delisted markets); a pass's prices are each card's latest accepted print as of
 * that pass. PSA-10 values come from each print's stored `gradedE6`, or — for prints that predate it — a replay of
 * the live choice from the provider fields (Scrydex ladder PSA 10, else tcgpl's eBay PSA-10; JustTCG can't be
 * replayed).
 */
import { fromE6, toE6 } from '@pokex/pricing';
import { DEFAULT_CAP_BPS } from '@pokex/shared-types';
import type { Db, Queryer } from '../db/client.ts';
import { chainStep, weightingOf, BASE_VALUE_E6, type ConstituentPrice, type IndexWeighting } from './index-weighting.ts';
import { buildBaskets, type BasketCard } from './index-baskets.ts';
import { productTypeOfMarket, type ProductType } from './product-type.ts';
import { indexSymbol, upsertIndexMarket } from './markets.ts';
import { writeIndexSnapshot } from './oracle.ts';
import { insertHistoricalPoints, newRepairRunId } from './history-repair.ts';
import { scrydexPsa10E6 } from './providers/scrydex.ts';
import { ebayAvgUsd, type GradeRow } from './providers/tcgpricelookup.ts';

export interface RebuildOptions {
  freshMs: number;
  outlierFactor: number;
  gradedConstituents: number;
  sealedMin: number;
  sealedEnabled: boolean;
  gapFill: boolean; // add a point on a UTC day that had no pass (when fresh card data exists for it)
  excludePrintIds?: Set<string>; // treat these card prints as rejected (a dry run of the bad-print cleanup)
}

export interface RebuildPoint {
  oraclePriceId: string | null; // the existing print this rewrites; null = a new point
  t: Date;
  cutoff: Date; // what the pass knew (its earliest index ingest); a new point is stamped with it, so re-runs agree
  synthetic: boolean; // a gap-day point (no real pass ran) — flagged so it never counts as a pass
  old: bigint | null;
  value: bigint;
  members: number;
  outliers: number;
}

export interface RebuildSeries {
  marketId: string | null; // null = the index market doesn't exist yet (e.g. a new per-game Sealed series)
  symbol: string;
  game: string;
  slug: string;
  name: string;
  weighting: IndexWeighting;
  gated: boolean;
  points: RebuildPoint[];
  finalBasket: ConstituentPrice[];
}

const DAY_MS = 86_400_000;
const utcDay = (t: Date) => t.toISOString().slice(0, 10);

/** UTC days from the first to the last of `days` that are NOT in it. */
function daysWithout(days: Set<string>): string[] {
  const sorted = [...days].sort();
  const out: string[] = [];
  if (!sorted.length) return out;
  for (let t = Date.parse(`${sorted[0]}T00:00:00Z`); t <= Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`); t += DAY_MS) {
    const d = utcDay(new Date(t));
    if (!days.has(d)) out.push(d);
  }
  return out;
}

interface PassSchedule {
  passes: { t: Date; cutoff: Date }[]; // real passes only, oldest first
  rowAt: Map<string, { id: string; v: bigint }>; // `${marketId}|${t}` → existing print (real or synthetic)
  firstT: Map<string, number>; // marketId → its first real print (series lifetime start)
}

/** The real oracle passes (all indices of a pass share its timestamp), read from the index prints. A rebuild's
 *  synthetic gap-day points never count as a pass; an operator's manual print (admin-pricing) is not a pass and
 *  is never rewritten; a pinned index (which live never prints over) is left out entirely. */
async function loadPassSchedule(q: Queryer): Promise<PassSchedule> {
  const rows = (
    await q.query<{ id: string; market_id: string; t: Date; ing: Date; v: string; synthetic: boolean }>(
      `SELECT o.id::text AS id, o.market_id, o.source_observed_at AS t, o.ingested_at AS ing, o.index_price_e6::text AS v,
              COALESCE((o.raw_payload->>'synthetic')::boolean, false) AS synthetic
         FROM oracle_prices o JOIN markets m ON m.id = o.market_id
        WHERE m.kind = 'index' AND o.is_accepted AND NOT m.price_pinned
          AND COALESCE(o.raw_payload->>'source', '') <> 'manual'
        ORDER BY o.source_observed_at`,
    )
  ).rows;
  const passes = new Map<number, { t: Date; cutoff: Date }>();
  const rowAt = new Map<string, { id: string; v: bigint }>();
  const firstT = new Map<string, number>();
  for (const r of rows) {
    const k = r.t.getTime();
    rowAt.set(`${r.market_id}|${k}`, { id: r.id, v: BigInt(r.v) });
    if (r.synthetic) continue;
    const cur = passes.get(k);
    // card prints of a pass land BEFORE its index prints → the earliest index ingest bounds what the pass knew
    if (!cur || r.ing < cur.cutoff) passes.set(k, { t: r.t, cutoff: r.ing });
    if (!firstT.has(r.market_id)) firstT.set(r.market_id, k);
  }
  return { passes: [...passes.values()].sort((a, b) => a.t.getTime() - b.t.getTime()), rowAt, firstT };
}

/** UTC days, between the first and last oracle pass, on which NO pass ran — the gap days the provider-history
 *  backfill fills and the rebuild then gives a point. */
export async function missingPassDays(q: Queryer): Promise<string[]> {
  return daysWithout(new Set((await loadPassSchedule(q)).passes.map((p) => utcDay(p.t))));
}

/** A print's PSA-10: the stored provider-neutral `gradedE6`, else a replay of the live choice (older prints). */
function gradedOf(stored: string | null, sxLadder: unknown, tplPsa10: unknown): bigint | null {
  if (stored != null) return BigInt(stored);
  if (Array.isArray(sxLadder)) {
    const v = scrydexPsa10E6(sxLadder as GradeRow[]);
    if (v != null && v > 0n) return v;
  }
  const ebay = tplPsa10 && typeof tplPsa10 === 'object' ? (tplPsa10 as { ebay?: Parameters<typeof ebayAvgUsd>[0] }).ebay : undefined;
  const usd = ebayAvgUsd(ebay);
  return usd != null && usd > 0 ? toE6(usd) : null;
}

interface CompactPrint {
  id: bigint;
  marketId: string;
  ing: Date;
  price: bigint;
  graded: bigint | null;
}

/** Every accepted print of these markets, oldest first, reduced to scalars (chunked by market: ~150k prints). */
async function loadCompactPrints(q: Queryer, marketIds: string[], exclude: Set<string>): Promise<CompactPrint[]> {
  const out: CompactPrint[] = [];
  for (let i = 0; i < marketIds.length; i += 200) {
    const rows = (
      await q.query<{ id: string; market_id: string; ing: Date; v: string; g: string | null; sx: unknown; tp: unknown }>(
        `SELECT o.id::text AS id, o.market_id, o.ingested_at AS ing, o.index_price_e6::text AS v, o.raw_payload->>'gradedE6' AS g,
                o.raw_payload->'scrydex'->'graded' AS sx, o.raw_payload->'tcgpricelookup'->'prices'->'graded'->'psa'->'10' AS tp
           FROM oracle_prices o WHERE o.market_id = ANY($1) AND o.is_accepted`,
        [marketIds.slice(i, i + 200)],
      )
    ).rows;
    for (const r of rows) {
      if (exclude.has(r.id)) continue;
      out.push({ id: BigInt(r.id), marketId: r.market_id, ing: r.ing, price: BigInt(r.v), graded: gradedOf(r.g, r.sx, r.tp) });
    }
  }
  return out.sort((a, b) => a.ing.getTime() - b.ing.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Read-only: the rebuilt series for every index (existing + catalog series that would exist). */
export async function planIndexRebuild(q: Queryer, o: RebuildOptions): Promise<RebuildSeries[]> {
  const sched = await loadPassSchedule(q);
  const schedule = sched.passes.map((p) => ({ ...p, synthetic: false }));
  if (o.gapFill) {
    for (const day of daysWithout(new Set(schedule.map((p) => utcDay(p.t))))) {
      const t = new Date(`${day}T12:00:00.000Z`); // one point mid-day on a day with no pass at all
      schedule.push({ t, cutoff: t, synthetic: true });
    }
    schedule.sort((a, b) => a.t.getTime() - b.t.getTime());
  }

  const idxMarkets = (await q.query<{ id: string; symbol: string; price_pinned: boolean }>(`SELECT id, symbol, price_pinned FROM markets WHERE kind = 'index'`)).rows;
  const marketIdBySymbol = new Map(idxMarkets.map((m) => [m.symbol, m.id]));
  const pinned = new Set(idxMarkets.filter((m) => m.price_pinned).map((m) => m.symbol)); // operator-priced: never rebuilt
  const cards = (
    await q.query<{ id: string; game: string; card_id: string; display_name: string; rarity: string | null; product_type: string | null }>(
      `SELECT id, game, card_id, display_name, metadata->>'rarity' AS rarity, product_type
         FROM markets WHERE kind = 'card' AND featured AND card_id IS NOT NULL`,
    )
  ).rows;
  const cardById = new Map(
    cards.map((c) => [c.id, { game: c.game, cardId: c.card_id, productType: (c.product_type as ProductType | null) ?? productTypeOfMarket(c.display_name, c.rarity) }]),
  );
  const prints = await loadCompactPrints(q, [...cardById.keys()], o.excludePrintIds ?? new Set());

  type State = RebuildSeries & { level: bigint; snap: Map<string, bigint> };
  const series = new Map<string, State>();
  const last = new Map<string, { price: bigint; ing: Date; graded: bigint | null }>();
  let pi = 0;
  for (const pass of schedule) {
    while (pi < prints.length && prints[pi].ing <= pass.cutoff) {
      const p = prints[pi++];
      last.set(p.marketId, { price: p.price, ing: p.ing, graded: p.graded });
    }
    // Every card's last-known price goes in (leavers are measured); only fresh ones (the live INDEX_FRESH_MS rule)
    // may be members.
    const cards: BasketCard[] = [];
    for (const [mid, l] of last) {
      const c = cardById.get(mid)!;
      cards.push({ game: c.game, cardId: c.cardId, priceE6: l.price, gradedE6: l.graded, productType: c.productType, eligible: pass.cutoff.getTime() - l.ing.getTime() < o.freshMs });
    }
    const k = pass.t.getTime();
    for (const { idx, members, cur } of buildBaskets(cards, o)) {
      const symbol = indexSymbol(idx.game, idx.slug);
      if (pinned.has(symbol)) continue;
      let s = series.get(symbol);
      if (!s) {
        s = {
          marketId: marketIdBySymbol.get(symbol) ?? null, symbol, game: idx.game, slug: idx.slug, name: idx.name,
          weighting: weightingOf(idx), gated: idx.gated, points: [], finalBasket: [], level: 0n, snap: new Map(),
        };
        series.set(symbol, s);
      }
      const existing = s.marketId ? sched.rowAt.get(`${s.marketId}|${k}`) : undefined;
      const start = s.marketId ? sched.firstT.get(s.marketId) : undefined;
      // Lifetime: an existing series starts at its first print; a not-yet-listed one at its first members.
      if (start != null ? k < start : s.level === 0n && members.length === 0) continue;
      if (members.length === 0) {
        if (pass.synthetic || !existing) continue; // nothing to measure and nothing to rewrite
        s.points.push({ oraclePriceId: existing.id, t: pass.t, cutoff: pass.cutoff, synthetic: false, old: existing.v, value: s.level > 0n ? s.level : BASE_VALUE_E6, members: 0, outliers: 0 });
        continue;
      }
      const step = chainStep(s.level, s.snap, cur, s.weighting, { outlierFactor: o.outlierFactor, capBps: idx.capBps ?? DEFAULT_CAP_BPS });
      s.level = step.levelE6;
      s.snap = new Map(members.map((m) => [m.cardId, m.priceE6]));
      s.finalBasket = members;
      s.points.push({
        oraclePriceId: existing?.id ?? null, t: pass.t, cutoff: pass.cutoff, synthetic: pass.synthetic, old: existing?.v ?? null,
        value: step.levelE6, members: members.length, outliers: step.outliers.length,
      });
    }
  }
  return [...series.values()].filter((s) => s.points.length > 0).map(({ level: _l, snap: _s, ...r }) => r);
}

export interface ApplyReport {
  runId: string;
  series: number;
  printsUpdated: number;
  pointsInserted: number; // each a print + its mark
  marksRescaled: number;
  marketsCreated: number;
}

/** Open positions on the index markets a plan would change. Rewriting an index rescales its LATEST mark — the live
 *  price the engine marks PnL, liquidations and resting orders off — so these must be reviewed before apply. */
export async function openIndexPositions(q: Queryer, plan: RebuildSeries[]) {
  const ids = plan.map((s) => s.marketId).filter((id): id is string => id != null);
  if (!ids.length) return [];
  return (
    await q.query<{ id: string; symbol: string; side: string; qty_e6: string; opened_at: Date }>(
      `SELECT p.id, m.symbol, p.side, p.qty_e6::text, p.opened_at FROM positions p JOIN markets m ON m.id = p.market_id
        WHERE p.market_id = ANY($1) AND p.status = 'open' ORDER BY m.symbol`,
      [ids],
    )
  ).rows;
}

/** Write a plan — inside withIngestLease, planned in the same lease. Refuses while any affected index has an open
 *  position (its live mark would jump) unless `allowOpenPositions`. Reversible by run id (history-repair.ts). */
export async function applyIndexRebuild(
  db: Db,
  plan: RebuildSeries[],
  log: (m: string) => void = () => {},
  opts: { allowOpenPositions?: boolean } = {},
): Promise<ApplyReport> {
  const open = await openIndexPositions(db, plan);
  if (open.length && !opts.allowOpenPositions) {
    throw new Error(
      `refusing to rebuild: ${open.length} open position(s) on affected indices (${[...new Set(open.map((p) => p.symbol))].join(', ')}) ` +
        `— their live mark would jump to the rebuilt level. Review them, then re-run with allowOpenPositions.`,
    );
  }
  const runId = newRepairRunId('rebuild');
  log(`run id: ${runId} (revert with: npx tsx scripts/revert-history-repair.ts ${runId})`);
  const rep: ApplyReport = { runId, series: 0, printsUpdated: 0, pointsInserted: 0, marksRescaled: 0, marketsCreated: 0 };
  for (const s of plan) {
    await db.tx(async (q) => {
      let marketId = s.marketId;
      if (!marketId) {
        marketId = await upsertIndexMarket(q, { game: s.game, slug: s.slug, name: s.name, tradeable: s.gated ? 'keep' : false });
        rep.marketsCreated++;
      }
      // 1. Rewrite existing prints (the backup copies each row's CURRENT value + payload, so revert is exact).
      const upd = s.points.filter((p) => p.oraclePriceId);
      if (upd.length) {
        const ids = upd.map((p) => p.oraclePriceId!);
        await q.query(
          `INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, old_index_e6, old_payload, inserted)
           SELECT $1, 'oracle_prices', o.id::text, o.market_id, o.index_price_e6, o.raw_payload, false FROM oracle_prices o
            WHERE o.id = ANY($2::bigint[]) ON CONFLICT DO NOTHING`,
          [runId, ids],
        );
        await q.query(
          `UPDATE oracle_prices o SET index_price_e6 = u.v,
                  raw_payload = COALESCE(o.raw_payload, '{}'::jsonb) || jsonb_build_object('rebuilt', $3::text, 'method', $4::text)
             FROM unnest($1::bigint[], $2::bigint[]) AS u(id, v) WHERE o.id = u.id`,
          [ids, upd.map((p) => p.value.toString()), runId, s.weighting],
        );
        rep.printsUpdated += upd.length;
      }
      // 2. Rescale the existing marks to the rebuilt index in force at their time — before any new point is
      //    inserted. A pass's level takes effect at its cutoff (when its index print landed), not at its start.
      const pts = [...s.points].sort((a, b) => a.cutoff.getTime() - b.cutoff.getTime());
      const marks = (
        await q.query<{ id: string; at: Date; mark: string; idx: string }>(
          `SELECT id::text AS id, computed_at AS at, mark_price_e6::text AS mark, index_price_e6::text AS idx
             FROM marks WHERE market_id = $1 ORDER BY computed_at`,
          [marketId],
        )
      ).rows;
      const mIds: string[] = [];
      const mMark: string[] = [];
      const mIdx: string[] = [];
      let j = -1;
      for (const m of marks) {
        while (j + 1 < pts.length && pts[j + 1].cutoff <= m.at) j++;
        if (j < 0) continue; // a mark before the series' first point — leave it
        const nv = pts[j].value;
        const oldIdx = BigInt(m.idx);
        mIds.push(m.id);
        mMark.push((oldIdx > 0n ? (BigInt(m.mark) * nv) / oldIdx : nv).toString());
        mIdx.push(nv.toString());
      }
      if (mIds.length) {
        await q.query(
          `INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, old_index_e6, old_mark_e6, inserted)
           SELECT $1, 'marks', k.id::text, k.market_id, k.index_price_e6, k.mark_price_e6, false FROM marks k
            WHERE k.id = ANY($2::bigint[]) ON CONFLICT DO NOTHING`,
          [runId, mIds],
        );
        await q.query(
          `UPDATE marks k SET mark_price_e6 = u.m, index_price_e6 = u.i
             FROM unnest($1::bigint[], $2::bigint[], $3::bigint[]) AS u(id, m, i) WHERE k.id = u.id`,
          [mIds, mMark, mIdx],
        );
        rep.marksRescaled += mIds.length;
      }
      // 3. New points (gap days / passes the old method skipped): a print + a mark each.
      rep.pointsInserted += await insertHistoricalPoints(
        q,
        runId,
        s.points
          .filter((p) => !p.oraclePriceId)
          .map((p) => ({
            marketId: marketId!, valueE6: p.value, at: p.t, ingestedAt: p.cutoff,
            payload: { kind: 'index', rebuilt: runId, method: s.weighting, constituents: p.members, synthetic: p.synthetic },
          })),
      );
      // 4. The next live pass chains off this basket + the last rebuilt level (the old snapshot is backed up).
      if (s.finalBasket.length) {
        await q.query(
          `INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, old_payload, inserted)
           SELECT $1, 'index_constituents', $2, $2,
                  COALESCE((SELECT jsonb_agg(jsonb_build_object('card_id', card_id, 'weight_e6', weight_e6::text)) FROM index_constituents WHERE market_id = $2), '[]'::jsonb),
                  false
           ON CONFLICT DO NOTHING`,
          [runId, marketId],
        );
        await writeIndexSnapshot(q, marketId, s.finalBasket);
      }
    });
    rep.series++;
    log(`  ✓ ${s.symbol}: ${s.points.length} points`);
  }
  return rep;
}

/** Per-series before/after summary for the dry-run report. */
export function summarizeRebuild(plan: RebuildSeries[]) {
  const maxDrawdown = (vals: number[]) => {
    let peak = -Infinity;
    let m = 0;
    for (const v of vals) {
      peak = Math.max(peak, v);
      m = Math.min(m, v / peak - 1);
    }
    return m;
  };
  return plan.map((s) => {
    const nv = s.points.map((p) => fromE6(p.value));
    const ov = s.points.filter((p) => p.old != null).map((p) => fromE6(p.old!));
    return {
      symbol: s.symbol,
      method: s.weighting,
      exists: s.marketId != null,
      points: s.points.length,
      newPoints: s.points.filter((p) => !p.oraclePriceId).length,
      from: utcDay(s.points[0].t),
      oldLast: ov.length ? ov[ov.length - 1] : null,
      newLast: nv[nv.length - 1],
      oldMaxDrawdownPct: ov.length ? +(maxDrawdown(ov) * 100).toFixed(1) : null,
      newMaxDrawdownPct: +(maxDrawdown(nv) * 100).toFixed(1),
      outliersExcluded: s.points.reduce((a, p) => a + p.outliers, 0),
      basketNow: s.finalBasket.length,
    };
  });
}
