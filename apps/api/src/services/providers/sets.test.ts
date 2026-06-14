import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { seedSetYears } = await import('./sets.ts');
const { SET_YEARS } = await import('./set-years.data.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('seedSetYears upserts the static set→year table and is idempotent in place', async () => {
  const r = await seedSetYears(db);
  assert.equal(r.sets, SET_YEARS.length, 'seeds every static row');

  // Every static row landed with its year — equal counts also prove (game, slug) is unique.
  const dated = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM tcg_sets WHERE release_year IS NOT NULL`);
  assert.equal(Number(dated.rows[0].n), SET_YEARS.length, 'no rows collapsed by a duplicate (game, slug)');

  // A known set resolves its year by (game, slug).
  const base = await db.query<{ release_year: number }>(
    `SELECT release_year FROM tcg_sets WHERE game = 'pokemon' AND slug = 'pokemon--base-set'`,
  );
  assert.equal(base.rows[0]?.release_year, 1999);

  // Re-seed is idempotent: same row count, refreshed in place (no duplicate rows).
  await seedSetYears(db);
  const total = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM tcg_sets`);
  assert.equal(Number(total.rows[0].n), SET_YEARS.length, 'no duplicate rows after re-seed');
});

test('the static data is well-formed (every row has a game, slug, name, and 4-digit year)', () => {
  const games = new Set(['pokemon', 'mtg', 'onepiece']);
  for (const s of SET_YEARS) {
    assert.ok(games.has(s.game), `unexpected game ${s.game}`);
    assert.ok(s.slug && s.name, 'slug and name present');
    assert.ok(Number.isInteger(s.year) && s.year >= 1990 && s.year <= 2100, `implausible year ${s.year} for ${s.slug}`);
  }
});
