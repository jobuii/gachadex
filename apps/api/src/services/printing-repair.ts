/**
 * Wrong-printing price repair (2026-10-18 plan P4). From the first Scrydex price (19 Jun 2026) until the variant fix
 * went live (16 Oct 21:22:57 UTC, 9ba9ef3) the Scrydex reader took the FIRST printing listed for a TCGplayer
 * product, so e.g. Flooded Strand Foil was priced as the normal card ($110 vs ~$1,200). One Piece names never match
 * between providers, so one live market stayed wrong after the fix (Shanks OP09-004 SP Gold, until 7548cc4).
 *
 * A Scrydex-anchored print (the stored value IS the Scrydex price) is rewritten when either
 *   A. (before the fix) the old code's pick — the first Scrydex printing of the product, recorded in price_index as
 *      of 9 Jul — is a different printing than the market's (names compared through normVariant; One Piece names
 *      never compare, MTG serialized foils and 1st-Edition spellings are the same printing), and the Scrydex price is
 *      ≥ 1.3× off our printing's own TCGplayer price in the same record; or
 *   B. (any time) the wrong-printing signature the live guard now catches (scrydex.ts combinePrice): Scrydex under
 *      half of our printing's TCGplayer price while eBay sides with TCGplayer and not with Scrydex.
 * The new value is our printing's TCGplayer price from the SAME stored record (near-mint first, placeholders skipped —
 * tplCrossCheck), so no provider call is needed. Rows are rewritten IN PLACE (a second row for the same moment is
 * blocked by uq_oracle_market_observed), with the old value + payload backed up for revert. The wrong printing's
 * Scrydex PSA-10 ladder and stored gradedE6 are dropped from the payload, so the history rebuild falls back to the
 * same record's TCGplayer eBay PSA-10 for our printing. Card-chart marks are replayed through the mark guard from the
 * corrected prices; a run is committed only where it rejoins the stored marks (never across an open position, never
 * through the live mark of a listed market — a delisted market has no trading reference, so its run is committed).
 */
import { toE6 } from '@pokex/pricing';
import type { Db, Queryer } from '../db/client.ts';
import { newRepairRunId } from './history-repair.ts';
import { normVariant } from './providers/backfill.ts';
import { tplCrossCheck, type TplCard } from './providers/tcgpricelookup.ts';
import { EBAY_BAND_LO, EBAY_BAND_HI } from './providers/scrydex.ts';

export const SCRYDEX_PRIMARY_FROM = new Date('2026-06-19T00:00:00Z');
export const PRINTING_FIX_AT = new Date('2026-10-16T21:22:57.269Z');
const RULE_A_GAP = 1.3;
const RULE_B_RATIO = 0.5;

/** Would the old first-match pick `pick` have been the market's own printing `ours`? (true when names can't tell)
 *  Stamped promos (Staff, Prerelease, Play!) and MTG foil-only / serialized products are their OWN TCGplayer products
 *  — tcgpl calls them "Holofoil"/"Normal", Scrydex names the stamp/foil — so a stamp or foil pick there IS our printing. */
export function samePrinting(game: string, ours: string | null, pick: string | null, name = ''): boolean {
  if (game === 'onepiece' || !ours || !pick) return true; // One Piece: tcgpl says "Foil", Scrydex names the art — rule B only
  const a = normVariant(ours);
  const b = normVariant(pick);
  if (a === b) return true;
  if (b?.includes('stamp')) return true; // a stamped printing is its own product
  if (game === 'mtg' && b === 'serializedfoil') return true; // tcgpl labels a serialized card Foil/Normal: one printing
  if (game === 'mtg' && b?.includes('foil') && /foil|serial/i.test(name)) return true; // a foil-only product (Textured Foil, Serial Numbered)
  if (a === 'firsteditionholofoil' && b?.startsWith('firstedition') && b.endsWith('holofoil')) return true; // shadowless spelling
  return false;
}

