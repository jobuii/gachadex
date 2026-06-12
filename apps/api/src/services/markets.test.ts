import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { config } = await import('../config.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket, cardSymbol, getMarketById, getCandles, getMarketDetails } = await import('./markets.ts');
const { gradeLadder } = await import('./providers/tcgpricelookup.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const base = {
  game: 'pokemon',
  displayName: 'Test Card #1',
  variant: 'holofoil',
  imageSmall: 'img/x',
};

async function providerIds(marketId: string): Promise<{ tcg: string | null; prov: string | null }> {
  const r = await db.query<{ tcg: string | null; prov: string | null }>(
    `SELECT tcgplayer_id::text AS tcg, provider_card_id AS prov FROM markets WHERE id = $1`,
    [marketId],
  );
  return r.rows[0];
}

test('upsertCardMarket persists the stable cross-provider ids', async () => {
  const id = await upsertCardMarket(db, {
    ...base,
    symbol: 'p0-card-1',
    cardId: 'p0-card-1',
    tcgplayerId: 510327,
    providerCardId: 'uuid-aaa',
  });
  assert.deepEqual(await providerIds(id), { tcg: '510327', prov: 'uuid-aaa' });
});

test('a re-upsert WITHOUT provider ids keeps the stored ones (legacy feed never erases them)', async () => {
  const id = await upsertCardMarket(db, {
    ...base,
    symbol: 'p0-card-2',
    cardId: 'p0-card-2',
    tcgplayerId: 600001,
    providerCardId: 'uuid-bbb',
  });
  // the legacy pokemontcg path re-upserts the same symbol with no provider ids
  const again = await upsertCardMarket(db, { ...base, symbol: 'p0-card-2', cardId: 'p0-card-2' });
  assert.equal(again, id); // same market, not a duplicate
  assert.deepEqual(await providerIds(id), { tcg: '600001', prov: 'uuid-bbb' }); // ids survived
});

test('a later upsert CAN fill ids onto a legacy market (the backfill write-path)', async () => {
  const id = await upsertCardMarket(db, { ...base, symbol: 'p0-card-3', cardId: 'p0-card-3' });
  assert.deepEqual(await providerIds(id), { tcg: null, prov: null });
  await upsertCardMarket(db, { ...base, symbol: 'p0-card-3', cardId: 'p0-card-3', tcgplayerId: 700001, providerCardId: 'uuid-ccc' });
  assert.deepEqual(await providerIds(id), { tcg: '700001', prov: 'uuid-ccc' });
});

test('duplicate-market guard: a second market claiming the same provider_card_id is rejected', async () => {
  await upsertCardMarket(db, { ...base, symbol: 'p0-card-4', cardId: 'p0-card-4', providerCardId: 'uuid-shared' });
  await assert.rejects(
    upsertCardMarket(db, { ...base, symbol: 'p0-card-4-dupe', cardId: 'p0-card-4-dupe', providerCardId: 'uuid-shared' }),
    /idx_markets_provider_card|unique|duplicate/i,
  );
});

test('duplicate-market guard: a second market claiming the same tcgplayer_id is rejected', async () => {
  await upsertCardMarket(db, { ...base, symbol: 'p0-card-5', cardId: 'p0-card-5', tcgplayerId: 800001 });
  await assert.rejects(
    upsertCardMarket(db, { ...base, symbol: 'p0-card-5-dupe', cardId: 'p0-card-5-dupe', tcgplayerId: 800001 }),
    /idx_markets_tcgplayer|unique|duplicate/i,
  );
});

test('cardSymbol namespaces by game (cross-game + INDEX:* collision proof)', async () => {
  assert.equal(cardSymbol('onepiece', 'uuid-x'), 'onepiece:uuid-x');

  const id = await upsertCardMarket(db, {
    ...base,
    game: 'onepiece',
    symbol: cardSymbol('onepiece', 'uuid-ddd'),
    cardId: 'uuid-ddd',
    providerCardId: 'uuid-ddd',
  });
  const m = await getMarketById(db, id);
  assert.equal(m!.symbol, 'onepiece:uuid-ddd');
  assert.equal(m!.game, 'onepiece');
});

test('ORACLE_PRIMARY defaults to pokemontcg (cutover is opt-in via env)', () => {
  assert.equal(config.oraclePrimary, 'pokemontcg');
});

test('getCandles: seeded history renders only BEFORE the first real mark; marks always win', async () => {
  const id = await upsertCardMarket(db, { ...base, symbol: 'candle-1', cardId: 'candle-1' });
  await db.query(
    `INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at)
     VALUES ($1, 50000000, 50000000, now() - interval '2 days')`,
    [id],
  );
  await db.query(
    `INSERT INTO chart_seed(market_id, day, price_e6) VALUES
       ($1, (now() - interval '400 days')::date, 30000000),  -- outside the 1Y window
       ($1, (now() - interval '10 days')::date, 40000000),   -- pre-mark: rendered
       ($1, (now() - interval '1 day')::date,  45000000),    -- post-first-mark: marks win
       ($1, (now() - interval '9 days')::date, 0)`, // "no history" sentinel: dropped
    [id],
  );
  const candles = await getCandles(db, id, 365);
  assert.deepEqual(candles.map((c) => c.value), [40, 50]);
  assert.ok(candles[0].time < candles[1].time, 'ascending time order');

  // a market with NO marks renders its whole in-window seed series
  const bare = await upsertCardMarket(db, { ...base, symbol: 'candle-2', cardId: 'candle-2' });
  await db.query(
    `INSERT INTO chart_seed(market_id, day, price_e6) VALUES
       ($1, (now() - interval '5 days')::date, 20000000), ($1, (now() - interval '3 days')::date, 25000000)`,
    [bare],
  );
  assert.deepEqual((await getCandles(db, bare, 30)).map((c) => c.value), [20, 25]);
});

test('gradeLadder: full PSA/BGS/CGC ladder, oracle price chain per grade, sorted', () => {
  const graded = {
    psa: { '10': { ebay: { avg_7d: 418.5 } }, '9': { ebay: { avg_1d: 150 } } }, // 7d -> 1d chain
    cgc: { '9.5': { ebay: { avg_30d: 120 } } },
    bgs: { '10': { ebay: { avg_7d: 0 } }, '9.5': { ebay: { avg_7d: 200 } } }, // 0 = no data: dropped
  };
  assert.deepEqual(gradeLadder(graded), [
    { grader: 'PSA', grade: '10', priceE6: '418500000' },
    { grader: 'PSA', grade: '9', priceE6: '150000000' },
    { grader: 'BGS', grade: '9.5', priceE6: '200000000' },
    { grader: 'CGC', grade: '9.5', priceE6: '120000000' },
  ]);
  assert.deepEqual(gradeLadder(null), [], 'prints without a graded object (non-tpl payloads) have no ladder');
});

test('getMarketDetails surfaces the ladder from the latest ACCEPTED print only', async () => {
  const id = await upsertCardMarket(db, { ...base, symbol: 'details-1', cardId: 'details-1' });
  const pl = (psa10: number) =>
    JSON.stringify({ tcgpricelookup: { prices: { graded: { psa: { '10': { ebay: { avg_7d: psa10 } } } } } } });
  await db.query(
    `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, is_accepted) VALUES
       ($1, 1000000, $2::jsonb, now() - interval '2 days', true),
       ($1, 1000000, $3::jsonb, now() - interval '1 day',  false)`, // newer but REJECTED: ignored
    [id, pl(300), pl(999)],
  );
  const d = await getMarketDetails(db, id);
  assert.deepEqual(d!.grades, [{ grader: 'PSA', grade: '10', priceE6: '300000000' }]);

  // markets with no tpl print yet (e.g. pokemon pre-handover) -> empty ladder, panel falls back to PSA-10
  const bare = await upsertCardMarket(db, { ...base, symbol: 'details-2', cardId: 'details-2' });
  assert.deepEqual((await getMarketDetails(db, bare))!.grades, []);
});
