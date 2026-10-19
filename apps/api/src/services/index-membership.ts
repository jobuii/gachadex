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
 *   4. between dates (R5/D3, decision B): a member with a cause leaves; the basket is kept at its size (set at launch
 *      and at each change) from the reserves, then the best card that may join now — on this pass or a later one.
 * Everything is idempotent: one change per basket per month (unique key), applied_at claimed atomically, at most one
 * open membership per basket and market (partial unique index).
 */
import { INDEX_CATALOG, DEFAULT_CAP_BPS } from '@pokex/shared-types';
import type { Db, Queryer } from '../db/client.ts';
import { config } from '../config.ts';
import { indexSymbol } from './markets.ts';
import { productTypeOfMarket, type ProductType } from './product-type.ts';
import { basketKey, mayJoin, reconstitute, substitutes, tierRules, type Candidate, type TierRules } from './index-rules.ts';
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
 *  member) is NOT relaunched from that stale snapshot: it stays governed and refills from the cards that may join now
 *  (decision C, removeForCause) — empty, it holds its level, never the old top-N rule. */
async function launchIfNew(db: Db, b: GovernedBasket, now: Date): Promise<void> {
  if ((await basketState(db, b.key)) === 'governed') return; // open members, or emptied by causes (C: refills instead)
  const snap = await db.query<{ id: string }>(
    `SELECT DISTINCT ON (ic.card_id) m.id
       FROM index_constituents ic
       JOIN markets im ON im.id = ic.market_id AND im.symbol = $1
       JOIN markets m ON m.card_id = ic.card_id AND m.kind = 'card' AND m.game = $2
      ORDER BY ic.card_id, (m.status = 'delisted'), m.featured DESC, m.id`,
    [b.gjSymbol, b.game],
  );
  await db.tx(async (q) => {
    await join(q, b.key, snap.rows.map((r) => r.id), now, 'launch');
    await setSize(q, b.key, now);
  });
}

/** Decision B: the size the basket keeps until the next change — `size`, or its member count right now (a launch). */
async function setSize(q: Queryer, key: string, at: Date, size?: number): Promise<void> {
  await q.query(
    `INSERT INTO index_basket_size(basket, size, set_at)
     SELECT $1, COALESCE($3::int, (SELECT count(*)::int FROM index_members WHERE basket = $1 AND left_at IS NULL)), $2
     ON CONFLICT (basket) DO UPDATE SET size = EXCLUDED.size, set_at = EXCLUDED.set_at`,
    [key, at, size ?? null],
  );
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
  const removes = [...r.removes, ...ineligible];
  await db.query(
    `INSERT INTO index_changes(basket, change_date, reference_at, published_at, effective_at, adds, removes, reserves, size)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (basket, change_date) DO NOTHING`,
    [b.key, changeDate, referenceAt, now, effectiveAt, r.adds, JSON.stringify(removes), r.reserves, members.size - removes.length + r.adds.length],
  );
}

/** Apply a published change whose time has come; each addition is re-checked against R3 and backed by the reserves.
 *  Claimed with the applied_at check in the UPDATE itself, so two overlapping passes can't both apply it. */
