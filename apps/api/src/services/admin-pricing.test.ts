import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { setManualPrice, setPricePin } = await import('./admin-pricing.ts');
const { reconcile } = await import('./reconcile.ts');
const { toE6 } = await import('@pokex/pricing');

await initDb();
const db = await getDb();

const card = (id: string, name: string, price: number) => ({
  id, name, number: '1', images: { small: `img/${id}` },
  tcgplayer: { prices: { holofoil: { market: price } } },
});
const cards = [card('a', 'Alpha', 1000), card('b', 'Bravo', 500)];
const usd = (markE6: string | null) => Number(markE6) / 1_000_000;
const mkt = async (sym: string) => (await listMarketsWithData(db)).find((m) => m.symbol === sym)!;

test('manual price sets the mark and pins the market', async () => {
  await ingest(db, async () => fromPokemontcg(cards));
  const a0 = await mkt('a');
  assert.equal(usd(a0.markE6), 1000); // seeded from the feed
  assert.equal(a0.pricePinned, false);

  const r = await setManualPrice(db, a0.id, toE6(777), { note: 'ebay sold listings' });
  assert.equal(usd(r.markE6), 777); // mark recomputed at the manual price (skew 0 -> mark == index)
  assert.equal(r.pinned, true);

  const a1 = await mkt('a');
  assert.equal(usd(a1.markE6), 777);
  assert.equal(a1.pricePinned, true);
});

test('the auto-oracle skips a pinned market but still updates unpinned ones', async () => {
  // feed now says a=9999, b=600 — a is pinned (manual 777), b is not
  const next = [card('a', 'Alpha', 9999), card('b', 'Bravo', 600)];
  await ingest(db, async () => fromPokemontcg(next));

  assert.equal(usd((await mkt('a')).markE6), 777, 'pinned market keeps its manual price');
  assert.equal(usd((await mkt('b')).markE6), 600, 'unpinned market follows the feed');
});

test('unpinning lets the auto-oracle resume overwriting the price', async () => {
  const a = await mkt('a');
  await setPricePin(db, a.id, false);
  await ingest(db, async () => fromPokemontcg([card('a', 'Alpha', 1234), card('b', 'Bravo', 600)]));
  const a2 = await mkt('a');
  assert.equal(usd(a2.markE6), 1234);
  assert.equal(a2.pricePinned, false);
});

test('the fat-finger guard rejects a >10x move unless forced', async () => {
  const a = await mkt('a'); // last price 1234
  await assert.rejects(() => setManualPrice(db, a.id, toE6(100_000)), /more than/);
  const r = await setManualPrice(db, a.id, toE6(100_000), { force: true });
  assert.equal(usd(r.markE6), 100_000);
});

test('manual pricing never touches money (ledger still reconciles)', async () => {
  assert.equal((await reconcile(db)).ok, true);
});

after(async () => {
  await closeDb();
});
