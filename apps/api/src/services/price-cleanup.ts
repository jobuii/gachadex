/**
 * Bad card-print cleanup (2026-10 index audit). Finds accepted card prints that are data errors and REJECTS them
 * (oracle_prices.is_accepted = false + reject_reason) so the index history rebuild and the live dedup baseline
 * never use them. Reversible (history_repair_backup, revertHistoryRepair).
 *
 * Card MARKS are deliberately left alone: a card mark is the venue's trading record — the price P&L and
 * liquidations actually ran against at the time. Instead, the plan reports every position that was open on a
 * market during a rejected window, for an operator to review.
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
 */
import type { Db, Queryer } from '../db/client.ts';
import { config } from '../config.ts';
import { newRepairRunId } from './history-repair.ts';
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
  rule: 'P' | 'E';
  at: Date;
  printedUsd: number;
  referenceUsd: number | null; // P: what the fixed code would print (0 = halt); E: the pre-excursion value
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

/** Read-only: every print to reject, plus the persistent shifts for review and the affected positions. */
export async function planPriceCleanup(q: Queryer): Promise<CleanupPlan> {
  const markets = new Map(
    (await q.query<{ id: string; symbol: string; display_name: string; game: string }>(`SELECT id, symbol, display_name, game FROM markets WHERE kind = 'card'`)).rows.map(
      (m) => [m.id, m],
    ),
  );
  const rejected = new Map<string, RejectedPrint>();
  const review: ReviewItem[] = [];
  // Chunked by market (~150k prints / ~130 MB of payload in prod), reading only the fields the replay uses.
  const ids = [...markets.keys()];
  for (let c = 0; c < ids.length; c += 200) {
    const prints = (
      await q.query<Print>(
        `SELECT o.id::text AS id, o.market_id, o.ingested_at AS ing, o.index_price_e6::text AS v,
                jsonb_build_object('backfill', o.raw_payload->'backfill', 'scrydex', o.raw_payload->'scrydex',
                  'tcgpricelookup', jsonb_build_object('prices', jsonb_build_object('raw', o.raw_payload->'tcgpricelookup'->'prices'->'raw'))) AS p
           FROM oracle_prices o WHERE o.market_id = ANY($1) AND o.is_accepted ORDER BY o.market_id, o.ingested_at, o.id`,
        [ids.slice(c, c + 200)],
      )
    ).rows;
    for (let i = 0, j = 0; i < prints.length; i = j) {
      while (j < prints.length && prints[j].market_id === prints[i].market_id) j++;
      scanMarket(prints.slice(i, j), markets.get(prints[i].market_id)!, rejected, review);
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
  return { rejected: [...rejected.values()], review, exposures, byMarket };
}

/** Reject the planned prints (reversible by run id) — one backup insert, one update. */
export async function applyPriceCleanup(db: Db, plan: CleanupPlan): Promise<{ runId: string; rejected: number }> {
  const runId = newRepairRunId('cleanup');
  if (!plan.rejected.length) return { runId, rejected: 0 };
  const reason = { P: `cleanup ${runId}: placeholder adopted by the tcgpl fallback (rule P)`, E: `cleanup ${runId}: reverted ≥2× excursion (rule E)` };
  const ids = plan.rejected.map((r) => r.printId);
  const rejected = await db.tx(async (q) => {
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
    return r.rows.length;
  });
  return { runId, rejected };
}