async function applyIfDue(db: Db, b: GovernedBasket, now: Date): Promise<void> {
  await db.tx(async (q) => {
    const due = (
      await q.query<{ id: string; adds: string[]; removes: { marketId: string; reason: string }[]; reserves: string[]; size: number | null }>(
        `UPDATE index_changes SET applied_at = $3
          WHERE applied_at IS NULL AND NOT cancelled
            AND id = (SELECT id FROM index_changes WHERE basket = $1 AND applied_at IS NULL AND NOT cancelled AND effective_at <= $2 ORDER BY change_date LIMIT 1)
          RETURNING id, adds, removes, reserves, size`,
        [b.key, now, now],
      )
    ).rows[0];
    if (!due) return;
    const members = await currentMembers(q, b.key);
    const removes = due.removes.filter((r) => members.has(r.marketId));
    const removing = new Set(removes.map((r) => r.marketId));
    const cands = await loadCandidates(q, b, now, 'only', [...due.adds, ...due.reserves, ...members], members, await exclusions(q));
    const may = new Map(cands.map((c) => [c.marketId, mayJoin(c)]));
    // R12 at apply too: a refill since the publish may hold another printing of an add's product
    const product = new Map(cands.map((c) => [c.marketId, c.productKey]));
    const held = new Set(cands.filter((c) => c.member && !removing.has(c.marketId)).map((c) => c.productKey));
    const fits = (id: string) => may.get(id) === true && !held.has(product.get(id)!);
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
      const pick = fits(id) ? id : reserves.find((r) => fits(r) && !adds.includes(r));
      if (pick) { adds.push(pick); held.add(product.get(pick)!); }
    }
    await leave(q, b.key, removes, now);
    await join(q, b.key, adds, now, 'change');
    // the size the change describes — whether or not each add could join now, and whatever gap a cause opened since —
    // so a shortfall is topped up from the reserves and the pool, later this pass or on a later one (B)
    const intended = due.size ?? members.size - removes.length + due.adds.filter((id) => !members.has(id)).length;
    await setSize(q, b.key, now, Math.min(b.rules.n, intended));
  });
}

/** R5 + D3 between change dates: a member with a cause (or removed by hand, or no longer a single of this game) leaves.
 *  Decision B: the basket is kept at its size (index_basket_size) — reserves first, then the best card that may join
 *  now — on this pass, or on a later one if nothing may join yet. Slots of the announced change's removes stay free
 *  for its adds, and a card that left for a cause since the last change (this era) comes back only at a change date
 *  (R11). C: a launched basket that lost every member stays governed; it refills as a fresh start (decision 2026-10-19:
 *  e.g. after an outage staled every card) — the best cards that may join now, the R11 bar lifted, no reserves first. */
