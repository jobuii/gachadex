import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { TcgPriceLookupClient, TPL_BATCH_SIZE, rawPriceUsd, priceCard, gradedPsa10Usd, fromTplCard, fetchTrackedCards } =
  await import('./tcgpricelookup.ts');
const { ProviderLimiter } = await import('./limiter.ts');
const { upsertCardMarket, cardSymbol } = await import('../markets.ts');
const { ingest } = await import('../oracle.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

// A no-wait limiter so client tests exercise HTTP behavior, not pacing (pacing has its own tests).
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
  return { client: new TcgPriceLookupClient(db, { fetchFn, limiter: instantLimiter, retryBaseMs: 1 }), calls };
}

test('searchCards builds the query and returns the envelope', async () => {
  const { client, calls } = clientWith([json({ data: [{ id: 'x', name: 'Pika' }], total: 1, limit: 20, offset: 0 })]);
  const page = await client.searchCards({ q: 'pikachu', game: 'pokemon', limit: 20 }, 'search');
  assert.equal(page.total, 1);
  assert.equal(page.data[0].name, 'Pika');
  assert.match(calls[0], /\/cards\/search\?q=pikachu&game=pokemon&limit=20$/);
});

test('getCardsByIds chunks at the provider batch max', async () => {
  const ids = Array.from({ length: TPL_BATCH_SIZE * 2 + 5 }, (_, i) => `id-${i}`);
  const { client, calls } = clientWith([
    json({ data: ids.slice(0, 20).map((id) => ({ id })), total: 20 }),
    json({ data: ids.slice(20, 40).map((id) => ({ id })), total: 20 }),
    json({ data: ids.slice(40).map((id) => ({ id })), total: 5 }),
  ]);
  const cards = await client.getCardsByIds(ids, 'refresh');
  assert.equal(cards.length, ids.length);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes(encodeURIComponent('id-0,')), 'first chunk in first call');
  assert.ok(calls[2].includes(encodeURIComponent('id-40')), 'tail chunk in last call');
});

test('429 is retried (honoring retry-after) and then succeeds', async () => {
  const { client, calls } = clientWith([
    json({ error: 'rate limited' }, 429, { 'retry-after': '0' }),
    json({ data: [], total: 0 }),
  ]);
  const page = await client.searchCards({ q: 'x' }, 'search');
  assert.equal(page.total, 0);
  assert.equal(calls.length, 2);
});

