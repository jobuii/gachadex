/**
 * Bad card-print cleanup (2026-10 index audit). Finds accepted card prints that are data errors and REJECTS them
 * (oracle_prices.is_accepted = false + reject_reason) so the index history rebuild and the live dedup baseline
 * never use them. Reversible (history_repair_backup, revertHistoryRepair).
 *
 * Card MARKS — what the card's chart draws — are replayed as if the rejected prints had never landed
 * (planMarkRepair, replayMarks): a rejected print would have made no mark, so its marks hold the replayed line; a mark
 * the guard clamped (uncorroborated: its mark ≠ its print) is re-clamped from the replayed line; a mark equal to its
 * print stays its print. The replay stops where it rejoins the stored marks. Kept as they are: marks from a window
 * when a position was open on the card (the trading record — the price P&L and liquidations actually ran against),
 * and a run still open at the card's latest mark (the live price). The plan reports every position open during a
 * rejected window, for an operator to review.
 *
 * Two deterministic, directional rules (no guessing which side of a jump is right):
 *   P — placeholder replay. Re-run TODAY's fixed price selection (tplCrossCheck + combinePrice: a tcgpl rung an
 *       order of magnitude below the card's other rungs skipped, a tcgpl fallback under half of Scrydex rejected) on
 *       the print's own stored payload. If the fixed code would not have printed this number (it halts, or lands
 *       ≥2× away), the print was a placeholder adoption — Entei ☆ $0.99, Mox Pearl $0.03, Lugia $500. Scrydex-era
 *       tcgpl-fallback prints only: a bad print that IS the Scrydex anchor (e.g. a pre-2026-06-23 $1 anchor rung,
 *       before broken rungs were dropped) can't be replayed — only the chosen rung's value was stored — so only
 *       rule E can catch those.
 *   E — reverted excursion. A run of prints all ≥2× away (same direction) from the last accepted value, that comes
 *       back within 1.5× of it within 7 days, is a transient error — Kid alt-art $5.51, Boa Hancock $2,857.
 * Persistent ≥5× level shifts that never revert are only REPORTED (rule S): the data can't say which side is right
 * (e.g. Birds of Paradise, where both feeds were wrong) — those need a human or a provider fix.
 *   M — operator reject: specific print ids, for a bad print no rule catches (e.g. a 1.9× one-day excursion). Never a
 *       card's latest print: the next pass would record the same provider value again (recordOracle dedups against
 *       the last ACCEPTED print).
 */
import type { Db, Queryer } from '../db/client.ts';
import { config } from '../config.ts';
import { newRepairRunId } from './history-repair.ts';
import { getMarkClampBps } from './marks.ts';
import { combinePrice, toUsd, type ScrydexRaw } from './providers/scrydex.ts';
import { tplCrossCheck, type TplCard } from './providers/tcgpricelookup.ts';

const P_RATIO = 2; // rule P: the fixed price this far from the printed one ⇒ the print was a placeholder
const E_RATIO = 2; // rule E: excursion size
const E_REVERT = 1.5; // …and how close the return must be to the pre-run value
const E_MAX_MS = 7 * 86_400_000; // …within this long
const S_RATIO = 5; // rule S (report only): a persistent level shift this large

export interface RejectedPrint {
  printId: string;
  marketId: string;
  rule: 'P' | 'E' | 'M';
  at: Date;
  printedUsd: number;
  referenceUsd: number | null; // P: what the fixed code would print (0 = halt); E: the pre-excursion value; M: null
}
export interface MarkRepair {
  markId: string;
  marketId: string;
  oldMarkE6: string;
  newE6: string; // the replayed mark (see replayMarks)
}
export interface ReviewItem {
  marketId: string;
  symbol: string;
  name: string;
  at: Date;
  fromUsd: number;
  toUsd: number;
}
export interface PositionExposure {
  marketId: string;
  symbol: string;
  positionId: string;
  status: string;
  side: string;
  openedAt: Date;
  closedAt: Date | null;
}
export interface CleanupPlan {
  rejected: RejectedPrint[];
  review: ReviewItem[];
  exposures: PositionExposure[];
  byMarket: { symbol: string; name: string; game: string; rule: string; prints: number; firstAt: Date; lastAt: Date; printedUsd: number; referenceUsd: number | null }[];
  markRepairs: MarkRepair[];
  marksKept: { position: number; live: number; unexplained: number; noReference: number }; // marks the replay would change, left as-is
}