async function removeForCause(db: Db, b: GovernedBasket, now: Date): Promise<void> {
  const members = await currentMembers(db, b.key);
  if (!members.size && (await basketState(db, b.key)) !== 'governed') return;
  // the current era: since the latest launch — an earlier era's changes, reserves and switch-off closes don't count
  const eraStart = (await db.query<{ t: Date | null }>(
    `SELECT max(joined_at) AS t FROM index_members WHERE basket = $1 AND join_reason = 'launch'`, [b.key],
  )).rows[0].t;
  if (!eraStart) return;
  const latest = (
    await db.query<{
      reserves: string[]; adds: string[]; pending: boolean; removes: { marketId: string }[]; size: number | null; published_at: Date;
      bar_from: Date | null; announced_in: string[]; announced_out: string[];
    }>(
      `SELECT reserves, adds, (applied_at IS NULL) AS pending, removes, size, published_at,
              -- R11's window opens at the publish of the latest APPLIED change (as applyIfDue bars its reserves)
              (SELECT published_at FROM index_changes WHERE basket = $1 AND applied_at >= $2 ORDER BY applied_at DESC LIMIT 1) AS bar_from,
              -- every card any not-yet-applied change announces in or out: no refill takes or re-adds one before it applies
              ARRAY(SELECT unnest(c.adds) FROM index_changes c
                     WHERE c.basket = $1 AND c.applied_at IS NULL AND NOT c.cancelled AND c.published_at >= $2) AS announced_in,
              ARRAY(SELECT jsonb_array_elements(c.removes)->>'marketId' FROM index_changes c
                     WHERE c.basket = $1 AND c.applied_at IS NULL AND NOT c.cancelled AND c.published_at >= $2) AS announced_out
         FROM index_changes WHERE basket = $1 AND NOT cancelled AND published_at >= $2 ORDER BY change_date DESC LIMIT 1`,
      [b.key, eraStart],
    )
  ).rows[0];
  const cands = await loadCandidates(db, b, now, 'only', [...members, ...(latest?.reserves ?? [])], members, await exclusions(db));
  const seen = new Set(cands.map((c) => c.marketId));
  const leaving = [
    ...cands.filter((c) => c.member && (c.excluded || c.cause)).map((c) => ({ marketId: c.marketId, reason: c.excluded ? 'hand' : c.cause! })),
    ...[...members].filter((id) => !seen.has(id)).map((marketId) => ({ marketId, reason: 'ineligible' })),
  ];
  const restart = leaving.length === members.size; // empty, or emptying on this pass
  // R11: a card that left since the latest applied change was published (or since launch, before the first) is back
  // only when a later change applies — not on the 1st, when the next one is only announced (its adds join with notice,
  // at apply). A fresh start (C) resets it: nobody is barred for leaving up to it (its own pass included), on that pass
  // or the ones that finish the refill.
  const leftSince = restart ? new Set<string>() : new Set((await db.query<{ market_id: string }>(
    `SELECT market_id FROM index_members WHERE basket = $1 AND left_at IS NOT NULL AND left_at >= $2
        AND left_at > COALESCE((SELECT max(joined_at) FROM index_members WHERE basket = $1 AND join_reason = 'restart'), '-infinity'::timestamptz)`,
    [b.key, latest?.bar_from ?? eraStart],
  )).rows.map((r) => r.market_id));
  const reserves = restart ? [] : (latest?.reserves ?? []).filter((id) => !leftSince.has(id));
  const leavingIds = new Set(leaving.map((l) => l.marketId));
  // the announced change's adds join at apply, with notice (R1) — never early as a refill, nor another printing of
  // theirs (R12). Until it applies, the basket is filled only up to what it will hold AFTER it: its adds counted in,
  // its removes out, against the size it describes.
  const pending = latest?.pending ? latest : null;
  const pendingAdds = pending ? pending.adds.filter((id) => !members.has(id)) : [];
  const announcedIn = new Set((latest?.announced_in ?? []).filter((id) => !members.has(id)));
  const announced = new Set([...announcedIn, ...(latest?.announced_out ?? [])]);
  const staying = new Set([...members].filter((id) => !leavingIds.has(id)));
  const projected = staying.size + pendingAdds.length - (pending ? pending.removes.filter((r) => staying.has(r.marketId)).length : 0);
  let row = (await db.query<{ size: number; set_at: Date }>(`SELECT size, set_at FROM index_basket_size WHERE basket = $1`, [b.key])).rows[0];
  if (!row) {
    // a basket launched before sizes were kept: its members now, plus the change's removes already out — stored, so
    // a gap nothing can fill yet is still owed on a later pass
    const size = members.size + (pending ? pending.removes.filter((r) => !members.has(r.marketId)).length : 0);
    await setSize(db, b.key, now, size);
    row = { size, set_at: now };
  }
  // a fresh start (C) aims for N, like a launch takes the whole live basket — and keeps aiming for it (its size row)
  // until the next change applies, even if that change was published before it
  const restartedSincePublish = pending != null && new Date(row.set_at).getTime() > new Date(pending.published_at).getTime();
  const target = restart ? b.rules.n : Math.min(b.rules.n, pending && !restartedSincePublish ? (pending.size ?? row.size) : row.size);
  const toReplace = Math.max(0, Math.min(target - projected, b.rules.n - staying.size)); // and never past N
  const pool = toReplace > 0 ? await loadCandidates(db, b, now, 'pool', [...members, ...reserves, ...announced], members, await exclusions(db)) : [];
  const held = new Set(pool.filter((c) => (c.member && !leavingIds.has(c.marketId)) || announcedIn.has(c.marketId)).map((c) => c.productKey));
  const subs = substitutes(pool, reserves, toReplace, new Set([...leftSince, ...leavingIds, ...announced]), held);
  if (!leaving.length && !subs.length) return;
  const fromReserve = new Set(reserves);
  await db.tx(async (q) => {
    await leave(q, b.key, leaving, now);
    await join(q, b.key, subs.filter((id) => fromReserve.has(id)), now, 'reserve');
    await join(q, b.key, subs.filter((id) => !fromReserve.has(id)), now, restart ? 'restart' : 'refill');
    // a fresh start aims for N until the next change sets the size: cards still coming back (an outage ends unevenly)
    // keep joining on later passes
    if (restart && subs.length) await setSize(q, b.key, now, b.rules.n);
  });
}

