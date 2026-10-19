/**
 * Index membership v3 (INDEX_RULES_V3) — the DB side of index-rules.ts. Called once per price pass, BEFORE the
 * baskets are built (oracle.ts ingest), so a change takes effect between two passes (R8): this pass's return is
 * measured on the previous basket snapshot, and the new member list is what gets snapshotted.
 *
 * Per governed basket (game + tier, not Sealed), in order:
 *   1. launch (R10): no member rows ever → the members are the live basket of this moment (the GJ series snapshot);
 *   2. publish (R1): on/after 00:00 UTC on the 1st, if this month has no change yet and the basket launched before
 *      that time → rank as of 00:00 on the 1st, record adds / removes / reserves, effective at the first pass at or
 *      after max(the 4th, published + INDEX_NOTICE_HOURS);
 *   3. apply a due change: each announced addition is checked again and replaced by the next reserve if it no longer
 *      may join (R7);
 *   4. between dates (R5/D3): a member with a cause leaves; the best reserve that may join now takes its place.
 * Everything is idempotent: one change per basket per month (unique key), applied_at claimed atomically, at most one
 * open membership per basket and market (partial unique index).
 */
import { INDEX_CATALOG, DEFAULT_CAP_BPS } from '@pokex/shared-types';
import type { Db, Queryer } from '../db/client.ts';
import { config } from '../config.ts';
import { indexSymbol } from './markets.ts';
import { productTypeOfMarket, type ProductType } from './product-type.ts';
import { basketKey, mayJoin, reconstitute, tierRules, type Candidate, type TierRules } from './index-rules.ts';
import { cappedWeights, weightingOf } from './index-weighting.ts';

const DAY_MS = 86_400_000;

export interface GovernedBasket {
  key: string; // 'pokemon:top-100'
  game: string;
  tier: string;
  rules: TierRules;
  gjSymbol: string; // the GJ series of this basket (its snapshot seeds the launch)
}

/** Every catalog game × tier that v3 governs (Sealed keeps the old rule). */
export function governedBaskets(): GovernedBasket[] {
  const out = new Map<string, GovernedBasket>();
  for (const idx of INDEX_CATALOG) {
    const rules = tierRules(idx.tier, config.gradedConstituents, config.indexStayPct);
    const key = basketKey(idx.game, idx.tier);
    if (rules && !out.has(key)) out.set(key, { key, game: idx.game, tier: idx.tier, rules, gjSymbol: indexSymbol(idx.game, idx.tier) });
  }
  return [...out.values()];
}

/** R1: this month's change date, its reference time (00:00 UTC on the 1st) and the earliest effective time (the 4th). */
export function monthSchedule(now: Date): { changeDate: string; referenceAt: Date; earliestEffective: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const referenceAt = new Date(Date.UTC(y, m, 1));
  return { changeDate: referenceAt.toISOString().slice(0, 10), referenceAt, earliestEffective: new Date(Date.UTC(y, m, 4)) };
}

interface CandidateRow {
  id: string;
  tcgplayer_id: string | null;
  display_name: string;
  rarity: string | null;
  product_type: string | null;
  featured: boolean;
  status: string;
  low_confidence: boolean;
  graded_psa10_e6: string | null;
  price_e6: string | null;
  last_print_at: Date | null;
  first_live_at: Date | null;
  gp: string | null;
  gp_rows: number;
  gp_null_since: Date | null;
}

/**
 * R3/R5 inputs as of `at`. scope 'pool' = the game's featured singles plus `include` (a change date's ranking pool);
 * 'only' = just `include` (members + reserves between dates — cheap, every pass). A Graded non-member without a
 * PSA-10 is not a candidate at all (R2 ranks Graded among cards WITH a PSA-10).
 */
