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
const { listMarketsWithData, getCandles, getMarketDetails, cardSymbol } = await import('./markets.ts');
const { reconcile } = await import('./reconcile.ts');

await initDb();
const db = await getDb();

const card = (id: string, name: string, number: string, price: number) => ({
  id,
  name,
  number,
  images: { small: `img/${id}` },
  tcgplayer: { prices: { holofoil: { market: price } } },
});

const cards = [
  card('sv-1', 'Charizard ex', '223', 1200),
  card('base1-4', 'Charizard', '4', 500),
  card('base1-2', 'Blastoise', '2', 300),
  card('jungle-60', 'Pikachu', '60', 50),
  card('nodata', 'NoPrice', '1', 0), // filtered out (price 0)
];

test('ingest seeds card markets, indices, oracle prints and marks', async () => {
  const r = await ingest(db, async () => fromPokemontcg(cards));
  assert.equal(r.cards, 4); // the $0 card is excluded
  assert.equal(r.indices, 2); // top-100 + top-250 (graded/sealed are gated)

  const markets = await listMarketsWithData(db);
  // 4 cards + 4 Pokémon indices (top-100, top-250, graded, sealed) + 2 One Piece + 2 MTG gated indices
  assert.equal(markets.length, 12);

  const chari = markets.find((m) => m.symbol === 'sv-1')!;
  assert.equal(chari.kind, 'card');
  assert.equal(chari.game, 'pokemon'); // ingested cards are tagged with their game
  assert.equal(Number(chari.markE6) / 1_000_000, 1200); // mark == index when skew = 0

  // slugs repeat per game — pick the Pokémon one explicitly
  const top100 = markets.find((m) => m.indexSlug === 'top-100' && m.game === 'pokemon')!;
  assert.equal(top100.tradeable, true);
  assert.ok(top100.markE6 && Number(top100.markE6) / 1_000_000 >= 1000, 'index starts at its base value of 1000');

  const graded = markets.find((m) => m.indexSlug === 'graded')!;
  assert.equal(graded.tradeable, false);
  assert.equal(graded.markE6, null); // gated: listed, no price/mark

  // game dimension: One Piece / MTG indices are listed but gated until scrydex card data lands
  for (const game of ['onepiece', 'mtg']) {
    const gameIdx = markets.filter((m) => m.game === game);
    assert.equal(gameIdx.length, 2, `${game} lists top-100 + top-250`);
    assert.ok(gameIdx.every((m) => m.kind === 'index' && !m.tradeable && m.markE6 === null), `${game} indices are gated`);
  }
});

test('candles endpoint returns REAL marks (no fabrication), newest = current mark', async () => {
  const markets = await listMarketsWithData(db);
  const chari = markets.find((m) => m.symbol === 'sv-1')!;
  const a = await getCandles(db, chari.id, 30);
  const b = await getCandles(db, chari.id, 30);
  assert.deepEqual(a, b, 'real series, stable across calls (no random walk)');
  assert.ok(a.length >= 1, 'at least the latest mark');
  assert.ok(a.length <= 30, 'no padded/synthetic points beyond real history'); // would be ~31 if fabricated
  assert.ok(a.every((c) => typeof c.time === 'number'), 'time is a unix timestamp');
  assert.equal(a[a.length - 1].value, 1200); // ends at the current mark
});

test('outlier guard rejects an implausible price jump', async () => {
  const spiked = cards.map((c) => (c.id === 'sv-1' ? card('sv-1', 'Charizard ex', '223', 99_999) : c));
  await ingest(db, async () => fromPokemontcg(spiked));
  const markets = await listMarketsWithData(db);
  const chari = markets.find((m) => m.symbol === 'sv-1')!;
  // jump was rejected -> mark unchanged
  assert.equal(Number(chari.markE6) / 1_000_000, 1200);
});

