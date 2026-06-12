import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { cardSymbol, upsertCardMarket } from '../markets.ts';
import { toCardUpsert } from '../oracle.ts';
import { rawPriceUsd, fromTplCard, tplTcgplayerId, MIN_LIST_PRICE_USD, type TcgPriceLookupClient, type TrackedMarket } from './tcgpricelookup.ts';

/**
 * Discovery (P4): crawl a game's tcgpricelookup catalog (no price sort exists, so we enumerate) and
 * rebalance that game's FEATURED set — the top-N priced cards that form the index constituents.
 *
 *  - Resumable: the crawl checkpoints {offset, kept} into `settings` so a budget refusal or crash
 *    resumes where it stopped (a full game is ~470 pages ≈ 9 min at the provider's 1 req/s).
 *  - Low priority: every request runs at 'discovery' priority — user search and the oracle refresh
 *    always preempt it, and its daily-budget ceiling (60%) makes it the first consumer to yield.
 *  - Featured-only rebalance: markets that drop out of the top-N just lose `featured` (leave the index
 *    basket); they stay TRACKED and priced. Markets never get deleted here — append-only universe.
 *  - Dry-run by default; the completed crawl state is kept so a follow-up --apply reuses it without
 *    re-crawling. Applying clears the state.
 *
 * Ops sequencing (plan P5): the pokemon rebalance must only run at cutover — pre-cutover the live
 * pokemontcg feed re-stamps ITS top-250 as featured every pass and the two would fight. OP/MTG
 * discovery can run any time (nothing else owns their featured flags).
 */

const PAGE_SIZE = 100;
const CHECKPOINT_EVERY_PAGES = 20;

interface Candidate {
  id: string;
  price: number;
  tid: number | null; // tcgplayer id (tiebreaker)
}

interface CrawlState {
  offset: number;
  kept: Candidate[];
}

const stateKey = (game: string) => `discovery_${game}`;

async function loadState(db: Db, game: string): Promise<CrawlState> {
  const r = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [stateKey(game)]);
  if (!r.rows[0]) return { offset: 0, kept: [] };
  try {
    const s = JSON.parse(r.rows[0].value) as CrawlState;
    return { offset: s.offset ?? 0, kept: s.kept ?? [] };
  } catch {
    return { offset: 0, kept: [] };
  }
}