/** Whether the rules govern a basket now: 'governed' once launched (an open member, or its last membership closed for a
 *  cause), 'off' when its lists were closed by the switch-off, 'new' when never launched. */
async function basketState(q: Queryer, key: string): Promise<'governed' | 'off' | 'new'> {
  // the latest event: an open membership wins; else the latest close — a membership's (its reason) or a switch-off marker
  const r = (await q.query<{ open: boolean; reason: string | null }>(
    `SELECT open, reason FROM (
       SELECT left_at IS NULL AS open, leave_reason AS reason, COALESCE(left_at, 'infinity'::timestamptz) AS t FROM index_members WHERE basket = $1
       UNION ALL SELECT false, 'rules-off', at FROM index_rules_off WHERE basket = $1
     ) e ORDER BY open DESC, t DESC, (reason = 'rules-off') DESC LIMIT 1`,
    [key],
  )).rows[0];
  if (!r) return 'new';
  return r.open || r.reason !== 'rules-off' ? 'governed' : 'off';
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
  const emptied: string[] = []; // governed while empty (C): no open row to close, so they get the switch-off marker
  for (const b of governedBaskets()) if ((await basketState(db, b.key)) === 'governed' && !(await currentMembers(db, b.key)).size) emptied.push(b.key);
  if (!open.rows.length && !pending.rows.length && !emptied.length) return; // nothing to close: no write
  await db.tx(async (q) => {
    await q.query(`UPDATE index_members SET left_at = $1, leave_reason = 'rules-off' WHERE left_at IS NULL`, [now]);
    await q.query(`UPDATE index_changes SET cancelled = true WHERE applied_at IS NULL AND NOT cancelled`);
    for (const key of emptied) await q.query(`INSERT INTO index_rules_off(basket, at) VALUES($1, $2)`, [key, now]);
  });
}

/** One membership row with its card id — the whole history, for an as-of read (live pass or history rebuild). */
export interface MembershipRow {
  basket: string;
  cardId: string;
  joinedAt: Date;
  leftAt: Date | null;
  leaveReason: string | null;
}

export async function loadMembershipRows(q: Queryer): Promise<MembershipRow[]> {
  // + each switch-off marker of an emptied basket (C), as a zero-length close with reason 'rules-off'
  const r = await q.query<{ basket: string; card_id: string; joined_at: Date; left_at: Date | null; leave_reason: string | null }>(
    `SELECT im.basket, m.card_id, im.joined_at, im.left_at, im.leave_reason FROM index_members im JOIN markets m ON m.id = im.market_id WHERE m.card_id IS NOT NULL
     UNION ALL SELECT basket, '', at, at, 'rules-off' FROM index_rules_off`,
  );
  return r.rows.map((x) => ({
    basket: x.basket, cardId: x.card_id, joinedAt: new Date(x.joined_at), leftAt: x.left_at ? new Date(x.left_at) : null, leaveReason: x.leave_reason,
  }));
}

/** The member lists as of `at`, by basket, as card ids — for every basket the rules governed at that moment: one with an
 *  open membership, or one whose last membership closed for a cause (C: governed while empty — buildBaskets then holds
 *  its level, never the old top-N rule). Absent = never launched, or switched off ('rules-off'): the old rule. */