async function loadCandidates(
  q: Queryer, b: GovernedBasket, at: Date, scope: 'pool' | 'only', include: string[], members: Set<string>, excluded: Set<string>,
): Promise<Candidate[]> {
  const rows = (
    await q.query<CandidateRow>(
      `SELECT m.id, m.tcgplayer_id::text AS tcgplayer_id, m.display_name, m.metadata->>'rarity' AS rarity, m.product_type,
              m.featured, m.status, m.low_confidence, m.graded_psa10_e6::text AS graded_psa10_e6,
              (SELECT o.index_price_e6::text FROM oracle_prices o WHERE o.market_id = m.id AND o.is_accepted AND o.ingested_at <= $3
                ORDER BY o.ingested_at DESC, o.id DESC LIMIT 1) AS price_e6,
              (SELECT max(o.ingested_at) FROM oracle_prices o WHERE o.market_id = m.id AND o.is_accepted AND o.ingested_at <= $3) AS last_print_at,
              (SELECT min(o.ingested_at) FROM oracle_prices o WHERE o.market_id = m.id AND o.is_accepted AND NOT COALESCE(o.raw_payload ? 'backfill', false)) AS first_live_at,
              (SELECT g.graded_e6::text FROM graded_prints g WHERE g.market_id = m.id AND g.observed_at <= $3 ORDER BY g.id DESC LIMIT 1) AS gp,
              (SELECT count(*)::int FROM graded_prints g WHERE g.market_id = m.id) AS gp_rows,
              -- when the PSA-10 went missing: the first NULL row after the last real one (rows are written on change only)
              (SELECT min(g.observed_at) FROM graded_prints g
                WHERE g.market_id = m.id AND g.graded_e6 IS NULL AND g.observed_at <= $3
                  AND g.observed_at > COALESCE((SELECT max(g2.observed_at) FROM graded_prints g2
                                                 WHERE g2.market_id = m.id AND g2.graded_e6 IS NOT NULL AND g2.observed_at <= $3), '-infinity'::timestamptz)) AS gp_null_since
         FROM markets m
        WHERE m.kind = 'card' AND m.game = $1 AND (m.id = ANY($2) OR ($4 AND m.featured))`,
      [b.game, include, at, scope === 'pool'],
    )
  ).rows;
  const graded = b.tier === 'graded';
  const t = at.getTime();
  const staleLimit = config.indexStaleRemoveDays * DAY_MS;
  const out: Candidate[] = [];
  for (const r of rows) {
    const productType = (r.product_type as ProductType | null) ?? productTypeOfMarket(r.display_name, r.rarity);
    if (productType !== 'single') continue;
    const member = members.has(r.id);
    const psa10Raw = r.gp_rows > 0 ? r.gp : r.graded_psa10_e6; // graded_prints once it has rows, else the stored value
    const psa10 = psa10Raw != null ? BigInt(psa10Raw) : null;
    const hasPsa10 = psa10 != null && psa10 > 0n;
    if (graded && !member && !hasPsa10) continue;
    const price = r.price_e6 != null ? BigInt(r.price_e6) : 0n;
    const last = r.last_print_at ? new Date(r.last_print_at).getTime() : null;
    const fresh = last != null && t - last < config.indexFreshMs;
    const seasoned = r.first_live_at != null && new Date(r.first_live_at).getTime() <= t - config.indexSeasoningDays * DAY_MS;
    let cause: string | null = null;
    if (r.status === 'delisted') cause = 'delisted';
    else if (last == null || t - last >= staleLimit) cause = 'stale';
    else if (graded && !hasPsa10 && r.gp_null_since != null && t - new Date(r.gp_null_since).getTime() >= staleLimit) cause = 'no-psa10';
    out.push({
      marketId: r.id,
      productKey: r.tcgplayer_id ?? r.id,
      priceE6: price,
      member,
      canJoin: r.featured && r.status !== 'delisted' && r.status !== 'reduce_only' && !r.low_confidence && price > 0n && fresh && seasoned && (!graded || hasPsa10),
      cause,
      excluded: excluded.has(r.id),
    });
  }
  return out;
}

async function currentMembers(q: Queryer, key: string): Promise<Set<string>> {
  const r = await q.query<{ market_id: string }>(`SELECT market_id FROM index_members WHERE basket = $1 AND left_at IS NULL`, [key]);
  return new Set(r.rows.map((x) => x.market_id));
}

async function exclusions(q: Queryer): Promise<Set<string>> {
  return new Set((await q.query<{ market_id: string }>(`SELECT market_id FROM index_exclusions`)).rows.map((r) => r.market_id));
}

async function join(q: Queryer, key: string, marketIds: string[], at: Date, reason: string): Promise<void> {
  if (!marketIds.length) return;
  await q.query(
    `INSERT INTO index_members(basket, market_id, joined_at, join_reason)
     SELECT $1, u, $3, $4 FROM unnest($2::text[]) AS u ON CONFLICT DO NOTHING`,
    [key, marketIds, at, reason],
  );
}

