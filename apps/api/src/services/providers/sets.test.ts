import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { warmSetCache, dueForSetWarm } = await import('./sets.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

type SetT = import('./tcgpricelookup.ts').TplSet;
type ClientT = InstanceType<typeof import('./tcgpricelookup.ts').TcgPriceLookupClient>;

// A fake /sets endpoint: pokemon paginates (2 pages of 1), other games return nothing.
function setsClient(byGame: Record<string, SetT[]>, calls: string[] = []) {
  return {
    calls,
    getSets: async (game: string, { offset = 0, limit = 100 }: { offset?: number; limit?: number }) => {
      calls.push(`${game}@${offset}`);
      const all = byGame[game] ?? [];
      return { data: all.slice(offset, offset + limit), total: all.length };
    },
  } as unknown as ClientT & { calls: string[] };
}

const set = (slug: string, name: string, released_at: string | null): SetT => ({
  id: slug, slug, name, game: 'pokemon', count: 1, released_at,
});

test('warmSetCache upserts every set, extracts the year, and handles a null release date', async () => {
  const client = setsClient({
    pokemon: [
      set('obsidian-flames', 'Obsidian Flames', '2023-08-11'),
      set('base-set', 'Base Set', '1999-01-09'),
      set('alt-art-promos', 'Alternate Art Promos', null), // no date -> null year
    ],
  });

  assert.equal(await dueForSetWarm(db, 60_000), true, 'never warmed -> due');
  const r = await warmSetCache(db, client);
  assert.equal(r.sets, 3);

  const rows = await db.query<{ slug: string; release_year: number | null }>(
    `SELECT slug, release_year FROM tcg_sets ORDER BY slug`,
  );
  const byslug = new Map(rows.rows.map((x) => [x.slug, x.release_year]));
  assert.equal(byslug.get('obsidian-flames'), 2023);
  assert.equal(byslug.get('base-set'), 1999);
  assert.equal(byslug.get('alt-art-promos'), null, 'null released_at -> null year, still cached');

  assert.equal(await dueForSetWarm(db, 60_000), false, 'just warmed -> not due within the interval');

  // re-run is idempotent and refreshes a changed date in place (no duplicate rows)
  const client2 = setsClient({ pokemon: [set('obsidian-flames', 'Obsidian Flames', '2024-01-01')] });
  await warmSetCache(db, client2);
  const updated = await db.query<{ n: string; y: number }>(
    `SELECT count(*)::text AS n, max(release_year) AS y FROM tcg_sets WHERE slug = 'obsidian-flames'`,
  );
  assert.equal(updated.rows[0].n, '1', 'still one row for the slug');
  assert.equal(updated.rows[0].y, 2024, 'release year refreshed in place');
});
