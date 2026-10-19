/**
 * Q-A4 (2026-10-18 plan): replay the index history twice on the same prices — under the OLD rule (every pass re-slices
 * the featured top-N) and under rules v3 (monthly change dates, the buffer, removal for a cause) — and compare member
 * turnover and levels, per buffer setting. Read-only on the source: everything runs on a scratch database.
 *
 *   copyForReplay   source → scratch: markets, the card prints of the given markets, the index prints (the pass
 *                   schedule), price-lake rows, confidence + PSA-10 history. (The caller then seeds featured history
 *                   and applies the wrong-printing repair, so both replays use corrected prices.)
 *   replayOld       the real history rebuild with no member lists; per-pass baskets → turnover, and the launch basket
 *   replayV3        steps the REAL membership engine (runIndexRules) through every past pass — featured and
 *                   low-confidence flags set as of that pass — then the same rebuild reads the member lists it wrote
 *   compareReplays  per series: levels at change dates and at the end, the largest gap, monthly turnover
 */
import type { Db, Queryer } from '../db/client.ts';
import { config } from '../config.ts';
import { planIndexRebuild, loadPassSchedule, gradedOf, type RebuildOptions, type RebuildSeries } from './index-rebuild.ts';
import { governedBaskets, runIndexRules } from './index-membership.ts';
import { writeIndexSnapshot } from './oracle.ts';
import type { ConstituentPrice } from './index-weighting.ts';

/** Copy `table` rows matching `where` from source to scratch, in batches, over the columns both sides have. */
async function copyRows(src: Queryer, dst: Db, table: string, where: string, params: unknown[]): Promise<number> {
  const dstCols = new Set(
    (await dst.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1`, [table])).rows.map((r) => r.c),
  );
  const rows = (await src.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${where}`, params)).rows;
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]).filter((c) => dstCols.has(c));
  const val = (v: unknown) => (v != null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v);
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const params2: unknown[] = [];
    const tuples = chunk.map((r) => `(${cols.map((c) => { params2.push(val(r[c])); return `$${params2.length}`; }).join(', ')})`);
    await dst.query(`INSERT INTO ${table}(${cols.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params2);
  }
  return rows.length;
}

export interface ReplayCopy { markets: number; cardPrints: number; indexPrints: number; restrictions: number; graded: number }

/** Source → scratch for the markets in `cardMarketIds` (every card that was ever featured) plus all index markets.
 *  Trigger rows the copy itself fires (featured/status "events" stamped now) are discarded. */
export async function copyForReplay(src: Queryer, dst: Db, cardMarketIds: string[]): Promise<ReplayCopy> {
  const out: ReplayCopy = { markets: 0, cardPrints: 0, indexPrints: 0, restrictions: 0, graded: 0 };
  out.markets = await copyRows(src, dst, 'markets', `kind = 'index' OR id = ANY($1)`, [cardMarketIds]);
  await dst.query(`DELETE FROM featured_events`);
  await dst.query(`DELETE FROM market_status_events`);
  out.cardPrints = await copyRows(src, dst, 'oracle_prices', `market_id = ANY($1)`, [cardMarketIds]);
  out.indexPrints = await copyRows(src, dst, 'oracle_prices', `market_id IN (SELECT id FROM markets WHERE kind = 'index')`, []);
  out.restrictions = await copyRows(src, dst, 'market_restriction_events', `market_id = ANY($1)`, [cardMarketIds]);
  out.graded = await copyRows(src, dst, 'graded_prints', `market_id = ANY($1)`, [cardMarketIds]);
  // rows came with their source ids: move each id sequence past them, so rows the replay adds don't collide
  for (const t of ['oracle_prices', 'market_restriction_events', 'graded_prints']) {
    await dst.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT max(id) FROM ${t}), 1))`);
  }
  return out;
}

/**
 * PSA-10 history (graded_prints) only began on 2026-10-17; before it, live passes used each print's own PSA-10. The
 * membership engine reads graded_prints as of a pass, so for a replay the scratch copy gets that earlier history written
 * in the same shape live writes it (a row per market when its PSA-10 changes), from each print — the value the history
 * rebuild uses for those passes (gradedOf). Run it after the repair, so corrected PSA-10s are used. Returns rows written.
 */