async function leave(q: Queryer, key: string, removes: { marketId: string; reason: string }[], at: Date): Promise<void> {
  for (const r of removes) {
    await q.query(`UPDATE index_members SET left_at = $3, leave_reason = $4 WHERE basket = $1 AND market_id = $2 AND left_at IS NULL`, [key, r.marketId, at, r.reason]);
  }
}

/** R10: a basket that was never launched, or whose rules were switched off since, starts from the live basket of this
 *  moment — its GJ series snapshot — so nothing jumps. A basket emptied by causes (e.g. a provider outage staled every
 *  member) is NOT relaunched from that stale snapshot: it stays empty (the old rule prices it meanwhile) until the next
 *  change date refills it from the ranked pool. */
async function launchIfNew(db: Db, b: GovernedBasket, now: Date): Promise<void> {
  if ((await currentMembers(db, b.key)).size > 0) return;
  const last = (await db.query<{ leave_reason: string | null }>(
    `SELECT leave_reason FROM index_members WHERE basket = $1 ORDER BY left_at DESC NULLS FIRST, id DESC LIMIT 1`, [b.key],
  )).rows[0];
  if (last && last.leave_reason !== 'rules-off') return;
  const snap = await db.query<{ id: string }>(
    `SELECT DISTINCT ON (ic.card_id) m.id
       FROM index_constituents ic
       JOIN markets im ON im.id = ic.market_id AND im.symbol = $1
       JOIN markets m ON m.card_id = ic.card_id AND m.kind = 'card' AND m.game = $2
      ORDER BY ic.card_id, (m.status = 'delisted'), m.featured DESC, m.id`,
    [b.gjSymbol, b.game],
  );
  await db.tx((q) => join(q, b.key, snap.rows.map((r) => r.id), now, 'launch'));
}

/** R1: publish this month's change once the reference time has passed (only for a basket launched before it). */
async function publishIfDue(db: Db, b: GovernedBasket, now: Date): Promise<void> {
  const { changeDate, referenceAt, earliestEffective } = monthSchedule(now);
  const exists = await db.query(`SELECT 1 FROM index_changes WHERE basket = $1 AND change_date = $2`, [b.key, changeDate]);
  if (exists.rows.length) return;
  const launched = await db.query<{ t: Date | null }>(`SELECT max(joined_at) AS t FROM index_members WHERE basket = $1 AND join_reason = 'launch'`, [b.key]);
  const launchedAt = launched.rows[0].t;
  if (!launchedAt || new Date(launchedAt).getTime() >= referenceAt.getTime()) return; // R10: the first change is the next 1st
  const members = await currentMembers(db, b.key);
  const cands = await loadCandidates(db, b, referenceAt, 'pool', [...members], members, await exclusions(db));
  const r = reconstitute(cands, b.rules);
  const seen = new Set(cands.map((c) => c.marketId));
  const ineligible = [...members].filter((id) => !seen.has(id)).map((marketId) => ({ marketId, reason: 'ineligible' }));
  const effectiveAt = new Date(Math.max(earliestEffective.getTime(), now.getTime() + config.indexNoticeHours * 3_600_000));
  await db.query(
    `INSERT INTO index_changes(basket, change_date, reference_at, published_at, effective_at, adds, removes, reserves)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (basket, change_date) DO NOTHING`,
    [b.key, changeDate, referenceAt, now, effectiveAt, r.adds, JSON.stringify([...r.removes, ...ineligible]), r.reserves],
  );
}

/** Apply a published change whose time has come; each addition is re-checked against R3 and backed by the reserves.
 *  Claimed with the applied_at check in the UPDATE itself, so two overlapping passes can't both apply it. */
