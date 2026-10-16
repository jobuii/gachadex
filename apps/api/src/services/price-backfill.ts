/**
 * Gap-day price backfill (2026-10 index audit). On UTC days with NO oracle pass (missingPassDays — e.g. the
 * 9-day Scrydex 402 outage, 2026-09-24 → 10-01) there are no card prints, so card charts and every index have a
 * hole. This fetches each index-eligible (featured) card's price for those days from the providers' own daily
 * history and writes it as an accepted card print + a card mark at 06:00 UTC that day — then the index history
 * rebuild (index-rebuild.ts) gives every index a real point on each filled day. Reversible by run id.
 *
 * Every price is chosen by the LIVE oracle's own logic, applied to the provider's history rows:
 *   - Scrydex-matched (scrydex_card_id): Scrydex price_history for the variant the live code resolves; the day's
 *     rows go through extractRaw (NM → LP → MP, placeholder rungs dropped), toUsd, and the graded ladder's PSA 10.
 *     A day whose best grade is broken is skipped (live would have used tcgpl's price there).
 * Only (market, day) pairs where the market has a LATER mark are filled — so a backfilled mark is never a card's
 * latest (live) mark — and pinned markets are skipped (live never prints over an operator's price).
 *   - otherwise: tcgpl /history (one call per card; tcgpl's own cadence is ~weekly) — the latest TCGplayer market
 *     on or up to 6 days before the gap day, live condition order + placeholder floor; PSA-10 from the eBay row.
 * JPY prices use the CURRENT FX rate (historical FX isn't available) — the only approximation; JP printings are few.
 *
 * A filled price must agree with the card's own history around the gap: a row `outlierFactor`× or more off every
 * accepted print on either side (screenBackfillPlan) is dropped. Provider history is labelled as of its date, and
 * our variant match is today's — measured 2026-10-17: Scrydex's OP05-074 history swaps altArt/mangaAltArt vs today's
 * card ($5.52 vs a live $957), and the 7ED Foils' history is the Foil printing our pre-2026-10-16 marks never priced.
 */
import { fromE6, toE6 } from '@pokex/pricing';
import type { Db, Queryer } from '../db/client.ts';
import { insertHistoricalPoints, newRepairRunId } from './history-repair.ts';
import {
  extractRaw, toUsd, scrydexGradedLadder, scrydexPsa10E6, scrydexSlug,
  type ScrydexCard, type ScrydexHistoryDay,
} from './providers/scrydex.ts';
import { CONDITION_ORDER, ebayAvgUsd, tplPlaceholderFloor, type TplHistoryPoint } from './providers/tcgpricelookup.ts';

export interface BackfillDeps {
  scrydexCards: (slug: string, ids: string[]) => Promise<ScrydexCard[]>; // batch (≤100 per credit)
  scrydexHistory: (slug: string, id: string, start: string, end: string) => Promise<ScrydexHistoryDay[]>;
  tcgplHistory: (providerCardId: string) => Promise<TplHistoryPoint[]>; // period 1y
  fxJpyUsd: () => Promise<number | null>;
}

export interface BackfillRow {
  marketId: string;
  symbol: string;
  day: string;
  priceE6: bigint;
  gradedE6: bigint | null;
  source: 'scrydex' | 'tcgpl';
  sourceDate: string; // the provider point used (tcgpl may be up to 6 days earlier)
}

export interface BackfillPlan {
  days: string[];
  rows: BackfillRow[];
  misses: { symbol: string; reason: string }[];
  calls: { scrydexBatch: number; scrydexHistory: number; tcgplHistory: number };
}

const TPL_MAX_LAG_DAYS = 6;
const DAY_MS = 86_400_000;
const atOf = (day: string) => new Date(`${day}T06:00:00.000Z`); // a filled print's timestamp
const PROVIDER_CONCURRENCY = 4; // the provider clients' limiter still paces every request + enforces the credit caps