const ratio = (a: number, b: number) => (a > b ? a / b : b / a);

/** Rule P on one stored payload: the price today's fixed selection would print (USD; 0 = halt), or null if
 *  the print didn't come from the tcgpl fallback (Scrydex-sourced, or a pre-Scrydex-era print). */
export function fixedPriceFromPayload(printedUsd: number, payload: any): number | null {
  if (payload?.backfill) return null; // a provider-history backfill print — not the live selection path
  const sxp = payload?.scrydex;
  if (!sxp || typeof sxp !== 'object') return null; // pre-cutover print: not this code path
  const prices = payload?.tcgpricelookup?.prices ?? null;
  const fx = typeof sxp.fxJpyUsd === 'number' ? sxp.fxJpyUsd : null;
  const sx: ScrydexRaw | null =
    typeof sxp.market === 'number' && sxp.market > 0
      ? { market: sxp.market, low: null, high: null, currency: sxp.currency ?? 'USD', day1Pct: null, condition: sxp.condition ?? 'NM', variant: null }
      : null;
  const sxUsd = sx ? toUsd(sx, fx) : null;
  if (sxUsd && Math.abs(sxUsd.market - printedUsd) < 0.01) return null; // the print IS the Scrydex anchor
  // The print came from the tcgpl fallback — so the anchor's best grade was broken (or there was no anchor). The
  // live code then reads tcgpl NM-FIRST (scrydex.ts: xCond is undefined when bestGradeBroken) — mirror that exactly.
  const cross = tplCrossCheck({ prices } as Pick<TplCard, 'prices'>);
  return combinePrice(sx ? { ...sx, bestGradeBroken: true } : null, cross, fx).priceUsd;
}

type Print = { id: string; market_id: string; ing: Date; v: string; p: any };

/** Rules P, E (reject) and S (report) over ONE market's accepted prints, oldest first. */
function scanMarket(prints: Print[], market: { symbol: string; display_name: string }, rejected: Map<string, RejectedPrint>, review: ReviewItem[]): void {
  const seq = prints.map((p) => ({ ...p, usd: Number(p.v) / 1e6 }));
  const mid = prints[0].market_id;
  // Rule P
  for (const p of seq) {
    if (p.usd <= 0) continue;
    const fixed = fixedPriceFromPayload(p.usd, p.p);
    if (fixed != null && (fixed <= 0 || ratio(p.usd, fixed) >= P_RATIO)) {
      rejected.set(p.id, { printId: p.id, marketId: mid, rule: 'P', at: p.ing, printedUsd: p.usd, referenceUsd: fixed });
    }
  }
  // Rule E (over the prints rule P keeps) + rule S (report)
  const kept = seq.filter((p) => !rejected.has(p.id) && p.usd > 0);
  // `base` = the last value we accept as real: it moves with ordinary moves and persistent shifts, but NOT through
  // a rejected excursion — the print after a glitch is compared to the pre-glitch value, never to the glitch.
  let base = kept[0]?.usd ?? 0;
  for (let a = 1; a < kept.length; a++) {
    if (ratio(kept[a].usd, base) < E_RATIO) {
      base = kept[a].usd;
      continue;
    }
    const up = kept[a].usd > base;
    let b = a;
    while (b + 1 < kept.length && ratio(kept[b + 1].usd, base) >= E_RATIO && kept[b + 1].usd > base === up) b++;
    const back = kept[b + 1];
    if (back && ratio(back.usd, base) <= E_REVERT && back.ing.getTime() - kept[a].ing.getTime() <= E_MAX_MS) {
      for (let k = a; k <= b; k++) rejected.set(kept[k].id, { printId: kept[k].id, marketId: mid, rule: 'E', at: kept[k].ing, printedUsd: kept[k].usd, referenceUsd: base });
    } else {
      if (ratio(kept[a].usd, base) >= S_RATIO) review.push({ marketId: mid, symbol: market.symbol, name: market.display_name, at: kept[a].ing, fromUsd: base, toUsd: kept[a].usd });
      base = kept[b].usd; // a persistent shift: the new level is the reference from here on
    }
    a = b;
  }
}