async function putSetting(db: Db, key: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO settings(key, value) VALUES($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

const saveState = (db: Db, game: string, state: CrawlState) => putSetting(db, stateKey(game), JSON.stringify(state));

const clearState = (db: Db, game: string) => db.query(`DELETE FROM settings WHERE key = $1`, [stateKey(game)]);

/** Deterministic top-N: price desc, then tcgplayer id asc (nulls last), then provider id (section E).
 *  Printing variants of one physical product share a tcgplayer_id (verified live: Normal vs Reverse
 *  rows are separate provider cards, same product) — keep only the highest-priced printing, per the
 *  one-market-per-canonical-variant decision (a duplicate would also trip idx_markets_tcgplayer). */
export function topCandidates(kept: Candidate[], topN: number): Candidate[] {
  const sorted = [...kept].sort(
    (a, b) =>
      b.price - a.price ||
      (a.tid ?? Number.MAX_SAFE_INTEGER) - (b.tid ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );
  const seenTid = new Set<number>();
  const out: Candidate[] = [];
  for (const c of sorted) {
    if (c.tid != null) {
      if (seenTid.has(c.tid)) continue; // a pricier printing of this product already made the cut
      seenTid.add(c.tid);
    }
    out.push(c);
    if (out.length === topN) break;
  }
  return out;
}

// Global weekly-rebalance bookkeeping (read by the index.ts discovery loop): the interval is enforced
// via a settings timestamp so N instances and restarts share ONE cadence (the lease only guards
// concurrent runs; this guards re-running too often).
const LAST_REBALANCE_KEY = 'discovery_last_rebalance';

export async function dueForRebalance(db: Db, intervalMs: number): Promise<boolean> {
  const r = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [LAST_REBALANCE_KEY]);
  if (!r.rows[0]) return true;
  const last = Date.parse(r.rows[0].value);
  return !Number.isFinite(last) || Date.now() - last >= intervalMs;
}

export const markRebalanced = (db: Db): Promise<void> => putSetting(db, LAST_REBALANCE_KEY, new Date().toISOString());

export interface DiscoveryReport {
  game: string;
  scanned: number; // cards seen this run (excludes pages skipped by resume)
  kept: number; // candidates >= the price threshold (cumulative incl. resumed state)
  top: Candidate[]; // the new featured set
  applied: boolean;
  resumedFromOffset: number;
}

export async function discoverGame(
  db: Db,
  client: TcgPriceLookupClient,
  game: string,
  opts: { topN?: number; minPriceUsd?: number; apply?: boolean; fresh?: boolean; force?: boolean; log?: (msg: string) => void },
): Promise<DiscoveryReport> {
  // the keep-threshold defaults to the SAME $10 floor as the search-and-bet listing gate, so the
  // featured universe and the on-demand listable universe can't silently desynchronize
  const { topN = 250, minPriceUsd = MIN_LIST_PRICE_USD, apply = false, fresh = false, force = false } = opts;
  const log = opts.log ?? (() => {});
  // Cutover-sequencing guard: while pokemontcg is the live feed it re-stamps ITS top-250 as featured
  // every pass, so a pokemon rebalance here would be silently reverted (and oscillate the index
  // divisor). Flip ORACLE_PRIMARY first; --force exists for the cutover window itself.
  if (apply && game === 'pokemon' && config.oraclePrimary === 'pokemontcg' && !force) {
    throw new Error(
      "refusing to rebalance pokemon while ORACLE_PRIMARY=pokemontcg (the live feed would revert it) — flip the flag first, or pass --force",
    );
  }
  if (fresh) await clearState(db, game);
  const state = await loadState(db, game);
  const resumedFromOffset = state.offset;
  let scanned = 0;
  let pages = 0;

  // 1) crawl — resumable: checkpoint regularly, and ALWAYS on exit (failure -> next run resumes from
  //    here; completion -> a follow-up --apply reuses the crawl without re-fetching)
  try {
    for (;;) {
      const page = await client.searchCards({ game, limit: PAGE_SIZE, offset: state.offset }, 'discovery');
      for (const c of page.data) {
        const price = rawPriceUsd(c);
        if (price >= minPriceUsd) {
          state.kept.push({ id: c.id, price, tid: tplTcgplayerId(c) });
        }
      }
      scanned += page.data.length;
      state.offset += page.data.length;
      pages++;
      if (pages % CHECKPOINT_EVERY_PAGES === 0) {
        await saveState(db, game, state);
        log(`…${state.offset}/${page.total} scanned, ${state.kept.length} kept`);
      }
      if (page.data.length === 0 || state.offset >= page.total) break;
    }
  } finally {
    await saveState(db, game, state);
  }

  const top = topCandidates(state.kept, topN);
  if (!apply) {
    return { game, scanned, kept: state.kept.length, top, applied: false, resumedFromOffset };
  }

  // 2) apply: upsert the featured set (existing markets keep their identity), then rebalance the flag
  const topIds = top.map((t) => t.id);
  const full = await client.getCardsByIds(topIds, 'discovery');
  const existing = await db.query<TrackedMarket>(
    `SELECT provider_card_id, symbol, card_id, game, featured FROM markets WHERE provider_card_id = ANY($1)`,
    [topIds],
  );
  const byId = new Map(existing.rows.map((t) => [t.provider_card_id, t]));
  let conflicts = 0;
  for (const c of full) {
    const t: TrackedMarket =
      byId.get(c.id) ?? { provider_card_id: c.id, symbol: cardSymbol(game, c.id), card_id: c.id, game, featured: true };
    const oc = fromTplCard(c, t);
    try {
      await upsertCardMarket(db, { ...toCardUpsert(oc), featured: true });
      // no oracle print here — the refresh loop prices new markets on its next pass
    } catch {
      // unique-violation (identity already claimed by another market) — skip this card, never die
      // mid-apply: the rest of the featured set still lands and the report surfaces the skip.
      conflicts++;
      log(`✗ skipped (identity conflict): ${oc.displayName} [${c.id}]`);
    }
  }
  if (conflicts > 0) log(`${conflicts} candidate(s) skipped on identity conflicts`);
  // A re-featured card that the retirement sweep had delisted (dropped out, sat dead, then its price
  // rose back into the top-250) must REJOIN the live set — a featured market may never be delisted,
  // or it gets no price and silently drops out of the index basket. created_at resets, so the engine
  // freshness gate keeps it un-openable until the next refresh prints (no stale-mark opens).
  await db.query(
    `UPDATE markets SET status = 'active', tradeable = true, created_at = now()
      WHERE game = $1 AND kind = 'card' AND featured AND status = 'delisted'`,
    [game],
  );
  // drop-outs leave the basket but stay tracked + priced
  await db.query(
    `UPDATE markets SET featured = false
      WHERE game = $1 AND kind = 'card' AND featured
        AND (provider_card_id IS NULL OR provider_card_id != ALL($2))`,
    [game, topIds],
  );
  await clearState(db, game);
  log(`featured rebalanced: ${top.length} cards for ${game}`);
  return { game, scanned, kept: state.kept.length, top, applied: true, resumedFromOffset };
}

/** Dead-market retirement (P6 plan default): a NON-featured card market with zero open interest and
 *  zero volume for `retireAfterDays` is delisted — it leaves the refresh set (fetchTrackedCards skips
 *  delisted) so the long-tail can't grow the provider budget unboundedly. Markets with any open
 *  position are NEVER retired; featured markets are the discovery job's to manage, not this sweep's. */
export async function retireDeadMarkets(db: Db, retireAfterDays = config.retireAfterDays): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `UPDATE markets m SET status = 'delisted', tradeable = false
      WHERE m.kind = 'card' AND m.featured = false AND m.status = 'active'
        AND m.created_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.market_id = m.id AND p.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.market_id = m.id AND f.created_at > now() - ($1 || ' days')::interval)
      RETURNING m.id`,
    [String(retireAfterDays)],
  );
  return r.rows.map((x) => x.id);
}
