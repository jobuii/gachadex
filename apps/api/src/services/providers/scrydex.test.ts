import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { ScrydexClient, extractRaw, scrydexSlug, scoreConfidence, combinePrice } = await import('./scrydex.ts');
const { ProviderLimiter } = await import('./limiter.ts');

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
