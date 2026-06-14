import { GAMES } from '@pokex/shared-types';
import type { Db } from '../../db/client.ts';
import { SET_YEARS } from './set-years.data.ts';

/**
 * Set-metadata cache (tcg_sets) — release years for card sets. The price oracle (tcgpricelookup)
 * carries NO release dates (its /sets `released_at` is always null), so the years come from a
 * committed static table (set-years.data.ts, generated from tcgcsv.com), seeded into the DB on boot
 * with ZERO runtime provider calls. Every card then maps to its set's year by slug (or game+name) in
 * getMarketDetails. Idempotent + multi-instance safe (ON CONFLICT); re-running just refreshes in place.
 */
export async function seedSetYears(db: Db): Promise<{ sets: number }> {
  let sets = 0;
  for (const game of GAMES) {
    const rows = SET_YEARS.filter((s) => s.game === game);
    if (rows.length === 0) continue;
    // one batched upsert per game (prod Postgres is remote — row-by-row would round-trip per set)
    await db.query(
      `INSERT INTO tcg_sets(game, slug, name, release_year, fetched_at)
       SELECT $1, u.slug, u.name, u.yr, now()
         FROM unnest($2::text[], $3::text[], $4::int[]) AS u(slug, name, yr)
       ON CONFLICT(game, slug) DO UPDATE
         SET name = EXCLUDED.name, release_year = EXCLUDED.release_year, fetched_at = now()`,
      [game, rows.map((r) => r.slug), rows.map((r) => r.name), rows.map((r) => r.year)],
    );
    sets += rows.length;
  }
  return { sets };
}