async function applyIfDue(db: Db, b: GovernedBasket, now: Date): Promise<void> {
  await db.tx(async (q) => {
    const due = (
      await q.query<{ id: string; adds: string[]; removes: { marketId: string; reason: string }[]; reserves: string[] }>(
        `UPDATE index_changes SET applied_at = $3
          WHERE applied_at IS NULL AND NOT cancelled
            AND id = (SELECT id FROM index_changes WHERE basket = $1 AND applied_at IS NULL AND NOT cancelled AND effective_at <= $2 ORDER BY change_date LIMIT 1)
          RETURNING id, adds, removes, reserves`,
        [b.key, now, now],
      )
    ).rows[0];
    if (!due) return;
    const members = await currentMembers(q, b.key);
    const removes = due.removes.filter((r) => members.has(r.marketId));
    const cands = await loadCandidates(q, b, now, 'only', [...due.adds, ...due.reserves], members, await exclusions(q));
    const may = new Map(cands.map((c) => [c.marketId, mayJoin(c)]));
    const room = b.rules.n - (members.size - removes.length); // never past N (a member may have left early for a cause)
    const adds: string[] = [];
    const leftSince = new Set((await q.query<{ market_id: string }>(
      `SELECT market_id FROM index_members WHERE basket = $1 AND left_at IS NOT NULL AND left_at >= (SELECT published_at FROM index_changes WHERE id = $2)`,
      [b.key, due.id],
    )).rows.map((r) => r.market_id));
    const reserves = due.reserves.filter((id) => !due.adds.includes(id) && !leftSince.has(id)); // R11: a leaver comes back only at a change date
    for (const id of due.adds) {
      if (adds.length >= room) break;
      if (members.has(id)) continue; // already in (e.g. joined as a reserve meanwhile): done, not failed
      if (may.get(id)) { adds.push(id); continue; }
      const sub = reserves.find((r) => may.get(r) && !adds.includes(r));
      if (sub) adds.push(sub);
    }
    await leave(q, b.key, removes, now);
    await join(q, b.key, adds, now, 'change');
  });
}

/** R5 + D3 between change dates: a member with a cause (or removed by hand, or no longer a single of this game) leaves;
 *  the best reserve that may join replaces it — unless the announced change already removes that member (its adds
 *  fill the slot), and never a reserve that already left this month (R11: back only at a change date). */
async function removeForCause(db: Db, b: GovernedBasket, now: Date): Promise<void> {
  const members = await currentMembers(db, b.key);
  if (!members.size) return;
  const latest = (
    await db.query<{ reserves: string[]; published_at: Date; pending: boolean; removes: { marketId: string }[] }>(
      `SELECT reserves, published_at, (applied_at IS NULL AND NOT cancelled) AS pending, removes
         FROM index_changes WHERE basket = $1 AND NOT cancelled ORDER BY change_date DESC LIMIT 1`,
      [b.key],
    )
  ).rows[0];
  const leftThisMonth = latest
    ? new Set((await db.query<{ market_id: string }>(
        `SELECT market_id FROM index_members WHERE basket = $1 AND left_at IS NOT NULL AND left_at >= $2`, [b.key, latest.published_at],
      )).rows.map((r) => r.market_id))
    : new Set<string>();
  const reserves = (latest?.reserves ?? []).filter((id) => !leftThisMonth.has(id));
  const pendingRemoves = new Set(latest?.pending ? latest.removes.map((r) => r.marketId) : []);
  const cands = await loadCandidates(db, b, now, 'only', [...members, ...reserves], members, await exclusions(db));
  const seen = new Set(cands.map((c) => c.marketId));
  const leaving = [
    ...cands.filter((c) => c.member && (c.excluded || c.cause)).map((c) => ({ marketId: c.marketId, reason: c.excluded ? 'hand' : c.cause! })),
    ...[...members].filter((id) => !seen.has(id)).map((marketId) => ({ marketId, reason: 'ineligible' })),
  ];
  if (!leaving.length) return;
  const byId = new Map(cands.map((c) => [c.marketId, c]));
  const toReplace = leaving.filter((l) => !pendingRemoves.has(l.marketId)).length;
  const subs = reserves.filter((id) => { const c = byId.get(id); return c != null && mayJoin(c); }).slice(0, toReplace);
  await db.tx(async (q) => {
    await leave(q, b.key, leaving, now);
    await join(q, b.key, subs, now, 'reserve');
  });
}

/** One v3 step per governed basket (each isolated: one basket's error never blocks the others or the pass); returns
 *  the member lists as card ids (what buildBaskets keys on). */