export function membershipAsOf(rows: MembershipRow[], at: Date): Map<string, Set<string>> {
  const t = at.getTime();
  const out = new Map<string, Set<string>>();
  const lastClose = new Map<string, { at: number; reason: string | null }>();
  for (const r of rows) {
    if (r.joinedAt.getTime() > t) continue;
    if (r.leftAt != null && r.leftAt.getTime() <= t) {
      const was = lastClose.get(r.basket);
      if (!was || r.leftAt.getTime() > was.at) lastClose.set(r.basket, { at: r.leftAt.getTime(), reason: r.leaveReason });
      continue;
    }
    let s = out.get(r.basket);
    if (!s) out.set(r.basket, (s = new Set()));
    s.add(r.cardId);
  }
  for (const [basket, close] of lastClose) if (!out.has(basket) && close.reason !== 'rules-off') out.set(basket, new Set());
  return out;
}

export interface BasketView {
  basket: string;
  governed: boolean; // false = the old rule (v3 not on for this basket yet, or switched off); true even while empty (C)
  members: { marketId: string; symbol: string; name: string; joinedAt: string; joinReason: string; priceE6: string | null; weightBps: number | null }[];
  upcoming: { changeDate: string; effectiveAt: string; adds: { marketId: string; name: string }[]; removes: { marketId: string; name: string; reason: string }[] } | null;
  // decision D: what each change actually did — who joined and left when it applied — plus announced cards that didn't join
  log: { changeDate: string; appliedAt: string; adds: { marketId: string; name: string }[]; removes: { marketId: string; name: string; reason: string }[]; notJoined: { marketId: string; name: string }[] }[];
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
  const applied = changes.filter((c) => c.applied_at != null).slice(0, 12);
  // the moves of each applied change: rows that joined or left at its applied_at, plus every row of its announced adds
  const moves = (
    await q.query<{ market_id: string; joined_at: Date; left_at: Date | null; join_reason: string; leave_reason: string | null }>(
      `SELECT market_id, joined_at, left_at, join_reason, leave_reason FROM index_members
        WHERE basket = $1 AND (joined_at = ANY($2::timestamptz[]) OR left_at = ANY($2::timestamptz[]) OR market_id = ANY($3))`,
      [key, applied.map((c) => c.applied_at), applied.flatMap((c) => c.adds)],
    )
  ).rows;
  const ids = [...new Set([...changes.flatMap((c) => [...c.adds, ...c.removes.map((r) => r.marketId)]), ...moves.map((m) => m.market_id)])];
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
    governed: (await basketState(q, key)) === 'governed',
    members: members.map((m) => ({
      marketId: m.market_id, symbol: m.symbol, name: m.display_name, joinedAt: new Date(m.joined_at).toISOString(), joinReason: m.join_reason,
      priceE6: px.get(m.card_id)?.toString() ?? null, weightBps: weightBps(m.card_id),
    })),
    upcoming: pending ? { changeDate: pending.change_date, effectiveAt: new Date(pending.effective_at).toISOString(), ...named(pending) } : null,
    log: applied.map((c) => {
      const at = new Date(c.applied_at!).getTime();
      const t = (d: Date | null) => (d == null ? null : new Date(d).getTime());
      // what the change itself did: its joins ('change'), and its announced removes closed at apply — not the
      // cause moves the same pass made afterwards (removeForCause shares the timestamp)
      const announcedOut = new Set(c.removes.map((r) => r.marketId));
      const joined = moves.filter((m) => t(m.joined_at) === at && m.join_reason === 'change').map((m) => m.market_id);
      const left = moves.filter((m) => t(m.left_at) === at && announcedOut.has(m.market_id));
      // an announced add already in at apply (it joined meanwhile as a reserve or refill) did join — just earlier
      const inBefore = (id: string) => moves.some((m) => m.market_id === id && t(m.joined_at)! < at && (m.left_at == null || t(m.left_at)! >= at));
      const nm = (id: string) => ({ marketId: id, name: names.get(id) ?? id });
      return {
        changeDate: c.change_date, appliedAt: new Date(at).toISOString(),
        adds: joined.map(nm),
        removes: left.map((m) => ({ ...nm(m.market_id), reason: m.leave_reason ?? '' })),
        notJoined: c.adds.filter((id) => !joined.includes(id) && !inBefore(id)).map(nm),
      };
    }),
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