export async function backfillGradedHistory(db: Db): Promise<number> {
  const since = (await db.query<{ t: Date | null }>(`SELECT min(observed_at) AS t FROM graded_prints`)).rows[0]?.t ?? null;
  const markets = (await db.query<{ id: string }>(`SELECT id FROM markets WHERE kind = 'card' ORDER BY id`)).rows.map((r) => r.id);
  let written = 0;
  for (let i = 0; i < markets.length; i += 100) { // paged like the rebuild's print read — one big result is too much for PGlite
    const rows = (
      await db.query<{ market_id: string; ing: Date; g: string | null; sx: unknown; tp: unknown }>(
        `SELECT o.market_id, o.ingested_at AS ing, o.raw_payload->>'gradedE6' AS g, o.raw_payload->'scrydex'->'graded' AS sx,
                o.raw_payload->'tcgpricelookup'->'prices'->'graded'->'psa'->'10' AS tp
           FROM oracle_prices o
          WHERE o.market_id = ANY($1) AND o.is_accepted AND ($2::timestamptz IS NULL OR o.ingested_at < $2)
          ORDER BY o.market_id, o.ingested_at, o.id`,
        [markets.slice(i, i + 100), since],
      )
    ).rows;
    let prevMarket = '';
    let prev: bigint | null | undefined;
    for (const r of rows) {
      const g = gradedOf(r.g, r.sx, r.tp);
      if (r.market_id !== prevMarket) { prevMarket = r.market_id; prev = undefined; }
      if (prev !== undefined && prev === g) continue;
      prev = g;
      await db.query(`INSERT INTO graded_prints(market_id, graded_e6, observed_at) VALUES($1, $2, $3)`, [r.market_id, g?.toString() ?? null, r.ing]);
      written++;
    }
  }
  return written;
}

interface Turnover { months: Map<string, { adds: number; removes: number }>; prev: Map<string, Set<string>> }

/** Per-series monthly member turnover from the rebuild's per-pass baskets (a card entering or leaving the list). */
function turnoverRecorder() {
  const t: Turnover = { months: new Map(), prev: new Map() };
  const firstBasket = new Map<string, { at: Date; members: ConstituentPrice[] }>();
  const record = (symbol: string, at: Date, members: ConstituentPrice[]) => {
    if (!firstBasket.has(symbol) && members.length) firstBasket.set(symbol, { at, members });
    const cur = new Set(members.map((m) => m.cardId));
    const prev = t.prev.get(symbol);
    t.prev.set(symbol, cur);
    if (!prev) return;
    const key = `${symbol}|${at.toISOString().slice(0, 7)}`;
    const m = t.months.get(key) ?? { adds: 0, removes: 0 };
    for (const c of cur) if (!prev.has(c)) m.adds++;
    for (const c of prev) if (!cur.has(c)) m.removes++;
    t.months.set(key, m);
  };
  return { record, turnover: t, firstBasket };
}

export interface ReplayRun {
  series: RebuildSeries[];
  turnover: Map<string, { adds: number; removes: number }>; // `${symbol}|YYYY-MM`
  firstBasket: Map<string, { at: Date; members: ConstituentPrice[] }>;
}

/** The OLD rule over the scratch history: the real rebuild with no member lists. */
export async function replayOld(db: Db, opts: RebuildOptions): Promise<ReplayRun> {
  await db.query(`DELETE FROM index_members`);
  const rec = turnoverRecorder();
  const series = await planIndexRebuild(db, { ...opts, onBasket: rec.record });
  return { series, turnover: rec.turnover.months, firstBasket: rec.firstBasket };
}

/** A change date as APPLIED (index_members at applied_at — room limits, reserves and earlier leaves make it differ from
 *  the announcement), plus what was announced. */
export interface ChangeRow { basket: string; changeDate: string; appliedAt: string | null; announced: { adds: number; removes: number }; joined: number; left: Record<string, number> }