/**
 * Read-only: the card-mark replay (see the header) over every card with a cleanup-rejected print in the DB or one of
 * `planned` (print ids about to be rejected). A print's window runs from it to the card's next print.
 */
export async function planMarkRepair(q: Queryer, planned: string[], clampBps: number): Promise<Pick<CleanupPlan, 'markRepairs' | 'marksKept'>> {
  const mids = (
    await q.query<{ market_id: string }>(
      `SELECT DISTINCT o.market_id FROM oracle_prices o JOIN markets m ON m.id = o.market_id AND m.kind = 'card'
        WHERE (NOT o.is_accepted AND o.reject_reason LIKE 'cleanup %') OR o.id = ANY($1::bigint[])`,
      [planned],
    )
  ).rows.map((r) => r.market_id);
  const markRepairs: MarkRepair[] = [];
  const marksKept = { position: 0, live: 0, unexplained: 0, noReference: 0 };
  const us = (col: string) => `(extract(epoch FROM ${col}) * 1000000)::bigint::text`; // µs: a JS Date truncates to ms
  const byMarket = <T extends { market_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.market_id, [...(m.get(r.market_id) ?? []), r]);
    return m;
  };
  for (let c = 0; c < mids.length; c += 50) {
    const chunk = mids.slice(c, c + 50);
    // Accepted and cleanup-rejected prints only: a print the live oracle itself rejected never got a mark.
    const prints = byMarket(
      (
        await q.query<{ market_id: string; ing: string; v: string; bad: boolean; bf: boolean }>(
          `SELECT market_id, ${us('ingested_at')} AS ing, index_price_e6::text AS v,
                  (NOT is_accepted OR id = ANY($2::bigint[])) AS bad, raw_payload ? 'backfill' AS bf
             FROM oracle_prices WHERE market_id = ANY($1) AND (is_accepted OR reject_reason LIKE 'cleanup %')
            ORDER BY market_id, ingested_at, id`,
          [chunk, planned],
        )
      ).rows,
    );
    const marks = byMarket(
      (
        await q.query<{ id: string; market_id: string; at: string; m: string; i: string }>(
          `SELECT id::text AS id, market_id, ${us('computed_at')} AS at, mark_price_e6::text AS m, index_price_e6::text AS i
             FROM marks WHERE market_id = ANY($1) ORDER BY market_id, computed_at, id`,
          [chunk],
        )
      ).rows,
    );
    const positions = byMarket(
      (
        await q.query<{ market_id: string; f: string; t: string | null }>(
          `SELECT market_id, ${us('opened_at')} AS f, ${us('closed_at')} AS t FROM positions WHERE market_id = ANY($1)`,
          [chunk],
        )
      ).rows,
    );
    for (const mid of chunk) {
      replayMarks(
        (prints.get(mid) ?? []).map((p) => ({ ...p, ing: BigInt(p.ing) })),
        (marks.get(mid) ?? []).map((k) => ({ ...k, at: BigInt(k.at) })),
        (positions.get(mid) ?? []).map((p) => ({ f: BigInt(p.f), t: p.t == null ? null : BigInt(p.t) })),
        BigInt(clampBps),
        markRepairs,
        marksKept,
      );
    }
  }
  return { markRepairs, marksKept };
}

