import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { liveLabelFree } from '../../db/market-guards.ts';
import { cardSymbol, copySiblingScrydexIds, upsertCardMarket, withFeaturedSource } from '../markets.ts';
import { toCardUpsert } from '../oracle.ts';
import { rawPriceUsd, fromTplCard, tplTcgplayerId, hasLiquiditySignal, MIN_LIST_PRICE_USD, type TcgPriceLookupClient, type TrackedMarket } from './tcgpricelookup.ts';
import { productTypeOf, type ProductType } from '../product-type.ts';

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

export interface Candidate {
  id: string;
  price: number;
  tid: number | null; // tcgplayer id (tiebreaker)
  // Absent on a crawl checkpointed before these existed → treated as a liquid single (the legacy behaviour),
  // so resuming an old crawl can never empty the featured set.
  pt?: ProductType; // single | sealed | other (product-type.ts)
  liq?: boolean; // hasLiquiditySignal — a real market, not one static listing
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

/** The index-eligible (featured) set: liquid products only (one static listing can't move — it froze the
 *  index), chosen as top-N SINGLES and, separately, top-N SEALED — so sealed product never takes a card
 *  slot (it was 71% of the Pokémon "Top 100 cards" by weight) and feeds its own Sealed basket. 'other'
 *  (e.g. Code Cards) is in neither. */
export function featuredSelection(kept: Candidate[], topN: number): Candidate[] {
  const liquid = kept.filter((c) => c.liq !== false);
  return [
    ...topCandidates(liquid.filter((c) => (c.pt ?? 'single') === 'single'), topN),
    ...topCandidates(liquid.filter((c) => c.pt === 'sealed'), topN),
  ];
}

/** Printing markets (P5): the OTHER printings of the featured products — same TCGplayer product, a different provider
 *  card (tcgpl lists each printing as its own card) — that pass the one listing rule for printings: the $10 floor (the
 *  crawl only keeps those) AND a sales signal. Listed, never featured: only the product's top printing can be an index
 *  member (D6/R12). */
export function printingSiblings(kept: Candidate[], featured: Candidate[]): Candidate[] {
  const tids = new Set(featured.map((c) => c.tid).filter((t): t is number => t != null));
  const ids = new Set(featured.map((c) => c.id));
  const seen = new Set<string>();
  return kept.filter((c) => {
    if (c.tid == null || !tids.has(c.tid) || ids.has(c.id) || c.liq !== true || seen.has(c.id)) return false;
    seen.add(c.id); // a resumed crawl can hold a card twice
    return true;
  });
}

/** May a NEW market join a TCGplayer product that already has `onProduct` markets (their provider_card_ids)? An empty
 *  product, always. Otherwise only as another printing (P5, switch on) and only when every market there is a tcgpl card:
 *  tcgpl names printings consistently, while a Scrydex-only market (no provider id) names its printing in Scrydex's words
 *  ('staffStamp' for tcgpl's 'Holofoil') — a new market there could be the SAME card under another name. Switched off,
 *  one market per product, whatever the database index currently allows. */
export function mayJoinProduct(onProduct: (string | null)[], printingMarkets: boolean): boolean {
  return onProduct.length === 0 || (printingMarkets && onProduct.every((p) => p != null));
}

/** The printing siblings discovery listed on its latest run, per game — the only non-featured markets the retirement
 *  sweep spares (a sibling that stops qualifying drops off the list and retires like any long-tail market). */
const siblingsKey = (game: string) => `discovery_siblings:${game}`;

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
          state.kept.push({ id: c.id, price, tid: tplTcgplayerId(c), pt: productTypeOf(c.rarity, c.number), liq: hasLiquiditySignal(c) });
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

  const top = featuredSelection(state.kept, topN);
  if (!apply) {
    return { game, scanned, kept: state.kept.length, top, applied: false, resumedFromOffset };
  }

