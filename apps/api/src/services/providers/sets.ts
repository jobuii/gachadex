import { GAMES } from '@pokex/shared-types';
import type { Db } from '../../db/client.ts';
import type { TcgPriceLookupClient, TplSet } from './tcgpricelookup.ts';

/**
 * Set-metadata cache (tcgpricelookup /sets). The whole set list per game is ~hundreds of rows fetched
 * in a handful of paginated calls, so we warm it once a day and every card maps to its set's release
 * year by slug (or game+name) with NO per-card provider call. See the tcg_sets schema comment.
 */

const SET_WARM_KEY = 'sets_last_warmed';
const PAGE = 100;

/** True if the set cache hasn't been warmed within `intervalMs` (a cheap settings-timestamp gate). */
export async function dueForSetWarm(db: Db, intervalMs: number): Promise<boolean> {
  const r = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [SET_WARM_KEY]);
  if (!r.rows[0]) return true;
  return Date.now() - Number(r.rows[0].value) >= intervalMs;
}

/** Pull every set for every game and upsert slug -> release year. Idempotent; safe to re-run. */
export async function warmSetCache(db: Db, client: TcgPriceLookupClient): Promise<{ sets: number }> {
  // Year only (no raw date): the UI shows the year, and an INT can't be rejected the way a malformed
  // date string in a DATE column would (which would abort the whole warm). Year = first 4 digits of a
  // well-formed YYYY-MM-DD; anything else -> null.
  const yearOf = (s: TplSet): number | null =>
    s.released_at && /^\d{4}-\d{2}-\d{2}$/.test(s.released_at) ? Number(s.released_at.slice(0, 4)) : null;

  let sets = 0;
  for (const game of GAMES) {
    for (let offset = 0; ; ) {
      const page = await client.getSets(game, { limit: PAGE, offset }, 'discovery');
      if (page.data.length > 0) {
        // one batched upsert per page (prod Postgres is remote — row-by-row would round-trip per set)
        await db.query(
          `INSERT INTO tcg_sets(game, slug, name, release_year, fetched_at)
           SELECT $1, u.slug, u.name, u.yr, now()
             FROM unnest($2::text[], $3::text[], $4::int[]) AS u(slug, name, yr)
           ON CONFLICT(game, slug) DO UPDATE
             SET name = EXCLUDED.name, release_year = EXCLUDED.release_year, fetched_at = now()`,
          [game, page.data.map((s) => s.slug), page.data.map((s) => s.name), page.data.map(yearOf)],
        );
        sets += page.data.length;
      }
      offset += page.data.length;
      if (page.data.length === 0 || offset >= page.total) break;
    }
  }
  await db.query(
    `INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SET_WARM_KEY, String(Date.now())],
  );
  return { sets };
}
