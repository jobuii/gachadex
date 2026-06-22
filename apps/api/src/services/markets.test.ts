import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { config } = await import('../config.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket, cardSymbol, getMarketById, getCandles, getMarketDetails, listMarketsWithData } = await import('./markets.ts');
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

test('change24hPct: real move off the marks series, flat = 0, <24h history = 0', async () => {
  const moved = await upsertCardMarket(db, { ...base, symbol: 'chg-moved', cardId: 'chg-moved' });
  const flat = await upsertCardMarket(db, { ...base, symbol: 'chg-flat', cardId: 'chg-flat' });
  const fresh = await upsertCardMarket(db, { ...base, symbol: 'chg-fresh', cardId: 'chg-fresh' });
  const mark = (id: string, e6: number, ago: string) =>
    db.query(
      `INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES ($1, $2, $2, now() - ($3)::interval)`,
      [id, e6, ago],
    );
  // moved: $100 ~30h ago (the 24h reference) -> $125 now = +25%; an intraday mark must NOT be the ref
  await mark(moved, 100_000_000, '30 hours');
  await mark(moved, 110_000_000, '20 hours');
  await mark(moved, 125_000_000, '1 hour');
  // flat: same price across the window = 0
  await mark(flat, 80_000_000, '30 hours');
  await mark(flat, 80_000_000, '1 hour');
  // fresh: only a recent mark (no >=24h reference) = 0
  await mark(fresh, 60_000_000, '2 hours');

  const views = await listMarketsWithData(db);
  const by = new Map(views.map((v) => [v.id, v]));
  assert.equal(by.get(moved)!.change24hPct, 25);
  assert.equal(by.get(flat)!.change24hPct, 0);
  assert.equal(by.get(fresh)!.change24hPct, 0);
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
  // seeded days are a single price → flat OHLC, no volume
  const seedBar = (await getCandles(db, bare, 30))[0];
  assert.deepEqual([seedBar.open, seedBar.high, seedBar.low, seedBar.close, seedBar.volume], [20, 20, 20, 20, 0]);
});

test('getCandles: OHLC aggregates multiple marks per bucket; volume comes from fills', async () => {
  const id = await upsertCardMarket(db, { ...base, symbol: 'ohlc-1', cardId: 'ohlc-1' });
  // four marks anchored to the SAME day bucket (1h–4h into today, deterministic regardless of run time):
  // open=100, high=130, low=90, close=110 by computed_at order
  await db.query(
    `INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES
       ($1, 100000000, 100000000, date_trunc('day', now()) + interval '1 hour'),
       ($1, 130000000, 130000000, date_trunc('day', now()) + interval '2 hours'),
       ($1,  90000000,  90000000, date_trunc('day', now()) + interval '3 hours'),
       ($1, 110000000, 110000000, date_trunc('day', now()) + interval '4 hours')`,
    [id],
  );
  const c = (await getCandles(db, id, 30)).at(-1)!; // day bucket → one candle for today
  assert.deepEqual([c.open, c.high, c.low, c.close, c.value], [100, 130, 90, 110, 110]);
  assert.equal(c.volume, 0, 'no fills yet');

  // a fill in that bucket → volume = qty(2.0) × price($110) = $220 notional
  const uid = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [uid, 'pk-' + uid.slice(0, 8)]);
  await db.query(
    `INSERT INTO orders(id, user_id, market_id, kind, side, qty_e6, leverage_e2, status, idempotency_key)
     VALUES($1, $2, $3, 'market', 'long', 2000000, 100, 'filled', $4)`,
    [randomUUID(), uid, id, randomUUID()],
  );
  const oid = (await db.query<{ id: string }>(`SELECT id FROM orders WHERE user_id = $1`, [uid])).rows[0].id;
  const pid = randomUUID();
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status)
     VALUES($1, $2, $3, 'long', 2000000, 110000000, 1000000, 100, 'open')`,
    [pid, uid, id],
  );
  await db.query(
    `INSERT INTO fills(id, order_id, position_id, market_id, exec_price_e6, qty_e6, created_at)
     VALUES($1, $2, $3, $4, 110000000, 2000000, date_trunc('day', now()) + interval '2 hours')`,
    [randomUUID(), oid, pid, id],
  );
  assert.equal((await getCandles(db, id, 30)).at(-1)!.volume, 220, 'fills notional aggregated into the bucket');
});

test('gradeLadder: full PSA/BGS/CGC ladder, oracle price chain per grade, sorted', () => {
  const graded = {
    psa: {
      '10': { ebay: { avg_7d: 418.5 } },
      '9': { ebay: { avg_1d: 150 } }, // 7d -> 1d chain
      '104': { ebay: { avg_7d: 17500 } }, // mis-parsed listing (collector number as grade) — verified live; dropped
      'authentic': { ebay: { avg_7d: 50 } }, // non-numeric grade: dropped
    },
    cgc: { '9.5': { ebay: { avg_30d: 120 } } },
    bgs: { '10': { ebay: { avg_7d: 0 } }, '9.5': { ebay: { avg_7d: 200 } } }, // 0 = no data: dropped
    sgc: { '10': { ebay: { avg_7d: 90 } } }, // unranked grader: after PSA/BGS/CGC
  };
  assert.deepEqual(gradeLadder(graded), [
    { grader: 'PSA', grade: '10', priceE6: '418500000' },
    { grader: 'PSA', grade: '9', priceE6: '150000000' },
    { grader: 'BGS', grade: '9.5', priceE6: '200000000' },
    { grader: 'CGC', grade: '9.5', priceE6: '120000000' },
    { grader: 'SGC', grade: '10', priceE6: '90000000' },
  ]);
  assert.deepEqual(gradeLadder(null), [], 'prints without a graded object (non-tpl payloads) have no ladder');
});

test('getMarketDetails: prefers the Scrydex graded ladder, falls back to the tcgpl ladder', async () => {
  const insertPrint = (marketId: string, payload: unknown) =>
    db.query(
      `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, is_accepted)
       VALUES ($1, 100000000, $2, now(), true)`,
      [marketId, JSON.stringify(payload)],
    );

  // card A: a print carrying BOTH a Scrydex ladder and a tcgpl graded object → Scrydex wins
  const a = await upsertCardMarket(db, { ...base, symbol: 'grd-sx', cardId: 'grd-sx' });
  const sxLadder = [
    { grader: 'PSA', grade: '10', priceE6: '7000000000' },
    { grader: 'CGC', grade: '9', priceE6: '4500000000' },
  ];
  await insertPrint(a, { scrydex: { graded: sxLadder }, tcgpricelookup: { prices: { graded: { psa: { '10': { ebay: { avg_7d: 99999 } } } } } } });
  assert.deepEqual((await getMarketDetails(db, a))!.grades, sxLadder, 'Scrydex ladder preferred over tcgpl');

  // card B: a print with ONLY a tcgpl graded object → falls back to the tcgpl ladder
  const b = await upsertCardMarket(db, { ...base, symbol: 'grd-tpl', cardId: 'grd-tpl' });
  const tplGraded = { psa: { '10': { ebay: { avg_7d: 1234 } } } };
  await insertPrint(b, { tcgpricelookup: { prices: { graded: tplGraded } } });
  assert.deepEqual((await getMarketDetails(db, b))!.grades, gradeLadder(tplGraded), 'falls back to the tcgpl ladder');
});

test('getMarketDetails resolves the set release year by slug, then by game+name fallback', async () => {
  await db.query(
    `INSERT INTO tcg_sets(game, slug, name, release_year) VALUES('pokemon', 'obsidian-flames', 'Obsidian Flames', 2023)`,
  );
  // a card carrying setSlug -> matched precisely by slug
  const bySlug = await upsertCardMarket(db, {
    ...base, symbol: 'ry-slug', cardId: 'ry-slug',
    metadata: { setName: 'Obsidian Flames', setSlug: 'obsidian-flames', rarity: 'Double Rare' },
  });
  assert.equal((await getMarketDetails(db, bySlug))!.releaseYear, 2023);

  // a legacy card with only setName (no slug) -> matched by game + name
  const byName = await upsertCardMarket(db, {
    ...base, symbol: 'ry-name', cardId: 'ry-name', metadata: { setName: 'Obsidian Flames', rarity: 'Rare' },
  });
  assert.equal((await getMarketDetails(db, byName))!.releaseYear, 2023);

  // an unknown set -> null (no year shown)
  const unknown = await upsertCardMarket(db, {
    ...base, symbol: 'ry-none', cardId: 'ry-none', metadata: { setName: 'Mystery Set', setSlug: 'mystery', rarity: 'Rare' },
  });
  assert.equal((await getMarketDetails(db, unknown))!.releaseYear, null);
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
  assert.equal(d!.variant, 'holofoil', 'the market row variant is surfaced for the panel');

  // markets with no tpl print yet (e.g. pokemon pre-handover) -> empty ladder, panel falls back to PSA-10
  const bare = await upsertCardMarket(db, { ...base, symbol: 'details-2', cardId: 'details-2' });
  assert.deepEqual((await getMarketDetails(db, bare))!.grades, []);
});