  // 2) apply: upsert the featured set (existing markets keep their identity), then rebalance the flag
  const topIds = top.map((t) => t.id);
  // Printing markets (P5): also list the featured products' other printings (printingSiblings)
  const sibs = config.printingMarketsEnabled ? printingSiblings(state.kept, top) : [];
  const candidateIds = [...topIds, ...sibs.map((c) => c.id)];
  const existing = await db.query<TrackedMarket>(
    `SELECT provider_card_id, symbol, card_id, game, featured FROM markets WHERE provider_card_id = ANY($1)`,
    [candidateIds],
  );
  const byId = new Map(existing.rows.map((t) => [t.provider_card_id, t]));
  // every market already on these products (any status): a NEW market joins one only under mayJoinProduct
  const onProduct = new Map<number, (string | null)[]>();
  for (const r of (await db.query<{ tid: string; provider_card_id: string | null }>(
    `SELECT tcgplayer_id::text AS tid, provider_card_id FROM markets WHERE kind = 'card' AND tcgplayer_id = ANY($1)`,
    [[...new Set([...top, ...sibs].map((c) => c.tid).filter((t) => t != null))]],
  )).rows) onProduct.set(Number(r.tid), [...(onProduct.get(Number(r.tid)) ?? []), r.provider_card_id]);
  const mayCreate = (tid: number | null) => tid == null || mayJoinProduct(onProduct.get(tid) ?? [], config.printingMarketsEnabled);
  const siblingIds = sibs.filter((c) => byId.has(c.id) || mayCreate(c.tid)).map((c) => c.id);
  if (config.printingMarketsEnabled) log(`${siblingIds.length} other printings of featured cards (${sibs.length - siblingIds.length} wait on a Scrydex-only market)`);
  await putSetting(db, siblingsKey(game), JSON.stringify(siblingIds));
  const sibling = new Set(siblingIds);
  const full = await client.getCardsByIds([...topIds, ...siblingIds], 'discovery');
  let conflicts = 0;
  for (const c of full) {
    const isSibling = sibling.has(c.id);
    if (!byId.has(c.id) && !mayCreate(tplTcgplayerId(c))) {
      conflicts++; // another market already holds this product (switched off, or a Scrydex-only one) — never a twin
      log(`✗ skipped (product already listed): ${c.name} [${c.id}]`);
      continue;
    }
    const t: TrackedMarket =
      byId.get(c.id) ?? { provider_card_id: c.id, symbol: cardSymbol(game, c.id), card_id: c.id, game, featured: !isSibling };
    const oc = fromTplCard(c, t);
    try {
      await withFeaturedSource(db, 'discovery', async (q) => {
        // a sibling leaves the stored flag alone (new → not featured); the drop-out step below un-features it if it was
        const id = await upsertCardMarket(q, { ...toCardUpsert(oc), featured: isSibling ? undefined : true });
        if (isSibling) await copySiblingScrydexIds(q, id);
      });
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
  // Printing siblings come back the same way. At most one market per card label, and never onto a label a live market
  // holds (liveLabelFree; the check reads the statement's snapshot, hence DISTINCT ON) — it stays delisted instead.
  await db.query(
    `UPDATE markets m SET status = 'active', tradeable = true, created_at = now()
      WHERE m.id IN (SELECT DISTINCT ON (COALESCE(card_id, id)) id FROM markets
                      WHERE game = $1 AND kind = 'card' AND status = 'delisted' AND (featured OR provider_card_id = ANY($2))
                      ORDER BY COALESCE(card_id, id), featured DESC, id)
        AND ${liveLabelFree('m')}`,
    [game, siblingIds],
  );
  // drop-outs leave the basket but stay tracked + priced
  await withFeaturedSource(db, 'discovery', (q) =>
    q.query(
      // R7 (index rules v3): never a current index member, announced addition or reserve — they stay featured + priced
      `UPDATE markets SET featured = false
        WHERE game = $1 AND kind = 'card' AND featured
          AND (provider_card_id IS NULL OR provider_card_id != ALL($2))
          AND id NOT IN (SELECT market_id FROM index_locked_markets)`,
      [game, topIds],
    ),
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
  const listed = (await db.query<{ value: string }>(`SELECT value FROM settings WHERE key LIKE 'discovery_siblings:%'`)).rows
    .flatMap((r) => JSON.parse(r.value) as string[]);
  const r = await db.query<{ id: string }>(
    `UPDATE markets m SET status = 'delisted', tradeable = false
      WHERE m.kind = 'card' AND m.featured = false AND m.status = 'active'
        AND m.created_at < now() - ($1 || ' days')::interval
        -- a printing sibling discovery listed on its latest run stays listed (P5); one that stopped qualifying retires
        AND (m.provider_card_id IS NULL OR m.provider_card_id <> ALL($2))
        AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.market_id = m.id AND p.status = 'open')
        AND m.id NOT IN (SELECT market_id FROM index_locked_markets)
        AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.market_id = m.id AND f.created_at > now() - ($1 || ' days')::interval)
      RETURNING m.id`,
    [String(retireAfterDays), listed],
  );
  return r.rows.map((x) => x.id);
}