/** The mark guard (marks.ts recomputeMark): an uncorroborated move beyond `bps` of the last mark is capped at it. */
function guardStep(last: bigint, candidate: bigint, bps: bigint): bigint {
  const diff = candidate > last ? candidate - last : last - candidate;
  if (last <= 0n || diff * 10_000n <= bps * last) return candidate;
  const capped = candidate > last ? (last * (10_000n + bps)) / 10_000n : (last * (10_000n - bps)) / 10_000n;
  return capped < 1n ? 1n : capped;
}

/**
 * One card's replay (prints and marks oldest first, times in µs; see the header). A run — from the first mark the
 * rejected prints changed to where the replay rejoins the stored marks — is committed only once it rejoins. It is
 * left whole instead when it reaches a mark that must stay (a position open at that mark — the trading record; the
 * live mark) or a clamped mark the guard formula doesn't reproduce (e.g. mark_clamp_bps was different then), so a
 * chart never gets a cliff or a wiggle from a half-applied replay.
 */
function replayMarks(
  prints: { ing: bigint; v: string; bad: boolean; bf: boolean }[],
  marks: { id: string; market_id: string; at: bigint; m: string; i: string }[],
  positions: { f: bigint; t: bigint | null }[],
  bps: bigint,
  out: MarkRepair[],
  kept: CleanupPlan['marksKept'],
) {
  const nextGood: (bigint | null)[] = []; // the first accepted price after print i (a rejected print with no mark before it)
  for (let i = prints.length - 1, v: bigint | null = null; i >= 0; i--) {
    nextGood[i] = v;
    if (!prints[i].bad) v = BigInt(prints[i].v);
  }
  let pi = -1;
  let line: bigint | null = null; // the replayed mark line
  let anchor: bigint | null = null; // the stored mark the live guard anchored on (backfilled marks never were)
  let run: MarkRepair[] | null = null; // the open run's repairs
  const keepWhole = (why: 'position' | 'unexplained', stored: bigint) => {
    kept[why] += (run?.length ?? 0) + 1;
    run = null;
    line = anchor = stored;
  };
  for (const mk of marks) {
    while (pi + 1 < prints.length && prints[pi + 1].ing <= mk.at) pi++;
    const stored = BigInt(mk.m);
    const p = pi >= 0 ? prints[pi] : null;
    if (p && p.bf && !p.bad) continue; // a gap-day backfill (written afterwards at 06:00): no live mark ever followed it
    if (!p || (!p.bad && run == null)) {
      line = anchor = stored; // untouched history
      continue;
    }
    if (positions.some((x) => x.f <= mk.at && (x.t == null || x.t >= mk.at))) {
      keepWhole('position', stored);
      continue;
    }
    const price = BigInt(p.v);
    let next: bigint | null;
    if (p.bad) next = line ?? nextGood[pi];
    else {
      // How the live guard got `stored`: clamped from its anchor, or unclamped — corroborated (out of band, yet equal
      // to the print) or inside the band (then the replay must re-apply the guard from the replayed line).
      const guarded: bigint = anchor == null ? price : guardStep(anchor, price, bps);
      if (stored !== price && stored !== guarded) {
        keepWhole('unexplained', stored);
        continue;
      }
      const corroborated = stored === price && guarded !== price;
      next = line == null || corroborated ? price : guardStep(line, price, bps);
    }
    anchor = stored;
    if (!p.bad && next === stored) {
      if (run) out.push(...run); // rejoined
      run = null;
      line = stored;
      continue;
    }
    run ??= [];
    if (next == null) {
      kept.noReference++;
      continue;
    }
    if (next !== stored || BigInt(mk.i) !== next) run.push({ markId: mk.id, marketId: mk.market_id, oldMarkE6: mk.m, newE6: next.toString() });
    line = next;
  }
  if (run) kept.live += (run as MarkRepair[]).length; // still open at the live mark: the whole run stays
}

/**
 * Read-only: every print to reject, plus the persistent shifts for review, the affected positions and the card marks
 * to reset. `reject` adds operator-chosen print ids (rule M) — each must be an accepted card print. `clampBps` is the
 * mark guard's threshold the mark replay re-applies (default: the live knob as loaded).
 */
