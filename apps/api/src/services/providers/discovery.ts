import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { cardSymbol, upsertCardMarket } from '../markets.ts';
import { toCardUpsert } from '../oracle.ts';
import { rawPriceUsd, fromTplCard, tplTcgplayerId, type TcgPriceLookupClient, type TrackedMarket } from './tcgpricelookup.ts';

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

async function saveState(db: Db, game: string, state: CrawlState): Promise<void> {
  await db.query(
    `INSERT INTO settings(key, value) VALUES($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [stateKey(game), JSON.stringify(state)],
  );
}

const clearState = (db: Db, game: string) => db.query(`DELETE FROM settings WHERE key = $1`, [stateKey(game)]);

/** Deterministic top-N: price desc, then tcgplayer id asc (nulls last), then provider id (section E). */
export function topCandidates(kept: Candidate[], topN: number): Candidate[] {
  return [...kept]
    .sort(
      (a, b) =>
        b.price - a.price ||
        (a.tid ?? Number.MAX_SAFE_INTEGER) - (b.tid ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, topN);
}

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
  const { topN = 250, minPriceUsd = 10, apply = false, fresh = false, force = false } = opts;
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
  for (const c of full) {
    const t: TrackedMarket =
      byId.get(c.id) ?? { provider_card_id: c.id, symbol: cardSymbol(game, c.id), card_id: c.id, game, featured: true };
    const oc = fromTplCard(c, t);
    await upsertCardMarket(db, { ...toCardUpsert(oc), featured: true });
    // no oracle print here — the refresh loop prices new markets on its next pass
  }
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