export async function runIndexRules(db: Db, now: Date): Promise<Map<string, Set<string>>> {
  for (const b of governedBaskets()) {
    try {
      await launchIfNew(db, b, now);
      await publishIfDue(db, b, now);
      await applyIfDue(db, b, now);
      await removeForCause(db, b, now);
    } catch (e) {
      console.error(`[index-rules] ${b.key}: ${(e as Error).message}`); // the pass goes on with the stored member list
    }
  }
  return membershipAsOf(await loadMembershipRows(db), now);
}

/** The rules switched OFF: close every open membership and cancel announced changes, so nothing stays locked, the old
 *  rule governs, and switching back on relaunches from the live baskets (R10) instead of reviving stale lists. */
export async function retireIndexRules(db: Db, now: Date): Promise<void> {
  const open = await db.query(`SELECT 1 FROM index_members WHERE left_at IS NULL LIMIT 1`);
  const pending = await db.query(`SELECT 1 FROM index_changes WHERE applied_at IS NULL AND NOT cancelled LIMIT 1`);
  if (!open.rows.length && !pending.rows.length) return; // nothing to close: no write
  await db.tx(async (q) => {
    await q.query(`UPDATE index_members SET left_at = $1, leave_reason = 'rules-off' WHERE left_at IS NULL`, [now]);
    await q.query(`UPDATE index_changes SET cancelled = true WHERE applied_at IS NULL AND NOT cancelled`);
  });
}

/** One membership row with its card id — the whole history, for an as-of read (live pass or history rebuild). */
export interface MembershipRow {
  basket: string;
  cardId: string;
  joinedAt: Date;
  leftAt: Date | null;
}

export async function loadMembershipRows(q: Queryer): Promise<MembershipRow[]> {
  const r = await q.query<{ basket: string; card_id: string; joined_at: Date; left_at: Date | null }>(
    `SELECT im.basket, m.card_id, im.joined_at, im.left_at FROM index_members im JOIN markets m ON m.id = im.market_id WHERE m.card_id IS NOT NULL`,
  );
  return r.rows.map((x) => ({ basket: x.basket, cardId: x.card_id, joinedAt: new Date(x.joined_at), leftAt: x.left_at ? new Date(x.left_at) : null }));
}

/** The member lists as of `at`, by basket, as card ids — for every basket the rules governed at that moment (an open
 *  membership covers it). Any other basket is absent and keeps the old top-N rule (never launched, or switched off). */
export function membershipAsOf(rows: MembershipRow[], at: Date): Map<string, Set<string>> {
  const t = at.getTime();
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.joinedAt.getTime() > t || (r.leftAt != null && r.leftAt.getTime() <= t)) continue;
    let s = out.get(r.basket);
    if (!s) out.set(r.basket, (s = new Set()));
    s.add(r.cardId);
  }
  return out;
}

export interface BasketView {
  basket: string;
  governed: boolean; // false = the old rule (v3 not on for this basket yet)
  members: { marketId: string; symbol: string; name: string; joinedAt: string; joinReason: string; priceE6: string | null; weightBps: number | null }[];
  upcoming: { changeDate: string; effectiveAt: string; adds: { marketId: string; name: string }[]; removes: { marketId: string; name: string; reason: string }[] } | null;
  log: { changeDate: string; appliedAt: string; adds: { marketId: string; name: string }[]; removes: { marketId: string; name: string; reason: string }[] }[];
}