// Scrydex anchor condition → the tcgpl rung read like-for-like (as the live combine does, scrydex.ts fetchScrydexTrackedCards).
const SX_TO_TPL: Record<string, string> = { NM: 'near_mint', LP: 'lightly_played', MP: 'moderately_played' };

const inBand = (ebay: number, price: number) => ebay >= EBAY_BAND_LO * price && ebay <= EBAY_BAND_HI * price;

export interface PrintRewrite {
  printId: string;
  marketId: string;
  oldE6: string;
  newE6: string;
  rule: 'A' | 'B';
  corroborated: boolean; // eBay agreed with the new price — the live guard would have adopted it without clamping
  at: Date; // the print's ingested_at
}

export interface MarkRewrite {
  markId: string;
  marketId: string;
  oldMarkE6: string;
  newE6: string;
}

export interface PrintingRepairPlan {
  rewrites: PrintRewrite[];
  ladderDrops: string[]; // other pre-fix prints of a confirmed rule-A market: value kept, the wrong printing's PSA-10 dropped
  byMarket: { marketId: string; symbol: string; name: string; game: string; variant: string | null; oldPick: string | null; prints: number; typicalGap: number; firstAt: Date; lastAt: Date; rules: string }[];
  markRepairs: MarkRewrite[];
  marksKept: { position: number; live: number; unexplained: number };
}

interface Row {
  id: string;
  market_id: string;
  ing: Date;
  v: string;
  sx: { market?: number; currency?: string; fxJpyUsd?: number; condition?: string; graded?: unknown } | null;
  tp: TplCard['prices'] | null;
  game: string;
  variant: string | null;
  symbol: string;
  name: string;
  pick: string | null;
}