export async function planPriceCleanup(q: Queryer, opts: { reject?: string[]; clampBps?: number } = {}): Promise<CleanupPlan> {
  const markets = new Map(
    (await q.query<{ id: string; symbol: string; display_name: string; game: string }>(`SELECT id, symbol, display_name, game FROM markets WHERE kind = 'card'`)).rows.map(
      (m) => [m.id, m],
    ),
  );
  const rejected = new Map<string, RejectedPrint>();
  const review: ReviewItem[] = [];
  const reject = opts.reject ?? []; // rule M — left out of the P/E/S scan, so it is never a rule's reference
  // Chunked by market (~150k prints / ~130 MB of payload in prod), reading only the fields the replay uses.
  const ids = [...markets.keys()];
  for (let c = 0; c < ids.length; c += 200) {
    const prints = (
      await q.query<Print>(
        `SELECT o.id::text AS id, o.market_id, o.ingested_at AS ing, o.index_price_e6::text AS v,
                jsonb_build_object('backfill', o.raw_payload->'backfill', 'scrydex', o.raw_payload->'scrydex',
                  'tcgpricelookup', jsonb_build_object('prices', jsonb_build_object('raw', o.raw_payload->'tcgpricelookup'->'prices'->'raw'))) AS p
           FROM oracle_prices o WHERE o.market_id = ANY($1) AND o.is_accepted AND o.id <> ALL($2::bigint[])
          ORDER BY o.market_id, o.ingested_at, o.id`,
        [ids.slice(c, c + 200), reject],
      )
    ).rows;
    for (let i = 0, j = 0; i < prints.length; i = j) {
      while (j < prints.length && prints[j].market_id === prints[i].market_id) j++;
      scanMarket(prints.slice(i, j), markets.get(prints[i].market_id)!, rejected, review);
    }
  }
  if (reject.length) {
    const found = (
      await q.query<{ id: string; market_id: string; ing: Date; v: string; is_accepted: boolean; latest: boolean }>(
        `SELECT o.id::text AS id, o.market_id, o.ingested_at AS ing, o.index_price_e6::text AS v, o.is_accepted,
                NOT EXISTS (SELECT 1 FROM oracle_prices n WHERE n.market_id = o.market_id AND n.ingested_at > o.ingested_at) AS latest
           FROM oracle_prices o JOIN markets m ON m.id = o.market_id AND m.kind = 'card' WHERE o.id = ANY($1::bigint[])`,
        [reject],
      )
    ).rows;
    const bad = reject.filter((id) => !found.some((f) => f.id === id && f.is_accepted));
    if (bad.length) throw new Error(`--reject: not an accepted card print: ${bad.join(', ')}`);
    const latest = found.filter((f) => f.latest).map((f) => f.id);
    if (latest.length) throw new Error(`--reject: the card's latest print (the next pass would record it again): ${latest.join(', ')}`);
    for (const f of found) {
      if (!rejected.has(f.id)) rejected.set(f.id, { printId: f.id, marketId: f.market_id, rule: 'M', at: f.ing, printedUsd: Number(f.v) / 1e6, referenceUsd: null });
    }
  }

  // Per-market windows + (one query) the positions that were open during them.
  const groups = new Map<string, RejectedPrint[]>();
  for (const r of rejected.values()) {
    const list = groups.get(r.marketId) ?? [];
    list.push(r);
    groups.set(r.marketId, list);
  }
  const byMarket: CleanupPlan['byMarket'] = [];
  const win = { mid: [] as string[], from: [] as string[], to: [] as string[] };
  for (const [mid, rs] of groups) {
    rs.sort((a, b) => a.at.getTime() - b.at.getTime());
    const m = markets.get(mid)!;
    const first = rs[0].at;
    const lastAt = rs[rs.length - 1].at;
    byMarket.push({ symbol: m.symbol, name: m.display_name, game: m.game, rule: [...new Set(rs.map((r) => r.rule))].join('+'), prints: rs.length, firstAt: first, lastAt, printedUsd: rs[0].printedUsd, referenceUsd: rs[0].referenceUsd });
    win.mid.push(mid);
    win.from.push(first.toISOString());
    win.to.push(new Date(lastAt.getTime() + config.oracleStaleMs).toISOString()); // a rejected print stays the mark until the next one
  }
  const exposures: PositionExposure[] = win.mid.length
    ? (
        await q.query<{ market_id: string; id: string; status: string; side: string; opened_at: Date; closed_at: Date | null }>(
          `SELECT p.market_id, p.id, p.status, p.side, p.opened_at, p.closed_at
             FROM positions p JOIN unnest($1::text[], $2::timestamptz[], $3::timestamptz[]) AS w(mid, f, t) ON p.market_id = w.mid
            WHERE p.opened_at <= w.t AND (p.closed_at IS NULL OR p.closed_at >= w.f)`,
          [win.mid, win.from, win.to],
        )
      ).rows.map((p) => ({ marketId: p.market_id, symbol: markets.get(p.market_id)!.symbol, positionId: p.id, status: p.status, side: p.side, openedAt: p.opened_at, closedAt: p.closed_at }))
    : [];
  byMarket.sort((a, b) => b.prints - a.prints);
  return { rejected: [...rejected.values()], review, exposures, byMarket, ...(await planMarkRepair(q, [...rejected.keys()], opts.clampBps ?? getMarkClampBps())) };
}

