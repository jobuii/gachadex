import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { recomputeMark, getMarkClampBps } = await import('./marks.ts');
const { upsertCardMarket, getMarketById, listMarketsWithData } = await import('./markets.ts');
const { markGuardsReport } = await import('./mark-guards.ts');
const { ingest } = await import('./oracle.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const E6 = 1_000_000n;
const GUARD = (corroborated: boolean) => ({ corroborated, clampBps: 2500 });

const newMarket = async (name = 'Guard Card') => {
  const id = await upsertCardMarket(db, { symbol: `mtg:g-${randomUUID().slice(0, 8)}`, cardId: 'g', displayName: name, variant: 'Standard', imageSmall: 'i' });
  return (await getMarketById(db, id))!;
};
const fresh = (id: string) => getMarketById(db, id).then((m) => m!); // reload so mark_clamped reflects the last write (as ingestCard does)
const seed = (market: Awaited<ReturnType<typeof newMarket>>, usd: bigint) => db.tx((q) => recomputeMark(q, market, usd * E6, 0n, 0n)); // baseline mark, no guard
// One guarded recompute. The market is reloaded BEFORE the tx — getMarketById uses `db`, and pglite is
// single-connection, so a db.query inside an open db.tx would deadlock.
const guarded = async (id: string, usd: bigint, corroborated: boolean) => {
  const m = await fresh(id);
  await db.tx((q) => recomputeMark(q, m, usd * E6, 0n, 0n, GUARD(corroborated)));
};
const latestMark = async (id: string) =>
  BigInt((await db.query<{ m: string }>(`SELECT mark_price_e6::text AS m FROM marks WHERE market_id=$1 ORDER BY computed_at DESC, id DESC LIMIT 1`, [id])).rows[0].m);
const candidate = async (id: string) =>
  (await db.query<{ c: string | null }>(`SELECT mark_candidate_e6::text AS c FROM markets WHERE id=$1`, [id])).rows[0].c;
const latestIndex = async (id: string) =>
  BigInt((await db.query<{ i: string }>(`SELECT index_price_e6::text AS i FROM marks WHERE market_id=$1 ORDER BY computed_at DESC, id DESC LIMIT 1`, [id])).rows[0].i);
const events = async (id: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM mark_clamp_events WHERE market_id=$1`, [id])).rows[0].n);

test('the knob default is the spec 25% (2500 bps)', () => {
  assert.equal(getMarkClampBps(), 2500);
});

test('mark guard: an uncorroborated up-jump is capped to +clamp%, then creeps, then a corroborated move adopts fully', async () => {
  const m0 = await newMarket();
  await seed(m0, 100n); // baseline mark $100

  // $100 → $900 uncorroborated → capped at +25% = $125; clamp engages (one event), candidate persisted
  await guarded(m0.id, 900n, false);
  assert.equal(await latestMark(m0.id), 125n * E6);
  assert.equal((await fresh(m0.id)).mark_clamped, true);
  assert.equal(await candidate(m0.id), (900n * E6).toString());
  assert.equal(await events(m0.id), 1);
  // the stored working index is the GUARDED mark, not the raw $900 — so the next trade recomputes from
  // $125 and can't snap the mark back to the jump (the guard survives intraday trades).
  assert.equal(await latestIndex(m0.id), 125n * E6);
  const m0r = await fresh(m0.id);
  const workingIdx = await latestIndex(m0.id);
  await db.tx((q) => recomputeMark(q, m0r, workingIdx, 0n, 0n)); // simulate a trade-path recompute (no guard)
  assert.equal(await latestMark(m0.id), 125n * E6, 'a trade does not snap the clamped mark back to $900');

  // still $900 uncorroborated → creeps: $125 × 1.25 = $156.25; still clamped, NO new event
  await guarded(m0.id, 900n, false);
  assert.equal(await latestMark(m0.id), 156_250_000n);
  assert.equal((await fresh(m0.id)).mark_clamped, true);
  assert.equal(await events(m0.id), 1);

  // eBay confirms → adopt $900 immediately, disengage (second event), candidate cleared
  await guarded(m0.id, 900n, true);
  assert.equal(await latestMark(m0.id), 900n * E6);
  assert.equal((await fresh(m0.id)).mark_clamped, false);
  assert.equal(await candidate(m0.id), null);
  assert.equal(await events(m0.id), 2);
});

test('mark guard: an uncorroborated down-jump is capped to −clamp%', async () => {
  const m = await newMarket();
  await seed(m, 100n);
  await guarded(m.id, 20n, false);
  assert.equal(await latestMark(m.id), 75n * E6); // $100 × 0.75
  assert.equal((await fresh(m.id)).mark_clamped, true);
});

test('mark guard: a move within the threshold is adopted unclamped (no event)', async () => {
  const m = await newMarket();
  await seed(m, 100n);
  await guarded(m.id, 120n, false); // +20% < 25%
  assert.equal(await latestMark(m.id), 120n * E6);
  assert.equal((await fresh(m.id)).mark_clamped, false);
  assert.equal(await events(m.id), 0);
});

test('mark guard: with NO guard (the trade path / legacy feeds) a big jump is adopted freely', async () => {
  const m = await newMarket();
  await seed(m, 100n);
  const reloaded = await fresh(m.id);
  await db.tx((q) => recomputeMark(q, reloaded, 900n * E6, 0n, 0n)); // no guard arg
  assert.equal(await latestMark(m.id), 900n * E6);
  assert.equal((await fresh(m.id)).mark_clamped, false);
  assert.equal(await events(m.id), 0);
});

test('markGuardsReport surfaces a clamped market (candidate vs adopted, gap %) + the engage event', async () => {
  const m = await newMarket('Report Card');
  await seed(m, 100n);
  await guarded(m.id, 900n, false); // → adopted $125, candidate $900

  const rep = await markGuardsReport(db);
  const row = rep.clamped.find((x) => x.marketId === m.id);
  assert.ok(row, 'listed as clamped now');
  assert.equal(row!.candidateE6, (900n * E6).toString());
  assert.equal(row!.adoptedE6, (125n * E6).toString());
  assert.equal(row!.gapPct, 620); // (900 − 125) / 125 = 620%
  assert.ok(rep.flippedToday.some((e) => e.marketId === m.id && e.clamped), 'engage logged as flipped-today');
});

// --- end to end: the ingest path drives the guard only for a provider that sets markCorroborated ---
type OracleCardT = import('./oracle.ts').OracleCard;
const card = (over: Partial<OracleCardT> & Pick<OracleCardT, 'symbol' | 'rawE6'>): OracleCardT => ({
  game: 'mtg', cardId: 'gi', displayName: 'Ingest Guard #1', variant: 'Standard', imageSmall: 'i', confident: true, ...over,
});

test('ingest: a Scrydex-style card (markCorroborated set) clamps end-to-end and surfaces markStabilizing', async () => {
  const sym = 'mtg:guard-int';
  await ingest(db, async () => [card({ symbol: sym, providerCardId: 'p-gi', tcgplayerId: 700001, rawE6: 100n * E6, markCorroborated: true, observedAt: new Date('2026-06-17T00:00:00Z') })]);
  const id = (await listMarketsWithData(db)).find((m) => m.symbol === sym)!.id;
  assert.equal((await listMarketsWithData(db)).find((m) => m.id === id)!.markStabilizing, false);

  // uncorroborated jump through the real ingest path → clamped to $125, badge on
  await ingest(db, async () => [card({ symbol: sym, providerCardId: 'p-gi', tcgplayerId: 700001, rawE6: 900n * E6, markCorroborated: false, observedAt: new Date('2026-06-17T01:00:00Z') })]);
  const mv = (await listMarketsWithData(db)).find((m) => m.id === id)!;
  assert.equal(mv.markStabilizing, true, 'price-stabilizing badge surfaced');
  assert.equal(mv.markE6, (125n * E6).toString(), 'mark clamped via the ingest path');
});

test('ingest: a legacy card (no markCorroborated) is never guarded — a big jump is adopted', async () => {
  const sym = 'mtg:legacy-int';
  await ingest(db, async () => [card({ symbol: sym, providerCardId: 'p-li', tcgplayerId: 700002, rawE6: 100n * E6, observedAt: new Date('2026-06-17T00:00:00Z') })]);
  await ingest(db, async () => [card({ symbol: sym, providerCardId: 'p-li', tcgplayerId: 700002, rawE6: 900n * E6, observedAt: new Date('2026-06-17T01:00:00Z') })]);
  const mv = (await listMarketsWithData(db)).find((m) => m.symbol === sym)!;
  assert.equal(mv.markStabilizing, false);
  assert.equal(mv.markE6, (900n * E6).toString());
});