test('a Cloudflare challenge page (HTML 403) is treated as retryable', async () => {
  const challenge = new Response('<html>challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  const { client, calls } = clientWith([challenge, json({ data: [], total: 0 })]);
  await client.searchCards({ q: 'x' }, 'search');
  assert.equal(calls.length, 2);
});

test('a non-retryable status throws immediately (no blind retries)', async () => {
  const { client, calls } = clientWith([json({ error: 'unauthorized' }, 401)]);
  await assert.rejects(client.searchCards({ q: 'x' }, 'search'), /tcgpricelookup 401/);
  assert.equal(calls.length, 1);
});

test('attempts are bounded: persistent 5xx exhausts retries and throws', async () => {
  const { client, calls } = clientWith([json({}, 503), json({}, 503), json({}, 503), json({}, 503), json({}, 503)]);
  await assert.rejects(client.searchCards({ q: 'x' }, 'search'), /tcgpricelookup 503/);
  assert.equal(calls.length, 4); // maxAttempts default
});

// ---------------------------------------------------------------------------
// OracleCard fetcher (P3)
// ---------------------------------------------------------------------------

const prices = (nm: { market?: number; avg_7d?: number }, lp?: { market?: number }, psa10?: { avg_7d?: number; avg_1d?: number; avg_30d?: number }) => ({
  raw: {
    near_mint: { tcgplayer: { market: nm.market }, ebay: { avg_7d: nm.avg_7d } },
    ...(lp ? { lightly_played: { tcgplayer: { market: lp.market } } } : {}),
  },
  ...(psa10 ? { graded: { psa: { '10': { ebay: psa10 } } } } : {}),
});
type TplCardT = import('./tcgpricelookup.ts').TplCard;
const tplCard = (id: string, p: TplCardT['prices'], extra: Partial<TplCardT> = {}): TplCardT => ({
  id, tcgplayer_id: '284251', name: 'Card', number: '006/197', rarity: 'Rare', variant: 'Standard',
  image_url: 'img/c', updated_at: '2026-06-10T12:00:00Z', set: { slug: 's', name: 'Some Set' },
  game: { slug: 'pokemon', name: 'Pokemon' }, prices: p, ...extra,
});

// A card with a NM price envelope carrying the median's three signals (omit a field to leave it absent).
const env = (s: { spot?: number; a1?: number; a7?: number }): Pick<TplCardT, 'prices'> => ({
  prices: { raw: { near_mint: { tcgplayer: { market: s.spot }, ebay: { avg_1d: s.a1, avg_7d: s.a7 } } } },
});

test('priceCard: median of (eBay 1d, TCGplayer market, eBay 7d); a lone outlier is outvoted, no clamp', () => {
  // three signals agree -> the median is the middle value, trusted
  assert.deepEqual(priceCard(env({ a1: 10.8, spot: 9.8, a7: 10.1 })), { usd: 10.1, confident: true });
  // a hot 1d avg is NOT clamped — it's just the high signal; median([10,10,13]) = 10
  assert.deepEqual(priceCard(env({ spot: 10, a7: 10, a1: 13 })), { usd: 10, confident: true });
  // garbage HIGH spot -> outvoted by the median (the middle of three), gated low-confidence
  assert.deepEqual(priceCard(env({ spot: 4699, a1: 7.75, a7: 9.96 })), { usd: 9.96, confident: false });
  // garbage HIGH eBay 7d -> median ignores it, gated
  assert.deepEqual(priceCard(env({ spot: 1.05, a1: 1.79, a7: 6449.95 })), { usd: 1.79, confident: false });
  // two signals agreeing within SPREAD_MAX_RATIO -> trusted (median = their average)
  assert.deepEqual(priceCard(env({ spot: 10, a7: 15 })), { usd: 12.5, confident: true });
  // two signals disagreeing beyond SPREAD_MAX_RATIO -> priced but reduce-only
  assert.deepEqual(priceCard(env({ spot: 10, a7: 21 })), { usd: 15.5, confident: false });
  // a single uncrossable signal can't be corroborated -> priced but low-confidence
  assert.deepEqual(priceCard(env({ spot: 50 })), { usd: 50, confident: false });
  // nothing priced -> ineligible
  assert.deepEqual(priceCard({ prices: { raw: {} } }), { usd: 0, confident: false });
});

test('rawPriceUsd delegates to priceCard().usd (one price definition)', () => {
  const e = env({ spot: 9.8, a7: 10.1, a1: 10.8 });
  assert.equal(rawPriceUsd(e), priceCard(e).usd);
  assert.equal(rawPriceUsd(tplCard('d', prices({}, { market: 40 }))), 40); // NM empty -> lightly_played fallback
});

test('gradedPsa10Usd: avg_7d -> avg_1d -> avg_30d -> null', () => {
  assert.equal(gradedPsa10Usd(tplCard('a', prices({ market: 30 }, undefined, { avg_7d: 400, avg_1d: 410 }))), 400);
  assert.equal(gradedPsa10Usd(tplCard('b', prices({ market: 30 }, undefined, { avg_1d: 410, avg_30d: 390 }))), 410);
  assert.equal(gradedPsa10Usd(tplCard('c', prices({ market: 30 }, undefined, { avg_30d: 390 }))), 390);
  assert.equal(gradedPsa10Usd(tplCard('d', prices({ market: 30 }))), null);
});

test('fromTplCard: identity comes from the TRACKED market row, data from the provider', () => {
  const oc = fromTplCard(
    tplCard('uuid-x', prices({ market: 100 }, undefined, { avg_7d: 500 })),
    { provider_card_id: 'uuid-x', symbol: 'sv-old-1', card_id: 'sv-old-1', game: 'pokemon', featured: true },
  );
  assert.equal(oc.symbol, 'sv-old-1'); // the legacy market's own symbol — re-priced in place
  assert.equal(oc.cardId, 'sv-old-1');
  assert.equal(oc.tcgplayerId, 284251); // string from the API -> number
  assert.equal(oc.providerCardId, 'uuid-x');
  assert.equal(oc.rawE6, 100_000_000n);
  assert.equal(oc.gradedE6, 500_000_000n);
  assert.equal(oc.observedAt?.toISOString(), '2026-06-10T12:00:00.000Z'); // no last_price_update -> falls back to updated_at
  assert.equal(oc.featured, true); // basket eligibility flows from the market row, not the provider
});

test('fromTplCard: observedAt is the PRICE-freshness timestamp, not the static record timestamp', () => {
  // Regression: keying print dedup on updated_at (≈static) froze every mark at the first post-cutover
  // print -> 0% 24h change forever. last_price_update advances per re-price, so it must win.
  const mkt = { provider_card_id: 'x', symbol: 's', card_id: 's', game: 'pokemon', featured: false };
  const fresh = fromTplCard(tplCard('x', prices({ market: 10 }), { last_price_update: '2026-06-13T18:00:00Z' }), mkt);
  assert.equal(fresh.observedAt?.toISOString(), '2026-06-13T18:00:00.000Z', 'prefers last_price_update');
  const stale = fromTplCard(tplCard('x', prices({ market: 10 }), { last_price_update: null }), mkt);
  assert.equal(stale.observedAt?.toISOString(), '2026-06-10T12:00:00.000Z', 'falls back to updated_at when absent');
});

test('fetchTrackedCards + ingest: legacy + provider-native markets re-price IN PLACE (no twins)', async () => {
  // a backfilled legacy Pokémon market (bare symbol) + a provider-native One Piece market
  const legacyId = await upsertCardMarket(db, {
    symbol: 'sv-old-1', cardId: 'sv-old-1', displayName: 'Old Charizard #6', variant: 'holofoil',
    imageSmall: 'img/old', metadata: { setName: 'Old Set' }, providerCardId: 'uuid-legacy', tcgplayerId: 111,
    featured: true, // backfilled featured market — keeps its graded write + basket slot
  });
  const nativeId = await upsertCardMarket(db, {
    game: 'onepiece', symbol: cardSymbol('onepiece', 'uuid-native'), cardId: 'uuid-native', displayName: 'Luffy #OP01-001',
    variant: 'Standard', imageSmall: 'img/luffy', providerCardId: 'uuid-native',
  });

  const stub = {
    getCardsByIds: async (ids: string[]) => {
      assert.deepEqual([...ids].sort(), ['uuid-legacy', 'uuid-native']);
      return [
        tplCard('uuid-legacy', prices({ market: 1500 }, undefined, { avg_7d: 5000 }), { name: 'Charizard', number: '6' }),
        tplCard('uuid-native', prices({ market: 250 }), { name: 'Monkey D. Luffy', number: 'OP01-001', game: { slug: 'onepiece', name: 'One Piece' }, tcgplayer_id: null }),
      ];
    },
  } as unknown as InstanceType<typeof TcgPriceLookupClient>;

  const cards = await fetchTrackedCards(db, stub);
  assert.equal(cards.length, 2);

  const before = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM markets WHERE kind = 'card'`);
  const r = await ingest(db, () => fetchTrackedCards(db, stub));
  assert.equal(r.cards, 2);
  const after = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM markets WHERE kind = 'card'`);
  assert.equal(after.rows[0].n, before.rows[0].n, 'no duplicate markets created');

  // the legacy market was re-priced in place: same row, fresh provider data + print at the provider timestamp
  const legacy = await db.query<{ display_name: string; graded: string | null }>(
    `SELECT display_name, graded_psa10_e6::text AS graded FROM markets WHERE id = $1`, [legacyId],
  );
  assert.equal(legacy.rows[0].display_name, 'Charizard #6');
  assert.equal(legacy.rows[0].graded, (5000n * 1_000_000n).toString());
  const print = await db.query<{ v: string; at: string }>(
    `SELECT index_price_e6::text AS v, source_observed_at AS at FROM oracle_prices WHERE market_id = $1`, [legacyId],
  );
  assert.equal(print.rows[0].v, (1500n * 1_000_000n).toString());
  assert.equal(new Date(print.rows[0].at).toISOString(), '2026-06-10T12:00:00.000Z');

  // the provider-native market printed too
  const native = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM oracle_prices WHERE market_id = $1`, [nativeId]);
  assert.equal(native.rows[0].n, '1');
});