/** R9: the public member list, upcoming change and change log of the basket behind an index market symbol. */
export async function indexBasketView(q: Queryer, symbol: string): Promise<BasketView | null> {
  const idx = (await q.query<{ id: string; game: string; index_slug: string }>(`SELECT id, game, index_slug FROM markets WHERE kind = 'index' AND symbol = $1`, [symbol])).rows[0];
  if (!idx) return null;
  const key = basketKey(idx.game, idx.index_slug.replace(/^(gp|pdq)-/, ''));
  const members = (
    await q.query<{ market_id: string; card_id: string; symbol: string; display_name: string; joined_at: Date; join_reason: string }>(
      `SELECT im.market_id, m.card_id, m.symbol, m.display_name, im.joined_at, im.join_reason
         FROM index_members im JOIN markets m ON m.id = im.market_id
        WHERE im.basket = $1 AND im.left_at IS NULL ORDER BY m.display_name`,
      [key],
    )
  ).rows;
  // this series' weights over its latest basket snapshot (weight_e6 holds each card's price — what the next pass
  // chains off): GJ price share, G&P equal, Pokedaq capped (index-weighting.ts); a member not in it shows "—"
  const snap = (await q.query<{ card_id: string; p: string }>(`SELECT card_id, weight_e6::text AS p FROM index_constituents WHERE market_id = $1`, [idx.id])).rows;
  const px = new Map(snap.map((r) => [r.card_id, BigInt(r.p)]));
  const cat = INDEX_CATALOG.find((c) => c.game === idx.game && c.slug === idx.index_slug);
  const weighting = weightingOf(cat ?? {});
  const w = weighting === 'capped'
    ? cappedWeights(snap.map((r) => ({ cardId: r.card_id, prevE6: BigInt(r.p) })), cat?.capBps ?? DEFAULT_CAP_BPS)
    : new Map(snap.map((r) => [r.card_id, weighting === 'equal' ? 1n : BigInt(r.p)]));
  const wSum = [...w.values()].reduce((a, x) => a + x, 0n);
  const weightBps = (cardId: string): number | null => {
    const x = w.get(cardId);
    return x == null || wSum <= 0n ? null : Number((x * 10_000n) / wSum);
  };
  const changes = (
    await q.query<{ change_date: string; effective_at: Date; applied_at: Date | null; adds: string[]; removes: { marketId: string; reason: string }[] }>(
      `SELECT change_date::text, effective_at, applied_at, adds, removes FROM index_changes WHERE basket = $1 AND NOT cancelled ORDER BY change_date DESC LIMIT 13`,
      [key],
    )
  ).rows;
  const ids = [...new Set(changes.flatMap((c) => [...c.adds, ...c.removes.map((r) => r.marketId)]))];
  const names = new Map(
    (await q.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM markets WHERE id = ANY($1)`, [ids])).rows.map((r) => [r.id, r.display_name]),
  );
  const named = (c: (typeof changes)[number]) => ({
    adds: c.adds.map((id) => ({ marketId: id, name: names.get(id) ?? id })),
    removes: c.removes.map((r) => ({ marketId: r.marketId, name: names.get(r.marketId) ?? r.marketId, reason: r.reason })),
  });
  const pending = changes.filter((c) => c.applied_at == null).at(-1); // the earliest (rows are newest first) — applyIfDue's next
  return {
    basket: key,
    governed: members.length > 0, // the rules govern it now (an open member list)
    members: members.map((m) => ({
      marketId: m.market_id, symbol: m.symbol, name: m.display_name, joinedAt: new Date(m.joined_at).toISOString(), joinReason: m.join_reason,
      priceE6: px.get(m.card_id)?.toString() ?? null, weightBps: weightBps(m.card_id),
    })),
    upcoming: pending ? { changeDate: pending.change_date, effectiveAt: new Date(pending.effective_at).toISOString(), ...named(pending) } : null,
    log: changes.filter((c) => c.applied_at != null).slice(0, 12).map((c) => ({ changeDate: c.change_date, appliedAt: new Date(c.applied_at!).toISOString(), ...named(c) })),
  };
}

/** R11: remove a card by hand (out of every basket at the next pass, until cleared) / clear it / list them. */
export async function excludeFromIndices(q: Queryer, marketId: string, reason: string): Promise<void> {
  await q.query(
    `INSERT INTO index_exclusions(market_id, reason) VALUES($1, $2) ON CONFLICT (market_id) DO UPDATE SET reason = EXCLUDED.reason`,
    [marketId, reason],
  );
}

export async function clearIndexExclusion(q: Queryer, marketId: string): Promise<boolean> {
  return ((await q.query(`DELETE FROM index_exclusions WHERE market_id = $1 RETURNING market_id`, [marketId])).rows.length) > 0;
}

export async function listIndexExclusions(q: Queryer): Promise<{ marketId: string; name: string; reason: string; createdAt: string }[]> {
  const r = await q.query<{ market_id: string; display_name: string; reason: string; created_at: Date }>(
    `SELECT e.market_id, m.display_name, e.reason, e.created_at FROM index_exclusions e JOIN markets m ON m.id = e.market_id ORDER BY e.created_at DESC`,
  );
  return r.rows.map((x) => ({ marketId: x.market_id, name: x.display_name, reason: x.reason, createdAt: new Date(x.created_at).toISOString() }));
}
