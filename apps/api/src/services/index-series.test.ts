import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { listMarketsWithData } = await import('./markets.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

// A featured Pokémon card priced at `usd`. The basket is one $9k "giant" + 20 × $50 so the 5% cap binds.
const oc = (id: string, usd: number) => ({
  game: 'pokemon',
  symbol: id,
  cardId: id,
  displayName: id,
  variant: null,
  imageSmall: null,
  rawE6: BigInt(Math.round(usd * 1_000_000)),
  featured: true,
});
const basket = (giant: number) => [oc('A', giant), ...Array.from({ length: 20 }, (_, i) => oc('s' + i, 50))];
const idxVal = (m: { indexE6?: string | null }) => Number(m?.indexE6) / 1_000_000;

test('GJ / G&P / Pokedaq diverge end-to-end across two ingest passes (same basket, three weightings)', async () => {
  await ingest(db, async () => basket(9000)); // pass 1 — all three launch at 1000
  await ingest(db, async () => basket(9900)); // pass 2 — the $9k giant +10%, the rest flat

  const markets = await listMarketsWithData(db);
  const bySlug = (slug: string) => markets.find((m) => m.indexSlug === slug && m.game === 'pokemon')!;
  const gj = bySlug('top-100'); // GJ keeps the bare slug
  const gp = bySlug('gp-top-100');
  const pdq = bySlug('pdq-top-100');

  // GJ price-weighted: the giant is ~90% of the basket, so +10% on it ≈ +9% on the index.
  assert.equal(idxVal(gj), 1090);
  // G&P equal-weight: (1.1 + 20·1.0) / 21 → +0.476%. The giant no longer dominates.
  assert.equal(Math.round(idxVal(gp) * 1000) / 1000, 1004.761);
  // Pokedaq capped 5%: the giant contributes only 5% → +0.5%.
  assert.equal(idxVal(pdq), 1005);

  // The whole point: price-weight moves most, the capped/equal methods damp the single-card concentration.
  assert.ok(idxVal(gj) > idxVal(pdq) && idxVal(pdq) > idxVal(gp), 'gj > pokedaq > g&p');
});
