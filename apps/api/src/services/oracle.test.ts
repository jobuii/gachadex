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

test('no outlier reject: a large move is accepted (manipulation handled by the median, gap risk by the engine)', async () => {
  const spiked = cards.map((c) => (c.id === 'sv-1' ? card('sv-1', 'Charizard ex', '223', 99_999) : c));
  await ingest(db, async () => fromPokemontcg(spiked));
  const markets = await listMarketsWithData(db);
  const chari = markets.find((m) => m.symbol === 'sv-1')!;
  // the old ±60% outlier gate is gone — the mark tracks the new oracle value (mark == index at skew 0)
  assert.equal(Number(chari.markE6) / 1_000_000, 99_999);
});

test('hybrid dedup: skip a true duplicate; record on a new timestamp OR a changed value (even at the same timestamp)', async () => {
  const oc = (observedAt: Date, usd = 42) => ({
    game: 'mtg', symbol: 'mtg:dedupe-1', cardId: 'dedupe-1', displayName: 'Dedupe', variant: null,
    imageSmall: null, providerCardId: 'dedupe-1', rawE6: BigInt(usd) * 1_000_000n, observedAt,
  });
  const count = async () =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM oracle_prices op JOIN markets m ON m.id = op.market_id WHERE m.symbol = 'mtg:dedupe-1'`,
        )
      ).rows[0].n,
    );
  const mark = async () =>
    Number(
      (
        await db.query<{ v: string }>(
          `SELECT k.mark_price_e6::text AS v FROM marks k JOIN markets m ON m.id = k.market_id
           WHERE m.symbol = 'mtg:dedupe-1' ORDER BY k.computed_at DESC LIMIT 1`,
        )
      ).rows[0].v,
    ) / 1_000_000;
  const t1 = new Date('2026-06-15T06:00:00Z');
  await ingest(db, async () => [oc(t1)]);
  assert.equal(await count(), 1, 'first print recorded');
  await ingest(db, async () => [oc(t1)]); // SAME timestamp, SAME value -> genuine duplicate
  assert.equal(await count(), 1, 'same timestamp + same value -> no new print');
  await ingest(db, async () => [oc(new Date('2026-06-15T12:00:00Z'))]); // NEW timestamp, still $42 -> flat but live
  assert.equal(await count(), 2, 'a new timestamp at an unchanged price still records (the feed is live)');
  await ingest(db, async () => [oc(t1, 55)]); // SAME (frozen) timestamp, value moved 42 -> 55
  assert.equal(await count(), 3, 'same timestamp + changed value -> the move is still recorded');
  assert.equal(await mark(), 55, 'and the mark re-prices to the moved value');
});

test('hybrid dedup: a move is not lost when a provider timestamp collides AFTER a wall-clock re-stamp', async () => {
  // Regression (adversarial review): the "last value" lookup must read the most-recently-RECORDED value
  // (insertion order), not the row with the max source_observed_at — a value-move re-stamp carries the
  // ingest wall-clock, which sorts newer than any historical provider timestamp, so source_observed_at
  // ordering returned a stale row and silently dropped the next move.
  const oc = (observedAt: Date, usd: number) => ({
    game: 'mtg', symbol: 'mtg:lostmove-1', cardId: 'lostmove-1', displayName: 'LostMove', variant: null,
    imageSmall: null, providerCardId: 'lostmove-1', rawE6: BigInt(usd) * 1_000_000n, observedAt,
  });
  const mark = async () =>
    Number(
      (
        await db.query<{ v: string }>(
          `SELECT k.mark_price_e6::text AS v FROM marks k JOIN markets m ON m.id = k.market_id
           WHERE m.symbol = 'mtg:lostmove-1' ORDER BY k.computed_at DESC LIMIT 1`,
        )
      ).rows[0].v,
    ) / 1_000_000;
  const t1 = new Date('2026-06-14T00:00:00Z');
  const t2 = new Date('2026-06-15T00:00:00Z'); // a later provider timestamp, but still in the past vs now()
  await ingest(db, async () => [oc(t1, 100)]); // (t1, 100)
  await ingest(db, async () => [oc(t1, 200)]); // t1 collides, value moved -> wall-clock re-stamp @ 200
  assert.equal(await mark(), 200);
  await ingest(db, async () => [oc(t2, 100)]); // new provider timestamp t2 -> records @ 100
  assert.equal(await mark(), 100);
  await ingest(db, async () => [oc(t2, 200)]); // t2 collides, a real 100 -> 200 move must still record
  assert.equal(await mark(), 200, 'the move is recorded, not mistaken for the newer-sorted stale re-stamp');
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
      featured: true, // index-eligible (the graded basket is featured-only)
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

test('index baskets are per-game and FEATURED-only; long-tail cards are priced but excluded', async () => {
  const oc = (game: string, id: string, usd: number, featured: boolean) => ({
    game, symbol: `${game}:${id}`, cardId: id, displayName: id, variant: null, imageSmall: null,
    rawE6: BigInt(usd) * 1_000_000n, featured,
  });
  const pass = [
    oc('pokemon', 'feat-a', 1000, true),
    oc('pokemon', 'feat-b', 500, true),
    oc('pokemon', 'longtail-c', 2000, false), // HIGHER price than the featured cards — must stay out
    oc('onepiece', 'feat-luffy2', 300, true),
  ];
  const r = await ingest(db, async () => pass);
  assert.equal(r.cards, 4); // every card is priced/tracked…

  const markets = await listMarketsWithData(db);
  const top100 = markets.find((m) => m.indexSlug === 'top-100' && m.game === 'pokemon')!;
  const constituents = await db.query<{ card_id: string }>(
    `SELECT card_id FROM index_constituents WHERE market_id = $1 ORDER BY card_id`, [top100.id],
  );
  // …but the basket holds ONLY the featured pokemon cards — the pricier long-tail card is excluded
  assert.deepEqual(constituents.rows.map((c) => c.card_id), ['feat-a', 'feat-b']);

  // a One Piece featured card lights up the previously-gated One Piece indices
  const opTop100 = markets.find((m) => m.indexSlug === 'top-100' && m.game === 'onepiece')!;
  assert.equal(opTop100.tradeable, true);
  assert.ok(opTop100.markE6 != null);

  // the long-tail card still became a real, priced market
  const longtail = markets.find((m) => m.symbol === 'pokemon:longtail-c')!;
  assert.equal(Number(longtail.markE6) / 1_000_000, 2000);
});

test('ledger still reconciles (oracle never touches money)', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
