import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { ScrydexClient, extractRaw, scrydexSlug, scoreConfidence, combinePrice, fromScrydexCard, fetchScrydexTrackedCards, SCRYDEX_BATCH_SIZE, verifyScrydexSignature, backfillScrydexIds } =
  await import('./scrydex.ts');
const { ProviderLimiter } = await import('./limiter.ts');
const { upsertCardMarket } = await import('../markets.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

// No-wait limiter so client tests exercise HTTP behaviour, not pacing.
const instantLimiter = { acquire: async () => {} } as unknown as InstanceType<typeof ProviderLimiter>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function clientWith(responses: Response[], calls: string[] = []) {
  const fetchFn = (async (url: any) => {
    calls.push(String(url));
    const r = responses.shift();
    if (!r) throw new Error('test fetch exhausted');
    return r;
  }) as typeof fetch;
  return { client: new ScrydexClient(db, { fetchFn, limiter: instantLimiter, retryBaseMs: 1 }), calls };
}

type CardT = import('./scrydex.ts').ScrydexCard;

test('scrydexSlug maps our games (mtg -> magicthegathering); unknown -> null', () => {
  assert.equal(scrydexSlug('pokemon'), 'pokemon');
  assert.equal(scrydexSlug('onepiece'), 'onepiece');
  assert.equal(scrydexSlug('mtg'), 'magicthegathering');
  assert.equal(scrydexSlug('lorcana'), null);
});

test('searchCards builds the slug path with include=prices and returns the envelope', async () => {
  const { client, calls } = clientWith([json({ data: [{ id: 'a' }], total_count: 1, page: 1, page_size: 100 })]);
  const page = await client.searchCards('magicthegathering', { q: 'Black Lotus', pageSize: 100 }, 'refresh');
  assert.equal(page.total_count, 1);
  assert.equal(page.data[0].id, 'a');
  assert.match(calls[0], /\/magicthegathering\/v1\/cards\?/);
  assert.match(calls[0], /include=prices/);
  assert.match(calls[0], /q=Black\+Lotus/);
});

test('getCard unwraps the data envelope (and a bare card)', async () => {
  const wrapped = clientWith([json({ data: { id: 'sv-1', name: 'Card' } })]);
  assert.equal((await wrapped.client.getCard('pokemon', 'sv-1', 'refresh'))?.id, 'sv-1');
  const bare = clientWith([json({ id: 'op-1', name: 'Luffy' })]);
  assert.equal((await bare.client.getCard('onepiece', 'op-1', 'refresh'))?.id, 'op-1');
});

test('429 is retried then succeeds; a non-retryable status throws immediately', async () => {
  const ok = clientWith([json({ error: 'rate limited' }, 429, { 'retry-after': '0' }), json({ data: [], total_count: 0 })]);
  await ok.client.searchCards('pokemon', { q: 'x' }, 'refresh');
  assert.equal(ok.calls.length, 2);
  const bad = clientWith([json({ error: 'unauthorized' }, 401)]);
  await assert.rejects(bad.client.searchCards('pokemon', { q: 'x' }, 'refresh'), /scrydex 401/);
  assert.equal(bad.calls.length, 1);
});

// --- extractRaw (the parse) ---
const card = (variants: NonNullable<CardT['variants']>): CardT => ({ id: 'x', name: 'Test', language_code: 'EN', variants });
const raw = (condition: string, market: number, extra: Record<string, unknown> = {}) => ({ type: 'raw', condition, market, ...extra });

test('extractRaw: matches the variant by tcgplayer product_id and reads NM market/low/high/trend', () => {
  const c = card([
    {
      name: 'holofoil',
      marketplaces: [{ name: 'tcgplayer', product_id: '12345' }],
      prices: [
        raw('NM', 100, { low: 90, high: 120, currency: 'USD', trends: { days_1: { percent_change: 2.5 } } }),
        { type: 'graded', company: 'PSA', grade: '10', market: 500, currency: 'USD' },
      ],
    },
  ]);
  assert.deepEqual(extractRaw(c, 12345), {
    market: 100, low: 90, high: 120, currency: 'USD', day1Pct: 2.5, condition: 'NM', variant: 'holofoil',
  });
  assert.equal(extractRaw(c, 99999), null, 'no matching product_id -> null');
  assert.equal(extractRaw(c, null), null, 'no tcgplayer id -> null');
});

test('extractRaw: NM absent -> LP fallback; graded-only -> null; JPY currency passes through', () => {
  const lp = card([{ marketplaces: [{ name: 'tcgplayer', product_id: 7 }], prices: [raw('LP', 17.96, { currency: 'USD' })] }]);
  assert.equal(extractRaw(lp, 7)?.condition, 'LP');
  assert.equal(extractRaw(lp, 7)?.market, 17.96);

  const gradedOnly = card([{ marketplaces: [{ name: 'tcgplayer', product_id: 7 }], prices: [{ type: 'graded', company: 'PSA', grade: '10', market: 999 }] }]);
  assert.equal(extractRaw(gradedOnly, 7), null, 'no raw price -> null');

  const jp = card([{ marketplaces: [{ name: 'tcgplayer', product_id: 7 }], prices: [raw('NM', 1500, { currency: 'JPY' })] }]);
  assert.equal(extractRaw(jp, 7)?.currency, 'JPY', 'JP printings report JPY (FX handled downstream)');

  const noMarket = card([{ marketplaces: [{ name: 'tcgplayer', product_id: 7 }], prices: [{ type: 'raw', condition: 'NM', low: 5 }] }]);
  assert.equal(extractRaw(noMarket, 7), null, 'a raw entry with no market value is skipped');
});

// --- scoreConfidence (the §6 decision tree) ---
type RawT = import('./scrydex.ts').ScrydexRaw;
const sx = (over: Partial<RawT> = {}): RawT => ({ market: 100, low: 90, high: 120, currency: 'USD', day1Pct: 0, condition: 'NM', variant: 'holofoil', ...over });

test('scoreConfidence: the worked cards (eBay or cross-feed confirms; thin/disagree → reduce_only)', () => {
  // Pikachu — eBay agrees → tradeable
  assert.equal(scoreConfidence(3200, sx({ market: 3200, low: 3100, high: 3300 }), { tcgpMarket: 3200, ebay1d: 3200 }), 'tradeable');
  // Sheoldred — eBay (20) disagrees but the cross-feed agrees → tradeable at $1,247
  assert.equal(scoreConfidence(1247, sx({ market: 1247 }), { tcgpMarket: 1247, ebay1d: 20 }), 'tradeable');
  // Apprentice — eBay (6449) disagrees, cross-feed agrees → tradeable at $1
  assert.equal(scoreConfidence(1, sx({ market: 1, low: 0.8, high: 1.2 }), { tcgpMarket: 1, ebay1d: 6449 }), 'tradeable');
  // no usable price → halted
  assert.equal(scoreConfidence(0, null, { tcgpMarket: null, ebay1d: null }), 'halted');
  // a corroborator present but disagrees (no spike) → reduce_only
  assert.equal(scoreConfidence(500, sx({ market: 500, low: 490, high: 510 }), { tcgpMarket: null, ebay1d: 50 }), 'reduce_only');
});

test('scoreConfidence: a SPIKE is corroborated only by eBay, never the cross-feed', () => {
  // both TCGplayer feeds jump to 900, eBay flat at 100 → reduce_only (cross-feed agreement can't un-gate a spike)
  assert.equal(scoreConfidence(900, sx({ market: 900, day1Pct: 800 }), { tcgpMarket: 900, ebay1d: 100 }), 'reduce_only');
  // only Scrydex jumps, tcgpl + eBay flat at 100 → reduce_only
  assert.equal(scoreConfidence(900, sx({ market: 900, day1Pct: 800 }), { tcgpMarket: 100, ebay1d: 100 }), 'reduce_only');
  // all three jump to 900 (eBay confirms) → tradeable, adopted
  assert.equal(scoreConfidence(900, sx({ market: 900, day1Pct: 800 }), { tcgpMarket: 900, ebay1d: 900 }), 'tradeable');
});

test('scoreConfidence: no corroborator → lean permissive on a tight spread', () => {
  assert.equal(scoreConfidence(500, sx({ market: 500, low: 480, high: 520 }), { tcgpMarket: null, ebay1d: null }), 'tradeable');
  assert.equal(scoreConfidence(500, sx({ market: 500, low: 100, high: 900 }), { tcgpMarket: null, ebay1d: null }), 'reduce_only');
});

// --- combinePrice (price source order + FX) ---
test('combinePrice: Scrydex market anchors the price; tcgpl TCGplayer is only the fallback', () => {
  assert.equal(combinePrice(sx({ market: 100 }), { tcgpMarket: 80, ebay1d: 100 }, null).priceUsd, 100); // Scrydex wins
  const fb = combinePrice(null, { tcgpMarket: 80, ebay1d: 80 }, null); // Scrydex miss → tcgpl TCGplayer
  assert.equal(fb.priceUsd, 80);
  assert.equal(fb.tier, 'tradeable'); // eBay 80 within band of 80
  assert.equal(combinePrice(null, { tcgpMarket: null, ebay1d: 100 }, null).tier, 'halted'); // no price source (eBay never prices)
});

test('combinePrice: JP printing is converted to USD via the FX rate; no rate → halt', () => {
  const jp = combinePrice(sx({ market: 1500, low: 1400, high: 1600, currency: 'JPY' }), { tcgpMarket: null, ebay1d: null }, 0.0067);
  assert.equal(jp.priceUsd, 10.05); // 1500 × 0.0067, $0.01 tick
  assert.equal(jp.tier, 'tradeable'); // spread tight, no corroborator → permissive
  const noRate = combinePrice(sx({ market: 1500, currency: 'JPY' }), { tcgpMarket: null, ebay1d: null }, null);
  assert.equal(noRate.priceUsd, 0);
  assert.equal(noRate.tier, 'halted'); // can't price a yen number as USD without a rate
});

// --- getCardsByIds (the batch query construction) ---
test('getCardsByIds builds an id-OR query (field repeated, not grouped) and chunks at the batch max', async () => {
  // one chunk: the q is `id:a OR id:b OR id:c` (NOT `id:(a OR b)` — that returns nothing, spec §3a)
  const one = clientWith([json({ data: [{ id: 'a' }, { id: 'b' }], total_count: 2 })]);
  await one.client.getCardsByIds('pokemon', ['a', 'b'], 'refresh');
  const q = decodeURIComponent(one.calls[0]).replace(/\+/g, ' '); // decode %3A→':'; '+' is the encoded space
  assert.match(q, /q=id:a OR id:b/);
  assert.doesNotMatch(q, /id:\(/, 'must not use the grouped id:(…) form');

  // chunking: SCRYDEX_BATCH_SIZE + 2 ids → two requests, all cards collected
  const ids = Array.from({ length: SCRYDEX_BATCH_SIZE + 2 }, (_, i) => `id-${i}`);
  const many = clientWith([
    json({ data: ids.slice(0, SCRYDEX_BATCH_SIZE).map((id) => ({ id })), total_count: SCRYDEX_BATCH_SIZE }),
    json({ data: ids.slice(SCRYDEX_BATCH_SIZE).map((id) => ({ id })), total_count: 2 }),
  ]);
  const cards = await many.client.getCardsByIds('pokemon', ids, 'refresh');
  assert.equal(cards.length, ids.length);
  assert.equal(many.calls.length, 2);
});

// --- fromScrydexCard (display fallback when tcgpl drops a card) ---
const sxFullCard = (id: string, productId: number, market: number, currency = 'USD'): CardT => ({
  id,
  name: 'Charizard',
  number: '6',
  rarity: 'Rare Holo',
  language_code: currency === 'JPY' ? 'JA' : 'EN',
  images: [{ type: 'front', small: `img/${id}/s`, large: `img/${id}/l` }],
  expansion: { id: 'base1', name: 'Base' },
  variants: [
    {
      name: 'holofoil',
      marketplaces: [{ name: 'tcgplayer', product_id: productId }],
      prices: [raw('NM', market, { low: market * 0.9, high: market * 1.1, currency, trends: { days_1: { percent_change: 0 } } })],
    },
  ],
});

test('fromScrydexCard maps Scrydex art/expansion/variant onto OUR market identity', () => {
  const oc = fromScrydexCard(sxFullCard('sx-1', 111, 50), {
    scrydex_card_id: 'sx-1', provider_card_id: 'tpl-1', symbol: 'sym-1', card_id: 'card-1', game: 'pokemon', tcgplayer_id: 111, featured: true,
  });
  assert.equal(oc.symbol, 'sym-1'); // identity is OURS, not the provider's
  assert.equal(oc.cardId, 'card-1');
  assert.equal(oc.displayName, 'Charizard #6');
  assert.equal(oc.variant, 'holofoil'); // the variant matched by tcgplayer_id
  assert.equal(oc.imageSmall, 'img/sx-1/s');
  assert.deepEqual(oc.metadata, { setName: 'Base', setSlug: 'base1', rarity: 'Rare Holo' });
  assert.equal(oc.featured, true);
});

// --- fetchScrydexTrackedCards (the orchestration: Scrydex anchor + tcgpl cross-check, joined per market) ---
type TplCardT = import('./tcgpricelookup.ts').TplCard;
const tplCardFor = (id: string, market: number, ebay1d: number): TplCardT => ({
  id, tcgplayer_id: null, name: 'Test', number: '6', rarity: null, variant: 'holofoil', image_url: `tpl/${id}`,
  last_price_update: '2026-06-16T00:00:00Z', updated_at: '2026-06-16T00:00:00Z',
  set: { slug: 'base1', name: 'Base' }, game: { slug: 'pokemon', name: 'Pokémon' },
  prices: { raw: { near_mint: { tcgplayer: { market }, ebay: { avg_1d: ebay1d, avg_7d: ebay1d } } } },
});

test('fetchScrydexTrackedCards: Scrydex anchors price; tcgpl fallback + Scrydex-only fallback both keep a card priced', async () => {
  // m1: both feeds present — Scrydex 100 anchors, eBay 100 agrees → tradeable
  const m1 = await upsertCardMarket(db, { symbol: 's-both', cardId: 's-both', displayName: 'Both', variant: 'holofoil', imageSmall: 'i1', providerCardId: 'tpl-1', tcgplayerId: 111 });
  // m2: Scrydex MISSING this pass — falls back to tcgpl TCGplayer market (80), eBay 80 agrees → tradeable
  const m2 = await upsertCardMarket(db, { symbol: 's-sxmiss', cardId: 's-sxmiss', displayName: 'SxMiss', variant: 'holofoil', imageSmall: 'i2', providerCardId: 'tpl-2', tcgplayerId: 222 });
  // m3: tcgpl DROPPED the card — Scrydex still prices it (50, tight spread, no corroborator → tradeable)
  const m3 = await upsertCardMarket(db, { symbol: 's-tpldrop', cardId: 's-tpldrop', displayName: 'TplDrop', variant: 'holofoil', imageSmall: 'i3', providerCardId: 'tpl-3', tcgplayerId: 333 });
  // m4: a JP printing — Scrydex reports JPY, converted to USD via the injected FX rate
  const m4 = await upsertCardMarket(db, { symbol: 's-jp', cardId: 's-jp', displayName: 'JP', variant: 'holofoil', imageSmall: 'i4', providerCardId: 'tpl-4', tcgplayerId: 444 });
  await db.query(
    `UPDATE markets SET scrydex_card_id = CASE id WHEN $1 THEN 'sx-1' WHEN $2 THEN 'sx-2' WHEN $3 THEN 'sx-3' WHEN $4 THEN 'sx-4' END WHERE id IN ($1,$2,$3,$4)`,
    [m1, m2, m3, m4],
  );

  const sxStub = { getCardsByIds: async () => [sxFullCard('sx-1', 111, 100), sxFullCard('sx-3', 333, 50), sxFullCard('sx-4', 444, 1500, 'JPY')] } as unknown as Parameters<typeof fetchScrydexTrackedCards>[1];
  const tplStub = { getCardsByIds: async () => [tplCardFor('tpl-1', 95, 100), tplCardFor('tpl-2', 80, 80)] } as unknown as Parameters<typeof fetchScrydexTrackedCards>[2];

  const cards = await fetchScrydexTrackedCards(db, sxStub, tplStub, async () => 0.0067); // stub FX — no live call
  const by = new Map(cards.map((c) => [c.symbol, c]));
  assert.equal(cards.length, 4);

  assert.equal(by.get('s-both')!.rawE6, 100_000_000n); // Scrydex anchor, not tcgpl's 95
  assert.equal(by.get('s-both')!.confident, true);
  assert.equal(by.get('s-both')!.displayName, 'Test #6'); // identity/display from the tcgpl card

  assert.equal(by.get('s-sxmiss')!.rawE6, 80_000_000n); // tcgpl TCGplayer fallback
  assert.equal(by.get('s-sxmiss')!.confident, true);

  assert.equal(by.get('s-tpldrop')!.rawE6, 50_000_000n); // Scrydex-only, kept alive
  assert.equal(by.get('s-tpldrop')!.confident, true);
  assert.equal(by.get('s-tpldrop')!.displayName, 'Charizard #6'); // display from the Scrydex card (tcgpl gone)

  assert.equal(by.get('s-jp')!.rawE6, 10_050_000n); // 1500 JPY × 0.0067 = $10.05, converted via the injected FX

  // clean up so the shared-db count assertions don't see these rows
  await db.query(`DELETE FROM markets WHERE id IN ($1,$2,$3,$4)`, [m1, m2, m3, m4]);
});

test('fetchScrydexTrackedCards: a scrydex_card_id shared by two variant-markets is fetched once (no wasted credit)', async () => {
  const a = await upsertCardMarket(db, { symbol: 'd-a', cardId: 'd-a', displayName: 'A', variant: 'holofoil', imageSmall: 'i', providerCardId: 'tpl-a', tcgplayerId: 11 });
  const b = await upsertCardMarket(db, { symbol: 'd-b', cardId: 'd-b', displayName: 'B', variant: 'reverse', imageSmall: 'i', providerCardId: 'tpl-b', tcgplayerId: 12 });
  await db.query(`UPDATE markets SET scrydex_card_id = 'shared-1' WHERE id IN ($1,$2)`, [a, b]);

  let seen: string[] = [];
  const sxStub = { getCardsByIds: async (_slug: string, ids: string[]) => { seen = ids; return []; } } as unknown as Parameters<typeof fetchScrydexTrackedCards>[1];
  const tplStub = { getCardsByIds: async () => [] } as unknown as Parameters<typeof fetchScrydexTrackedCards>[2];
  await fetchScrydexTrackedCards(db, sxStub, tplStub, async () => null);
  assert.deepEqual(seen, ['shared-1'], 'the shared Scrydex id is requested once, not per market');

  await db.query(`DELETE FROM markets WHERE id IN ($1,$2)`, [a, b]);
});

test('fetchScrydexTrackedCards scopes to the given Scrydex expansions (the webhook re-price path)', async () => {
  const a1 = await upsertCardMarket(db, { symbol: 'x-a1', cardId: 'x-a1', displayName: 'A1', variant: 'holofoil', imageSmall: 'i', providerCardId: 'tpl-a1', tcgplayerId: 901 });
  const b1 = await upsertCardMarket(db, { symbol: 'x-b1', cardId: 'x-b1', displayName: 'B1', variant: 'holofoil', imageSmall: 'i', providerCardId: 'tpl-b1', tcgplayerId: 902 });
  await db.query(
    `UPDATE markets SET scrydex_card_id = CASE id WHEN $1 THEN 'sx-a1' WHEN $2 THEN 'sx-b1' END,
            scrydex_expansion_id = CASE id WHEN $1 THEN 'expA' WHEN $2 THEN 'expB' END WHERE id IN ($1,$2)`,
    [a1, b1],
  );
  const sxStub = { getCardsByIds: async (_slug: string, ids: string[]) => ids.map((id) => sxFullCard(id, id === 'sx-a1' ? 901 : 902, 100)) } as unknown as Parameters<typeof fetchScrydexTrackedCards>[1];
  const tplStub = { getCardsByIds: async () => [] } as unknown as Parameters<typeof fetchScrydexTrackedCards>[2];

  const cards = await fetchScrydexTrackedCards(db, sxStub, tplStub, async () => null, ['expA']);
  assert.deepEqual(cards.map((c) => c.symbol), ['x-a1'], 'only the expA market is re-priced');

  await db.query(`DELETE FROM markets WHERE id IN ($1,$2)`, [a1, b1]);
});

// --- verifyScrydexSignature (Stripe-style HMAC, spec §8) ---
const SECRET = 'whsec_test_secret_value';
const NOW = 1_700_000_000;
const sign = (body: string, secret = SECRET, t = NOW) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('verifyScrydexSignature accepts a genuine signature and rejects tampering/replay/bad secret', () => {
  const body = '{"id":"evt_1","name":"pokemon.expansions.prices.raw_updated","data":{"expansion_ids":["base1"]}}';
  assert.equal(verifyScrydexSignature(body, sign(body), SECRET, NOW), true);
  assert.equal(verifyScrydexSignature(body + ' ', sign(body), SECRET, NOW), false, 'tampered body (extra byte) → reject');
  assert.equal(verifyScrydexSignature(body, sign(body, 'whsec_other'), SECRET, NOW), false, 'wrong secret → reject');
  assert.equal(verifyScrydexSignature(body, sign(body, SECRET, NOW - 400), SECRET, NOW), false, 'timestamp outside the 5-min window → reject (replay)');
  assert.equal(verifyScrydexSignature(body, sign(body, SECRET, NOW + 60), SECRET, NOW), true, 'a recent (clock-skew) timestamp is accepted');
  assert.equal(verifyScrydexSignature(body, 't=abc,v1=zz', SECRET, NOW), false, 'non-numeric t → reject');
  assert.equal(verifyScrydexSignature(body, undefined, SECRET, NOW), false, 'missing header → reject');
  assert.equal(verifyScrydexSignature(body, sign(body), '', NOW), false, 'unconfigured secret → reject');
  assert.equal(verifyScrydexSignature(body, `t=${NOW},v1=deadbeef`, SECRET, NOW), false, 'wrong-length digest → reject (no throw)');
});

// --- backfillScrydexIds (name search + product_id match → store scrydex ids) ---
test('backfillScrydexIds matches by tcgplayer product_id and stores scrydex_card_id + expansion_id; misses stay null', async () => {
  const hit = await upsertCardMarket(db, { symbol: 'bf-hit', cardId: 'bf-hit', displayName: 'Charizard #4', variant: 'holofoil', imageSmall: 'i', tcgplayerId: 42382 });
  const miss = await upsertCardMarket(db, { symbol: 'bf-miss', cardId: 'bf-miss', displayName: 'Nothing #1', variant: 'holofoil', imageSmall: 'i', tcgplayerId: 555 });

  const stub = {
    searchCards: async (_slug: string, params: { q?: string }) =>
      (params.q ?? '').includes('Charizard')
        ? { data: [sxFullCard('base1-4', 42382, 100)], total_count: 1, page: 1, page_size: 100 }
        : { data: [], total_count: 0, page: 1, page_size: 100 },
  } as unknown as InstanceType<typeof ScrydexClient>;

  // dry run (default): reports the proposed match + the miss, writes nothing
  const dry = await backfillScrydexIds(db, { client: stub });
  assert.equal(dry.matched, 1);
  assert.equal(dry.applied, 0, 'dry run writes nothing');
  assert.deepEqual(dry.matches[0], { id: hit, name: 'Charizard #4', scrydexCardId: 'base1-4', scrydexExpansionId: 'base1' });
  assert.ok(dry.unmatched.some((u) => u.id === miss), 'the unmatched market is reported');
  const stillNull = await db.query<{ c: string | null }>(`SELECT scrydex_card_id AS c FROM markets WHERE id=$1`, [hit]);
  assert.equal(stillNull.rows[0].c, null, 'dry run left the column untouched');

  // apply: persists scrydex_card_id + scrydex_expansion_id
  const applied = await backfillScrydexIds(db, { client: stub, apply: true });
  assert.equal(applied.applied, 1);
  const row = await db.query<{ c: string | null; e: string | null }>(`SELECT scrydex_card_id AS c, scrydex_expansion_id AS e FROM markets WHERE id=$1`, [hit]);
  assert.equal(row.rows[0].c, 'base1-4');
  assert.equal(row.rows[0].e, 'base1'); // sxFullCard sets expansion.id = 'base1'

  await db.query(`DELETE FROM markets WHERE id IN ($1,$2)`, [hit, miss]);
});