test('card metadata is stored; JustTCG graded data activates the Graded index', async () => {
  const richCards = [
    {
      id: 'g-1', name: 'Charizard', number: '4', images: { small: 's1', large: 'l1' },
      set: { name: 'Base Set', images: { logo: 'logo1' } }, hp: '120', retreatCost: ['C', 'C'],
      attacks: [{ name: 'Fire Spin', damage: '100' }],
      tcgplayer: { productId: 111, prices: { holofoil: { market: 1000 } } },
    },
    {
      id: 'g-2', name: 'Blastoise', number: '2', images: { small: 's2', large: 'l2' },
      set: { name: 'Base Set', images: { logo: 'logo1' } }, hp: '100', retreatCost: ['C'],
      attacks: [{ name: 'Hydro Pump', damage: '60' }],
      tcgplayer: { productId: 222, prices: { holofoil: { market: 500 } } },
    },
  ];
  const mockGraded = async (card: any) => (card.cardId === 'g-1' ? 5000 : 2000); // PSA-10 prices
  const r = await ingest(db, async () => fromPokemontcg(richCards), mockGraded);
  assert.equal(r.graded, 2);

  const markets = await listMarketsWithData(db);
  const chari = markets.find((m) => m.symbol === 'g-1')!;
  assert.equal(chari.setLogo, 'logo1');

  const details = (await getMarketDetails(db, chari.id))!;
  const meta = details.metadata as { hp: string; retreat: number; attacks: { name: string }[] };
  assert.equal(meta.hp, '120');
  assert.equal(meta.retreat, 2);
  assert.equal(meta.attacks[0].name, 'Fire Spin');
  assert.equal(details.gradedPsa10E6, (5000n * 1_000_000n).toString());

  const graded = markets.find((m) => m.indexSlug === 'graded')!;
  assert.equal(graded.tradeable, true);
  assert.ok(graded.markE6 && Number(graded.markE6) > 0, 'Graded index now has a mark');
});

test('a provider-built OracleCard flows end-to-end: ids, inline graded (no fetcher), provider timestamp', async () => {
  // What the tcgpricelookup fetcher (P3) will emit — no pokemontcg mapping involved.
  const observedAt = new Date('2026-06-10T12:00:00Z');
  const r = await ingest(db, async () => [
    {
      game: 'onepiece',
      symbol: cardSymbol('onepiece', 'uuid-luffy'),
      cardId: 'uuid-luffy',
      tcgplayerId: 990001,
      providerCardId: 'uuid-luffy',
      displayName: 'Monkey D. Luffy #OP01-001',
      variant: 'Standard',
      imageSmall: 'img/luffy',
      rawE6: 250_000_000n, // $250
      gradedE6: 1_500_000_000n, // $1500 PSA-10, inline — no gradedFetcher needed
      observedAt,
    },
  ]); // note: no gradedFetcher passed (JUSTTCG_API_KEY unset) — graded must come from the card itself
  assert.equal(r.cards, 1);
  assert.equal(r.graded, 1, 'inline gradedE6 counted without any graded fetcher');

  const row = (
    await db.query<{ game: string; tcg: string | null; prov: string | null; graded: string | null }>(
      `SELECT game, tcgplayer_id::text AS tcg, provider_card_id AS prov, graded_psa10_e6::text AS graded
       FROM markets WHERE symbol = 'onepiece:uuid-luffy'`,
    )
  ).rows[0];
  assert.deepEqual(row, { game: 'onepiece', tcg: '990001', prov: 'uuid-luffy', graded: '1500000000' });

  // the print carries the PROVIDER's freshness timestamp, not the ingest wall-clock
  const print = (
    await db.query<{ at: string; v: string }>(
      `SELECT source_observed_at AS at, index_price_e6::text AS v FROM oracle_prices op
       JOIN markets m ON m.id = op.market_id WHERE m.symbol = 'onepiece:uuid-luffy'`,
    )
  ).rows[0];
  assert.equal(new Date(print.at).toISOString(), observedAt.toISOString());
  assert.equal(print.v, '250000000');
});

test('ledger still reconciles (oracle never touches money)', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