/**
 * Rules v3 over the scratch history: launch each governed basket from the OLD rule's basket at the first pass (R10),
 * then call the real runIndexRules at every pass with the market flags as of that pass, then rebuild with the member
 * lists it wrote. `stayPct` is the R4 buffer (110 = D2; 120 = the plan's wider option).
 */
export async function replayV3(db: Db, opts: RebuildOptions, old: ReplayRun, stayPct: number, log: (m: string) => void = () => {}): Promise<ReplayRun & { changes: ChangeRow[] }> {
  const cfg = config as { indexStayPct: number };
  const was = cfg.indexStayPct;
  cfg.indexStayPct = stayPct;
  try {
    for (const t of ['index_members', 'index_changes', 'index_exclusions']) await db.query(`DELETE FROM ${t}`);
    // the flags are set by hand below, as of each pass — the trigger would stamp them "now" into the history it reads
    await db.query(`ALTER TABLE markets DISABLE TRIGGER trg_market_flag_changes`);
    // R10: each basket launches from the old rule's basket at ITS first pass — a game whose cards were first priced
    // later must not launch (and lose every member as 'stale') before it has prices
    const idx = new Map((await db.query<{ id: string; symbol: string }>(`SELECT id, symbol FROM markets WHERE kind = 'index'`)).rows.map((r) => [r.symbol, r.id]));
    await db.query(`DELETE FROM index_constituents`);
    const toLaunch = governedBaskets().flatMap((b) => {
      const first = old.firstBasket.get(b.gjSymbol);
      const mid = idx.get(b.gjSymbol);
      return first && mid ? [{ mid, ...first }] : [];
    });
    const featured = (await db.query<{ market_id: string; at: Date; featured: boolean }>(`SELECT market_id, at, featured FROM featured_events ORDER BY at, id`)).rows;
    const restricted = (await db.query<{ market_id: string; at: Date; restricted: boolean }>(`SELECT market_id, at, restricted FROM market_restriction_events ORDER BY at, id`)).rows;
    // before a market's first event, its flag is the opposite of that event (an "on" event means it was off before)
    await db.query(`UPDATE markets m SET featured = NOT e.featured FROM (SELECT DISTINCT ON (market_id) market_id, featured FROM featured_events ORDER BY market_id, at, id) e WHERE m.id = e.market_id`);
    await db.query(`UPDATE markets m SET low_confidence = NOT e.restricted FROM (SELECT DISTINCT ON (market_id) market_id, restricted FROM market_restriction_events ORDER BY market_id, at, id) e WHERE m.id = e.market_id`);
    await db.query(`UPDATE markets SET status = 'active' WHERE kind = 'card' AND status <> 'active'`); // no status history: active throughout, as the rebuild assumes
    const passes = (await loadPassSchedule(db)).passes;
    let fi = 0;
    let ri = 0;
    for (const [i, pass] of passes.entries()) {
      for (; fi < featured.length && featured[fi].at <= pass.cutoff; fi++) await db.query(`UPDATE markets SET featured = $2 WHERE id = $1`, [featured[fi].market_id, featured[fi].featured]);
      for (; ri < restricted.length && restricted[ri].at <= pass.cutoff; ri++) await db.query(`UPDATE markets SET low_confidence = $2 WHERE id = $1`, [restricted[ri].market_id, restricted[ri].restricted]);
      // launch once its first basket's prices are visible at the rules' time (pass.t, before this pass's own prints)
      for (const l of toLaunch.filter((x) => x.at <= pass.t)) {
        await writeIndexSnapshot(db, l.mid, l.members);
        toLaunch.splice(toLaunch.indexOf(l), 1);
      }
      // live runs the rules at the pass's own time, before this pass's card prints — never one pass ahead
      await runIndexRules(db, pass.t);
      if (i % 50 === 0) log(`  …v3 ${stayPct}: pass ${i + 1}/${passes.length} (${pass.cutoff.toISOString().slice(0, 16)})`);
    }
    const rec = turnoverRecorder();
    const series = await planIndexRebuild(db, { ...opts, onBasket: rec.record });
    const changes: ChangeRow[] = [];
    for (const r of (
      await db.query<{ basket: string; change_date: string; applied_at: Date | null; adds: number; removes: number }>(
        `SELECT basket, change_date::text, applied_at, cardinality(adds) AS adds, jsonb_array_length(removes) AS removes
           FROM index_changes WHERE NOT cancelled ORDER BY basket, change_date`,
      )
    ).rows) {
      const at = r.applied_at;
      const joined = at ? (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM index_members WHERE basket = $1 AND joined_at = $2 AND join_reason <> 'launch'`, [r.basket, at])).rows[0].n : 0;
      const left = at
        ? Object.fromEntries((await db.query<{ reason: string; n: number }>(`SELECT leave_reason AS reason, count(*)::int AS n FROM index_members WHERE basket = $1 AND left_at = $2 GROUP BY 1`, [r.basket, at])).rows.map((x) => [x.reason, x.n]))
        : {};
      changes.push({ basket: r.basket, changeDate: r.change_date, appliedAt: at ? new Date(at).toISOString() : null, announced: { adds: r.adds, removes: r.removes }, joined, left });
    }
    return { series, turnover: rec.turnover.months, firstBasket: rec.firstBasket, changes };
  } finally {
    cfg.indexStayPct = was;
    await db.query(`ALTER TABLE markets ENABLE TRIGGER trg_market_flag_changes`);
  }
}

export interface SeriesComparison {
  symbol: string;
  points: number;
  outagePoints: number; // passes in the flagged outage window
  oldEnd: number;
  newEnd: number;
  endDiffPct: number;
  maxDiffPct: number; // the largest |new / old − 1| at any shared pass
  maxDiffAt: string;
  monthStarts: { at: string; old: number; new: number }[]; // the first shared pass of each month (before its change, which applies on/after the 4th)
  turnoverOld: number; // member changes (in + out) over the whole window
  turnoverNew: number;
}

const lvl = (e6: bigint) => Number(e6) / 1e6;

/** Per series, old vs v3: aligned on shared passes; `outage` = [from, to) flagged; change dates = the 1sts in range. */
export function compareReplays(old: ReplayRun, v3: ReplayRun, outage: [Date, Date]): SeriesComparison[] {
  const newBy = new Map(v3.series.map((s) => [s.symbol, s]));
  const sumTurnover = (t: Map<string, { adds: number; removes: number }>, symbol: string) =>
    [...t].filter(([k]) => k.startsWith(`${symbol}|`)).reduce((a, [, v]) => a + v.adds + v.removes, 0);
  const out: SeriesComparison[] = [];
  for (const o of old.series) {
    const n = newBy.get(o.symbol);
    if (!n || !o.points.length) continue;
    const nAt = new Map(n.points.map((p) => [p.t.getTime(), p.value]));
    let maxDiff = 0;
    let maxAt = '';
    let shared = 0;
    let outagePoints = 0;
    const firsts = new Map<string, { at: string; old: number; new: number }>();
    for (const p of o.points) {
      const nv = nAt.get(p.t.getTime());
      if (nv == null) continue;
      shared++;
      if (p.t >= outage[0] && p.t < outage[1]) outagePoints++;
      const d = Math.abs(lvl(nv) / lvl(p.value) - 1);
      if (d > maxDiff) { maxDiff = d; maxAt = p.t.toISOString(); }
      const month = p.t.toISOString().slice(0, 7);
      if (!firsts.has(month)) firsts.set(month, { at: p.t.toISOString(), old: lvl(p.value), new: lvl(nv) });
    }
    const oEnd = lvl(o.points[o.points.length - 1].value);
    const nEnd = lvl(n.points[n.points.length - 1].value);
    out.push({
      symbol: o.symbol, points: shared, outagePoints, oldEnd: oEnd, newEnd: nEnd, endDiffPct: (nEnd / oEnd - 1) * 100,
      maxDiffPct: maxDiff * 100, maxDiffAt: maxAt,
      monthStarts: [...firsts.values()],
      turnoverOld: sumTurnover(old.turnover, o.symbol), turnoverNew: sumTurnover(v3.turnover, o.symbol),
    });
  }
  return out;
}