/** Read-only: every print to rewrite, per-market summary, and the mark replay. `until` = end of the rule-B window. */
export async function planPrintingRepair(q: Queryer, opts: { until?: Date; clampBps: number }): Promise<PrintingRepairPlan> {
  const until = opts.until ?? new Date();
  const rows = (
    await q.query<Row>(
      `SELECT o.id::text AS id, o.market_id, o.ingested_at AS ing, o.index_price_e6::text AS v,
              o.raw_payload->'scrydex' AS sx, o.raw_payload->'tcgpricelookup'->'prices' AS tp,
              m.game, m.variant, m.symbol, m.display_name AS name, p.scrydex_variant AS pick
         FROM oracle_prices o
         JOIN markets m ON m.id = o.market_id AND m.kind = 'card'
         LEFT JOIN price_index p ON p.tcgplayer_id = m.tcgplayer_id
        WHERE o.is_accepted AND o.ingested_at >= $1 AND o.ingested_at < $2
          AND o.raw_payload->'scrydex'->>'market' IS NOT NULL AND NOT COALESCE(o.raw_payload ? 'backfill', false)
        ORDER BY o.market_id, o.ingested_at, o.id`,
      [SCRYDEX_PRIMARY_FROM, until],
    )
  ).rows;

  const rewrites: PrintRewrite[] = [];
  const summary = new Map<string, PrintingRepairPlan['byMarket'][number] & { gaps: number[]; ruleSet: Set<string> }>();
  for (const r of rows) {
    const sxRaw = Number(r.sx?.market);
    const sxUsd = r.sx?.currency === 'JPY' ? sxRaw * Number(r.sx?.fxJpyUsd ?? NaN) : sxRaw;
    if (!(sxUsd > 0)) continue;
    const printed = Number(r.v) / 1e6;
    if (Math.abs(printed - Math.round(sxUsd * 100) / 100) > 0.011) continue; // not priced off the Scrydex anchor
    // our printing's TCGplayer price at the SAME condition the Scrydex anchor priced (like-for-like, as live compared)
    const cond = r.sx?.condition ? SX_TO_TPL[r.sx.condition] : undefined;
    const { tcgpMarket: own, ebay1d } = tplCrossCheck({ prices: r.tp ?? undefined } as Pick<TplCard, 'prices'>, cond);
    if (own == null || !(own > 0)) continue; // no price for our printing to put in its place
    if (Math.abs(own - sxUsd) < 0.005) continue; // to the cent the same as our printing's own price: it WAS our printing
    const gap = Math.max(sxUsd, own) / Math.min(sxUsd, own);
    const preFix = new Date(r.ing).getTime() < PRINTING_FIX_AT.getTime();
    const ruleA = preFix && !samePrinting(r.game, r.variant, r.pick, r.name) && gap >= RULE_A_GAP;
    const ruleB = sxUsd < RULE_B_RATIO * own && ebay1d != null && inBand(ebay1d, own) && !inBand(ebay1d, sxUsd);
    if (!ruleA && !ruleB) continue;
    const newE6 = toE6(Math.round(own * 100) / 100);
    if (newE6.toString() === r.v) continue;
    const rule = ruleA ? 'A' : 'B';
    rewrites.push({ printId: r.id, marketId: r.market_id, oldE6: r.v, newE6: newE6.toString(), rule, corroborated: ebay1d != null && inBand(ebay1d, own), at: new Date(r.ing) });
    let s = summary.get(r.market_id);
    if (!s) {
      s = { marketId: r.market_id, symbol: r.symbol, name: r.name, game: r.game, variant: r.variant, oldPick: r.pick, prints: 0, typicalGap: 0, firstAt: r.ing, lastAt: r.ing, rules: '', gaps: [], ruleSet: new Set() };
      summary.set(r.market_id, s);
    }
    s.prints++;
    s.lastAt = r.ing;
    s.gaps.push(gap);
    s.ruleSet.add(rule);
  }
  const byMarket = [...summary.values()].map(({ gaps, ruleSet, ...s }) => {
    const sorted = gaps.sort((a, b) => a - b);
    return { ...s, typicalGap: Math.round(sorted[sorted.length >> 1] * 100) / 100, rules: [...ruleSet].sort().join('') };
  });
  byMarket.sort((a, b) => b.typicalGap - a.typicalGap);
  // A confirmed rule-A market: EVERY pre-fix Scrydex print read its PSA-10 ladder off the same wrong printing (the
  // ladder used the same first-match pick), not only the rewritten ones — drop it on the rest too, value untouched.
  const ruleAMarkets = new Set(rewrites.filter((x) => x.rule === 'A').map((x) => x.marketId));
  const rewritten = new Set(rewrites.map((x) => x.printId));
  const ladderDrops = rows
    .filter((r) => ruleAMarkets.has(r.market_id) && !rewritten.has(r.id) && new Date(r.ing).getTime() < PRINTING_FIX_AT.getTime() && r.sx?.graded != null)
    .map((r) => r.id);
  const { markRepairs, marksKept } = await planMarkReplay(q, rewrites, BigInt(opts.clampBps));
  return { rewrites, ladderDrops, byMarket, markRepairs, marksKept };
}

/** The live mark guard's step (marks.ts recomputeMark): an uncorroborated move is capped at `bps` of the last mark. */
function guardStep(last: bigint, candidate: bigint, bps: bigint): bigint {
  const diff = candidate > last ? candidate - last : last - candidate;
  if (last <= 0n || diff * 10_000n <= bps * last) return candidate;
  const capped = candidate > last ? (last * (10_000n + bps)) / 10_000n : (last * (10_000n - bps)) / 10_000n;
  return capped < 1n ? 1n : capped;
}

