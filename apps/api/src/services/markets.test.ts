import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { config } = await import('../config.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket, cardSymbol, getMarketById } = await import('./markets.ts');

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
