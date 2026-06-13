import { GAMES } from '@pokex/shared-types';
import type { Db } from '../../db/client.ts';
import type { TcgPriceLookupClient } from './tcgpricelookup.ts';

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
  let sets = 0;
  for (const game of GAMES) {
    for (let offset = 0; ; ) {
      const page = await client.getSets(game, { limit: PAGE, offset }, 'discovery');
      for (const s of page.data) {
        const year = s.released_at && /^\d{4}-\d{2}-\d{2}$/.test(s.released_at) ? Number(s.released_at.slice(0, 4)) : null;
        await db.query(
          `INSERT INTO tcg_sets(game, slug, name, released_at, release_year, fetched_at)
             VALUES($1, $2, $3, $4, $5, now())
           ON CONFLICT(game, slug) DO UPDATE
             SET name = EXCLUDED.name, released_at = EXCLUDED.released_at,
                 release_year = EXCLUDED.release_year, fetched_at = now()`,
          [game, s.slug, s.name, s.released_at ?? null, year],
        );
        sets++;
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