/** Replay each affected market's card marks from the corrected prints (times compared in µs, as stored). */
async function planMarkReplay(q: Queryer, rewrites: PrintRewrite[], bps: bigint): Promise<Pick<PrintingRepairPlan, 'markRepairs' | 'marksKept'>> {
  const markRepairs: MarkRewrite[] = [];
  const marksKept = { position: 0, live: 0, unexplained: 0 };
  const newById = new Map(rewrites.map((r) => [r.printId, BigInt(r.newE6)]));
  const corroboratedById = new Map(rewrites.map((r) => [r.printId, r.corroborated]));
  for (const marketId of [...new Set(rewrites.map((r) => r.marketId))]) {
    const prints = (
      await q.query<{ id: string; us: string; v: string; bf: boolean }>(
        `SELECT id::text, (EXTRACT(EPOCH FROM ingested_at) * 1000000)::bigint::text AS us, index_price_e6::text AS v,
                COALESCE(raw_payload ? 'backfill', false) AS bf
           FROM oracle_prices WHERE market_id = $1 AND is_accepted ORDER BY ingested_at, id`,
        [marketId],
      )
    ).rows.map((p) => ({ at: BigInt(p.us), v: newById.get(p.id) ?? BigInt(p.v), rew: newById.has(p.id), bf: p.bf, corr: corroboratedById.get(p.id) ?? false }));
    const marks = (
      await q.query<{ id: string; us: string; m: string; i: string }>(
        `SELECT id::text, (EXTRACT(EPOCH FROM computed_at) * 1000000)::bigint::text AS us, mark_price_e6::text AS m, index_price_e6::text AS i
           FROM marks WHERE market_id = $1 ORDER BY computed_at, id`,
        [marketId],
      )
    ).rows;
    const positions = (
      await q.query<{ f: string; t: string | null }>(
        `SELECT (EXTRACT(EPOCH FROM opened_at) * 1000000)::bigint::text AS f, (EXTRACT(EPOCH FROM closed_at) * 1000000)::bigint::text AS t
           FROM positions WHERE market_id = $1`,
        [marketId],
      )
    ).rows.map((p) => ({ f: BigInt(p.f), t: p.t == null ? null : BigInt(p.t) }));
    const delisted = (await q.query<{ status: string }>(`SELECT status FROM markets WHERE id = $1`, [marketId])).rows[0]?.status === 'delisted';

    let pi = -1;
    let line: bigint | null = null;
    let anchor: bigint | null = null;
    let run: MarkRewrite[] | null = null;
    const keepWhole = (why: 'position' | 'unexplained', stored: bigint) => {
      marksKept[why] += (run?.length ?? 0) + 1;
      run = null;
      line = anchor = stored;
    };
    for (const mk of marks) {
      const at = BigInt(mk.us);
      while (pi + 1 < prints.length && prints[pi + 1].at <= at) pi++;
      const stored = BigInt(mk.m);
      const p = pi >= 0 ? prints[pi] : null;
      if (p && p.bf && !p.rew) continue; // a gap-day backfill (written afterwards): no live mark ever followed it
      if (!p || (!p.rew && run == null)) {
        line = anchor = stored;
        continue;
      }
      if (positions.some((x) => x.f <= at && (x.t == null || x.t >= at))) {
        keepWhole('position', stored);
        continue;
      }
      let next: bigint;
      if (p.rew) next = line == null || p.corr ? p.v : guardStep(line, p.v, bps); // eBay-corroborated: adopted at once, as live
      else {
        // An untouched print: how did the live guard reach `stored`? (as price-cleanup's replay)
        const guarded: bigint = anchor == null ? p.v : guardStep(anchor, p.v, bps);
        if (stored !== p.v && stored !== guarded) {
          keepWhole('unexplained', stored);
          continue;
        }
        const corroborated = stored === p.v && guarded !== p.v;
        next = line == null || corroborated ? p.v : guardStep(line, p.v, bps);
      }
      anchor = stored;
      if (!p.rew && next === stored) {
        if (run) markRepairs.push(...run); // rejoined: commit the run
        run = null;
        line = stored;
        continue;
      }
      run ??= [];
      if (next !== stored || BigInt(mk.i) !== next) run.push({ markId: mk.id, marketId, oldMarkE6: mk.m, newE6: next.toString() });
      line = next;
    }
    // Never rejoined: on a delisted market nothing trades off the last mark, so the corrected chart is committed;
    // on a listed one the live mark is the trading reference — the run is left whole.
    if (run && delisted) markRepairs.push(...(run as MarkRewrite[]));
    else if (run) marksKept.live += (run as MarkRewrite[]).length;
  }
  return { markRepairs, marksKept };
}