/** Contiguous runs of days → [start, end] windows (one history call per window per card). */
export function dayWindows(days: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const d of [...new Set(days)].sort()) {
    const last = out[out.length - 1];
    if (last && Date.parse(`${d}T00:00:00Z`) - Date.parse(`${last[1]}T00:00:00Z`) === DAY_MS) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

/** A Scrydex history day → raw USD + PSA-10 USD, chosen by the live extractRaw / graded ladder on our variant. */
export function scrydexDayPrice(day: ScrydexHistoryDay, tcgplayerId: number | null, variant: string | null, fx: number | null): { raw: number | null; psa10: number | null } {
  if (tcgplayerId == null || !variant) return { raw: null, psa10: null };
  const card: ScrydexCard = {
    id: 'history',
    variants: [{ name: variant, marketplaces: [{ product_id: String(tcgplayerId) }], prices: (day.prices ?? []).filter((p) => p.variant == null || p.variant === variant) }],
  } as ScrydexCard;
  const raw = extractRaw(card, tcgplayerId, variant);
  // A broken best grade: live (combinePrice) would price from tcgpl's same-grade market, which this backfill doesn't
  // fetch for Scrydex cards — so no price, rather than a different (downgraded) rung than live would have used.
  const usd = raw && !raw.bestGradeBroken ? toUsd(raw, fx) : null;
  const psa10 = scrydexPsa10E6(scrydexGradedLadder(card, tcgplayerId, fx, variant));
  return { raw: usd && usd.market > 0 ? usd.market : null, psa10: psa10 != null ? Number(psa10) / 1e6 : null };
}

/** The latest tcgpl history point on/before `day` (within TPL_MAX_LAG_DAYS) → raw USD + PSA-10 USD. */
export function tcgplDayPrice(points: TplHistoryPoint[], day: string): { raw: number | null; psa10: number | null; date: string | null } {
  const t = Date.parse(`${day}T00:00:00Z`);
  const cands = points
    .filter((p) => {
      const pt = Date.parse(`${p.date}T00:00:00Z`);
      return pt <= t && t - pt <= TPL_MAX_LAG_DAYS * DAY_MS;
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const p of cands) {
    const tcgp = p.prices.filter((r) => r.source === 'tcgplayer' && r.condition && (r.price_market ?? 0) > 0);
    const floor = tplPlaceholderFloor(tcgp.map((r) => r.price_market));
    const rung = CONDITION_ORDER.map((c) => tcgp.find((r) => r.condition === c)).find((r) => r && (r.price_market as number) >= floor);
    if (!rung) continue;
    const g = p.prices.find((r) => r.grader?.toLowerCase() === 'psa' && r.grade === '10');
    return { raw: rung.price_market as number, psa10: g ? ebayAvgUsd({ avg_1d: g.avg_1d ?? undefined, avg_7d: g.avg_7d ?? undefined, avg_30d: g.avg_30d ?? undefined }) : null, date: p.date };
  }
  return { raw: null, psa10: null, date: null };
}

/** Run `fn` over `items` with at most `n` in flight. */
async function inPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** Read-only against our DB; calls the providers (credits) — run the probe first. */
export async function planBackfill(q: Queryer, deps: BackfillDeps, days: string[], log: (m: string) => void = () => {}): Promise<BackfillPlan> {
  const plan: BackfillPlan = { days, rows: [], misses: [], calls: { scrydexBatch: 0, scrydexHistory: 0, tcgplHistory: 0 } };
  if (!days.length) return plan;
  const cards = (
    await q.query<{ id: string; symbol: string; game: string; variant: string | null; tcgplayer_id: number | null; scrydex_card_id: string | null; provider_card_id: string | null; last_mark: Date | null }>(
      `SELECT m.id, m.symbol, m.game, m.variant, m.tcgplayer_id, m.scrydex_card_id, m.provider_card_id,
              (SELECT max(k.computed_at) FROM marks k WHERE k.market_id = m.id) AS last_mark
         FROM markets m
        WHERE m.kind = 'card' AND m.featured AND m.status != 'delisted' AND NOT m.price_pinned
          AND (m.scrydex_card_id IS NOT NULL OR m.provider_card_id IS NOT NULL)`,
    )
  ).rows;
  const windows = dayWindows(days);
  const fx = await deps.fxJpyUsd();

  // The current Scrydex cards — to resolve each market's variant exactly as the live code does (batched credits).
  const sxCards = new Map<string, ScrydexCard>();
  const bySlug = new Map<string, string[]>();
  for (const c of cards) {
    const slug = c.scrydex_card_id ? scrydexSlug(c.game) : null;
    if (!slug) continue;
    const ids = bySlug.get(slug) ?? [];
    ids.push(c.scrydex_card_id!);
    bySlug.set(slug, ids);
  }
  for (const [slug, ids] of bySlug) {
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 100) {
      for (const card of await deps.scrydexCards(slug, unique.slice(i, i + 100))) sxCards.set(card.id, card);
      plan.calls.scrydexBatch++;
    }
  }

  let done = 0;
  await inPool(cards, PROVIDER_CONCURRENCY, async (c) => {
    if (++done % 50 === 0) log(`  …${done}/${cards.length} cards`);
    const slug = c.scrydex_card_id ? scrydexSlug(c.game) : null;
    const sxCard = c.scrydex_card_id ? sxCards.get(c.scrydex_card_id) : undefined;
    const add = (day: string, raw: number | null, psa10: number | null, source: BackfillRow['source'], sourceDate: string | null, miss: string) => {
      if (!c.last_mark || c.last_mark.getTime() <= atOf(day).getTime()) {
        plan.misses.push({ symbol: c.symbol, reason: `no mark after ${day} — a backfilled mark would become the live mark` });
        return;
      }
      if (raw != null && sourceDate) plan.rows.push({ marketId: c.id, symbol: c.symbol, day, priceE6: toE6(raw), gradedE6: psa10 != null && psa10 > 0 ? toE6(psa10) : null, source, sourceDate });
      else plan.misses.push({ symbol: c.symbol, reason: miss });
    };
    if (slug && sxCard) {
      const variant = extractRaw(sxCard, c.tcgplayer_id, c.variant)?.variant ?? null;
      const byDay = new Map<string, ScrydexHistoryDay>();
      for (const [a, b] of windows) {
        for (const d of await deps.scrydexHistory(slug, sxCard.id, a, b)) byDay.set(d.date, d);
        plan.calls.scrydexHistory++;
      }
      for (const day of days) {
        const h = byDay.get(day);
        const p = h ? scrydexDayPrice(h, c.tcgplayer_id, variant, fx) : { raw: null, psa10: null };
        add(day, p.raw, p.psa10, 'scrydex', day, `scrydex: no ${variant ?? '?'} raw price on ${day}`);
      }
    } else if (c.provider_card_id) {
      const points = await deps.tcgplHistory(c.provider_card_id);
      plan.calls.tcgplHistory++;
      for (const day of days) {
        const p = tcgplDayPrice(points, day);
        add(day, p.raw, p.psa10, 'tcgpl', p.date, `tcgpl: no TCGplayer point within ${TPL_MAX_LAG_DAYS}d before ${day}`);
      }
    } else {
      plan.misses.push({ symbol: c.symbol, reason: 'no Scrydex card returned and no tcgpl id' });
    }
  });
  return plan;
}

/**
 * A plan as JSON (bigints as strings). The dry run saves it and --apply --plan writes exactly the reviewed rows — no
 * second paid fetch (one fetch of every featured card's history is ~710 Scrydex requests; two don't fit the
 * discovery tier's daily ceiling).
 */
export const serializeBackfillPlan = (plan: BackfillPlan): string =>
  JSON.stringify(plan, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);

export function parseBackfillPlan(json: string): BackfillPlan {
  const plan = JSON.parse(json) as BackfillPlan;
  plan.rows = plan.rows.map((r) => ({ ...r, priceE6: BigInt(r.priceE6), gradedE6: r.gradedE6 == null ? null : BigInt(r.gradedE6) }));
  return plan;
}

/**
 * Drop each row at least `outlierFactor`× off EVERY accepted print of its market on either side of its timestamp
 * (the nearest before, the nearest after) — the index chain guard's own bound (chainStep) — as it would be a spike in
 * the card's chart and the index rebuild. A row with no such neighbour is kept; a real move across the gap matches one
 * side and is kept. Earlier backfill prints are never neighbours, or a re-run would chain a row it dropped off one it
 * kept. Only the raw price is screened: a kept row's PSA-10 rides along (a ≥2× graded jump is the chain guard's job).
 * Read-only.
 */
export async function screenBackfillPlan(q: Queryer, plan: BackfillPlan, outlierFactor: number): Promise<{ plan: BackfillPlan; dropped: BackfillPlan['misses'] }> {
  if (!plan.rows.length) return { plan, dropped: [] };
  const nb = await q.query<{ i: number; prev: string | null; prev_at: Date | null; next: string | null; next_at: Date | null }>(
    `SELECT u.i::int AS i, p.v AS prev, p.t AS prev_at, n.v AS next, n.t AS next_at
       FROM unnest($1::text[], $2::timestamptz[]) WITH ORDINALITY AS u(m, t, i)
       LEFT JOIN LATERAL (SELECT index_price_e6::text AS v, source_observed_at AS t FROM oracle_prices
                           WHERE market_id = u.m AND is_accepted AND raw_payload->'backfill' IS NULL AND source_observed_at < u.t
                           ORDER BY source_observed_at DESC LIMIT 1) p ON true
       LEFT JOIN LATERAL (SELECT index_price_e6::text AS v, source_observed_at AS t FROM oracle_prices
                           WHERE market_id = u.m AND is_accepted AND raw_payload->'backfill' IS NULL AND source_observed_at > u.t
                           ORDER BY source_observed_at LIMIT 1) n ON true
      ORDER BY u.i`,
    [plan.rows.map((r) => r.marketId), plan.rows.map((r) => atOf(r.day).toISOString())],
  );
  const rows: BackfillRow[] = [];
  const dropped: BackfillPlan['misses'] = [];
  for (const n of nb.rows) {
    const r = plan.rows[n.i - 1];
    const v = fromE6(r.priceE6);
    const sides = [
      n.prev != null ? { usd: fromE6(BigInt(n.prev)), at: n.prev_at! } : null,
      n.next != null ? { usd: fromE6(BigInt(n.next)), at: n.next_at! } : null,
    ].filter((x) => x != null);
    if (sides.length && sides.every((x) => Math.max(v / x.usd, x.usd / v) >= outlierFactor)) {
      const fmt = (x: { usd: number; at: Date }) => `$${x.usd} on ${x.at.toISOString().slice(0, 10)}`;
      dropped.push({ symbol: r.symbol, reason: `${r.day}: ${r.source} $${v} is ≥${outlierFactor}× off its neighbours (${sides.map(fmt).join(' / ')})` });
    } else rows.push(r);
  }
  return { plan: { ...plan, rows }, dropped };
}

/**
 * Write the planned prints + card marks (06:00 UTC on the gap day), reversible by run id. The plan is screened again
 * against the DB as it is now (screenBackfillPlan), and a market pinned or delisted since the plan (a saved plan can
 * be hours old) is skipped.
 */
export async function applyBackfill(db: Db, saved: BackfillPlan, outlierFactor: number): Promise<{ runId: string; points: number; screenedOut: number }> {
  const { plan, dropped } = await screenBackfillPlan(db, saved, outlierFactor);
  const runId = newRepairRunId('backfill');
  const skip = new Set(
    (
      await db.query<{ id: string }>(
        `SELECT id FROM markets WHERE id = ANY($1::text[]) AND (price_pinned OR status = 'delisted')`,
        [[...new Set(plan.rows.map((r) => r.marketId))]],
      )
    ).rows.map((r) => r.id),
  );
  const points = await db.tx((q) =>
    insertHistoricalPoints(
      q,
      runId,
      plan.rows.filter((r) => !skip.has(r.marketId)).map((r) => ({
        marketId: r.marketId,
        valueE6: r.priceE6,
        at: atOf(r.day),
        // PSA-10 rides as the provider-neutral gradedE6 the index rebuild reads.
        payload: { backfill: { runId, source: r.source, sourceDate: r.sourceDate }, ...(r.gradedE6 != null ? { gradedE6: r.gradedE6.toString() } : {}) },
      })),
    ),
  );
  return { runId, points, screenedOut: dropped.length };
}