/** Reject the planned prints and reset the planned card marks (reversible by run id) — set-based, one transaction. */
export async function applyPriceCleanup(db: Db, plan: CleanupPlan): Promise<{ runId: string; rejected: number; marksReset: number }> {
  const runId = newRepairRunId('cleanup');
  if (!plan.rejected.length && !plan.markRepairs.length) return { runId, rejected: 0, marksReset: 0 };
  const reason = {
    P: `cleanup ${runId}: placeholder adopted by the tcgpl fallback (rule P)`,
    E: `cleanup ${runId}: reverted ≥2× excursion (rule E)`,
    M: `cleanup ${runId}: operator reject (rule M)`,
  };
  const ids = plan.rejected.map((r) => r.printId);
  const res = await db.tx(async (q) => {
    await q.query(
      `INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, old_accepted)
       SELECT $1, 'oracle_prices', o.id::text, o.market_id, o.is_accepted FROM oracle_prices o
        WHERE o.id = ANY($2::bigint[]) AND o.is_accepted ON CONFLICT DO NOTHING`,
      [runId, ids],
    );
    const r = await q.query(
      `UPDATE oracle_prices o SET is_accepted = false, reject_reason = u.reason
         FROM unnest($1::bigint[], $2::text[]) AS u(id, reason) WHERE o.id = u.id AND o.is_accepted RETURNING o.id`,
      [ids, plan.rejected.map((r) => reason[r.rule])],
    );
    // Back up exactly the marks the update changes (the pre-update snapshot of each), so revert restores those only.
    const m = plan.markRepairs;
    const k = await q.query(
      `WITH u AS (SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[]) AS u(id, v, old)),
            prev AS (SELECT k.id, k.market_id, k.mark_price_e6, k.index_price_e6 FROM marks k JOIN u ON u.id = k.id AND k.mark_price_e6 = u.old),
            upd AS (UPDATE marks k SET mark_price_e6 = u.v, index_price_e6 = u.v FROM u, prev WHERE k.id = u.id AND prev.id = k.id RETURNING k.id)
       INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, old_mark_e6, old_index_e6)
       SELECT $4, 'marks', prev.id::text, prev.market_id, prev.mark_price_e6, prev.index_price_e6 FROM prev JOIN upd ON upd.id = prev.id
       RETURNING row_id`,
      [m.map((x) => x.markId), m.map((x) => x.newE6), m.map((x) => x.oldMarkE6), runId],
    );
    return { rejected: r.rows.length, marksReset: k.rows.length };
  });
  return { runId, ...res };
}