/** Write the plan in one transaction (prints rewritten in place + marks), every changed row backed up for revert. */
export async function applyPrintingRepair(db: Db, plan: PrintingRepairPlan): Promise<{ runId: string; rewritten: number; marksReset: number }> {
  const runId = newRepairRunId('printing');
  if (!plan.rewrites.length && !plan.ladderDrops.length) return { runId, rewritten: 0, marksReset: 0 };
  return db.tx(async (q) => {
    const ids = plan.rewrites.map((r) => r.printId); // (ladder-only rows are backed up + rewritten below)
    await q.query(
      `INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, old_index_e6, old_payload)
       SELECT $1, 'oracle_prices', id::text, market_id, index_price_e6, raw_payload FROM oracle_prices WHERE id = ANY($2::bigint[])`,
      [runId, ids],
    );
    const p = await q.query(
      `UPDATE oracle_prices o
          SET index_price_e6 = u.v,
              raw_payload = ((o.raw_payload #- '{scrydex,graded}') - 'gradedE6')
                            || jsonb_build_object('printingRepair', jsonb_build_object('runId', $4::text, 'oldE6', o.index_price_e6::text, 'rule', u.r))
         FROM unnest($1::bigint[], $2::bigint[], $3::text[]) AS u(id, v, r)
        WHERE o.id = u.id AND o.index_price_e6 <> u.v
        RETURNING o.id`,
      [ids, plan.rewrites.map((r) => r.newE6), plan.rewrites.map((r) => r.rule), runId],
    );
    if (plan.ladderDrops.length) {
      await q.query(
        `INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, old_index_e6, old_payload)
         SELECT $1, 'oracle_prices', id::text, market_id, index_price_e6, raw_payload FROM oracle_prices WHERE id = ANY($2::bigint[])`,
        [runId, plan.ladderDrops],
      );
      await q.query(
        `UPDATE oracle_prices SET raw_payload = ((raw_payload #- '{scrydex,graded}') - 'gradedE6')
                                               || jsonb_build_object('printingRepair', jsonb_build_object('runId', $2::text, 'ladderOnly', true))
          WHERE id = ANY($1::bigint[])`,
        [plan.ladderDrops, runId],
      );
    }
    let marksReset = 0;
    if (plan.markRepairs.length) {
      const k = await q.query(
        `WITH u AS (SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[]) AS u(id, old, v)),
              prev AS (SELECT k.id, k.market_id, k.mark_price_e6, k.index_price_e6 FROM marks k JOIN u ON u.id = k.id AND k.mark_price_e6 = u.old),
              upd AS (UPDATE marks k SET mark_price_e6 = u.v, index_price_e6 = u.v FROM u, prev WHERE k.id = u.id AND prev.id = k.id RETURNING k.id)
         INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, old_mark_e6, old_index_e6)
         SELECT $4, 'marks', prev.id::text, prev.market_id, prev.mark_price_e6, prev.index_price_e6 FROM prev JOIN upd ON upd.id = prev.id RETURNING row_id`,
        [plan.markRepairs.map((m) => m.markId), plan.markRepairs.map((m) => m.oldMarkE6), plan.markRepairs.map((m) => m.newE6), runId],
      );
      marksReset = k.rows.length;
    }
    if (p.rows.length !== plan.rewrites.length) throw new Error(`printing repair: planned ${plan.rewrites.length} rewrites but ${p.rows.length} matched — re-plan (data changed)`);
    return { runId, rewritten: p.rows.length, marksReset };
  });
}
