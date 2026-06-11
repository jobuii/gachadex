import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { upsertCardMarket, cardSymbol } = await import('../markets.ts');
const { discoverGame, topCandidates } = await import('./discovery.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

type TplCardT = import('./tcgpricelookup.ts').TplCard;
type ClientT = InstanceType<typeof import('./tcgpricelookup.ts').TcgPriceLookupClient>;

const card = (id: string, usd: number, tid: number | null = null): TplCardT => ({
  id, tcgplayer_id: tid, name: `Card ${id}`, number: '1/100', rarity: 'Rare', variant: 'Standard',
  image_url: `img/${id}`, updated_at: '2026-06-10T12:00:00Z', set: { slug: 's', name: 'Set' },
  game: { slug: 'onepiece', name: 'One Piece' },
  prices: usd > 0 ? { raw: { near_mint: { tcgplayer: { market: usd } } } } : { raw: {} },
});

/** A fake paginated catalog + batch lookup; records the offsets requested. */
function catalogClient(catalog: TplCardT[], offsets: number[] = [], failAtOffset?: number) {
  return {
    offsets,
    searchCards: async ({ offset = 0, limit = 100 }: { offset?: number; limit?: number }) => {
      if (failAtOffset != null && offset >= failAtOffset) throw new Error('simulated budget refusal');
      offsets.push(offset);
      return { data: catalog.slice(offset, offset + limit), total: catalog.length, limit, offset };
    },
    getCardsByIds: async (ids: string[]) => catalog.filter((c) => ids.includes(c.id)),
  } as unknown as ClientT & { offsets: number[] };
}

test('topCandidates: price desc, tcgplayer-id asc (nulls last), provider id — deterministic', () => {
  const kept = [
    { id: 'b', price: 100, tid: 2 },
    { id: 'a', price: 100, tid: 1 },
    { id: 'z', price: 100, tid: null },
    { id: 'c', price: 900, tid: null },
  ];
  assert.deepEqual(topCandidates(kept, 3).map((c) => c.id), ['c', 'a', 'b']);
});

test('dry run crawls the catalog, filters by threshold, writes no markets, keeps the checkpoint', async () => {
  // 230 cards: 5 valuable, the rest cheap/unpriced — spread across 3 pages
  const catalog = [
    ...Array.from({ length: 100 }, (_, i) => card(`cheap-${i}`, 1)),
    card('big-1', 500, 11), card('big-2', 400, 12),
    ...Array.from({ length: 98 }, (_, i) => card(`null-${i}`, 0)),
    card('big-3', 300, 13), card('big-4', 200, 14), card('big-5', 150, 15),
    ...Array.from({ length: 27 }, (_, i) => card(`cheap2-${i}`, 2)),
  ];
  const client = catalogClient(catalog);
  const r = await discoverGame(db, client, 'onepiece', { topN: 4, minPriceUsd: 10 });
  assert.equal(r.scanned, 230);
  assert.equal(r.kept, 5);
  assert.deepEqual(r.top.map((c) => c.id), ['big-1', 'big-2', 'big-3', 'big-4']);
  assert.equal(r.applied, false);
  const markets = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM markets WHERE game = 'onepiece' AND kind = 'card'`);
  assert.equal(markets.rows[0].n, '0'); // nothing written
  const state = await db.query(`SELECT 1 FROM settings WHERE key = 'discovery_onepiece'`);
  assert.equal(state.rows.length, 1, 'completed crawl is kept for a follow-up --apply');
});

test('apply reuses the completed crawl, creates featured markets, keeps existing identity, unfeatures drop-outs', async () => {
  // an already-tracked market for big-2 (its symbol/card_id must survive) and a stale featured market
  const existingId = await upsertCardMarket(db, {
    game: 'onepiece', symbol: 'legacy-big-2', cardId: 'legacy-big-2', displayName: 'Old Big 2', variant: null,
    imageSmall: null, providerCardId: 'big-2',
  });
  const staleId = await upsertCardMarket(db, {
    game: 'onepiece', symbol: cardSymbol('onepiece', 'old-star'), cardId: 'old-star', displayName: 'Old Star',
    variant: null, imageSmall: null, providerCardId: 'old-star', featured: true,
  });

  const catalog = [card('big-1', 500, 11), card('big-2', 400, 12), card('big-3', 300, 13)];
  const client = catalogClient(catalog);
  const r = await discoverGame(db, client, 'onepiece', { topN: 3, minPriceUsd: 10, apply: true, fresh: true });
  assert.equal(r.applied, true);

  const rows = await db.query<{ symbol: string; provider_card_id: string | null; featured: boolean }>(
    `SELECT symbol, provider_card_id, featured FROM markets WHERE game = 'onepiece' AND kind = 'card' ORDER BY symbol`,
  );
  const bySym = new Map(rows.rows.map((x) => [x.symbol, x]));
  assert.equal(bySym.get('legacy-big-2')?.featured, true, 'existing market kept its symbol and became featured');
  assert.equal(bySym.get(cardSymbol('onepiece', 'big-1'))?.featured, true, 'new market created game-namespaced');
  assert.equal(bySym.get(cardSymbol('onepiece', 'big-3'))?.featured, true);
  assert.equal(bySym.get(cardSymbol('onepiece', 'old-star'))?.featured, false, 'drop-out left the basket');

  // drop-out is STILL tracked (not deleted); the existing market id was reused (no twin)
  const stale = await db.query<{ provider_card_id: string }>(`SELECT provider_card_id FROM markets WHERE id = $1`, [staleId]);
  assert.equal(stale.rows[0].provider_card_id, 'old-star');
  const existing = await db.query<{ display_name: string }>(`SELECT display_name FROM markets WHERE id = $1`, [existingId]);
  assert.equal(existing.rows[0].display_name, 'Card big-2 #1/100'); // refreshed from the provider, same row

  const state = await db.query(`SELECT 1 FROM settings WHERE key = 'discovery_onepiece'`);
  assert.equal(state.rows.length, 0, 'apply clears the checkpoint');
});

test('pokemon apply is refused while pokemontcg is the live feed (it would revert the rebalance)', async () => {
  const client = catalogClient([card('x', 100, 1)]);
  // config.oraclePrimary === 'pokemontcg' in tests (the default) — apply must refuse BEFORE crawling
  await assert.rejects(
    discoverGame(db, client, 'pokemon', { apply: true, fresh: true }),
    /refusing to rebalance pokemon/,
  );
  assert.deepEqual(client.offsets, [], 'refused before spending any budget');
  // dry-run is always allowed; --force bypasses for the cutover window
  await discoverGame(db, client, 'pokemon', { fresh: true });
  await discoverGame(db, client, 'pokemon', { apply: true, force: true, fresh: true });
});

test('a mid-crawl failure checkpoints progress and the next run resumes from that offset', async () => {
  const catalog = Array.from({ length: 250 }, (_, i) => card(`c-${i}`, i === 5 ? 600 : 1));
  // first run: page 1 (offset 0) succeeds, page 2 (offset 100) blows up
  const failing = catalogClient(catalog, [], 100);
  await assert.rejects(
    discoverGame(db, failing, 'mtg', { topN: 5, minPriceUsd: 10, fresh: true }),
    /simulated budget refusal/,
  );
  // second run: resumes at offset 100 (never re-requests offset 0) and completes
  const ok = catalogClient(catalog);
  const r = await discoverGame(db, ok, 'mtg', { topN: 5, minPriceUsd: 10 });
  assert.equal(r.resumedFromOffset, 100);
  assert.deepEqual(ok.offsets, [100, 200]);
  assert.deepEqual(r.top.map((c) => c.id), ['c-5']); // the valuable card from the FIRST run's pages survived the crash
});
