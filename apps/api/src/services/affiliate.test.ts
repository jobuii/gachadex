import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.FEE_BPS = '100'; // 1% — so fees (and thus discount/cashback) are non-zero
process.env.FEE_LP_SHARE_PCT = '50'; // house keeps 50% → cashback ceiling = 5000 bps
process.env.CHAT_BIG_BET_USD = '100000';
process.env.CHAT_BIG_WIN_USD = '100000';

const { fee, notional } = await import('@pokex/pricing');
const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { openPosition, getUserPositions } = await import('./engine.ts');
const { getFeeBps } = await import('./fees.ts');
const { getBalance, getOrCreateUserAccount, getOrCreateSystemAccount } = await import('./ledger.ts');
const {
  resolveFeeAffiliate, applyFeeDiscount, maxCashbackBps, setAffiliateTerms, getCashbackTotal, listAffiliates,
  setPlatformAffiliateDefaults, getPlatformCashbackBps, getPlatformFeeDiscountBps, getPlatformGameRevenueBps,
  resolveGameRevenueAffiliate, maxGameRevenueBps,
} = await import('./affiliate.ts');

await initDb();
const db = await getDb();
await ingest(db, async () =>
  fromPokemontcg([{ id: 'card-x', name: 'Test', number: '1', images: { small: '' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } }]),
);
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;
const LP_PART = (f: bigint): bigint => (f * 50n) / 100n; // matches chargeFee's feeLpSharePct split

async function setMark(price: number): Promise<void> {
  const e6 = (BigInt(Math.round(price * 1000)) * 1000n).toString();
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1, $2, $2)`, [market.id, e6]);
}
async function fundedUser(referredBy?: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey, referred_by) VALUES($1, $2, $3)`, [id, 'pk-' + id.slice(0, 8), referredBy ?? null]);
  await creditFaucet(db, id, 100_000);
  return id;
}
async function trade(user: string): Promise<void> {
  await openPosition(db, user, { marketId: market.id, side: 'long', qtyE6: 1_000_000n, leverage: 5, idempotencyKey: randomUUID() });
}
// the trade's recorded (net) fee + the gross fee it would have been at that exec price (the synthetic
// mark drifts with OI, so each trade's gross differs — derive it from the fill rather than assuming).
async function lastFill(user: string): Promise<{ net: bigint; gross: bigint }> {
  const [pos] = await getUserPositions(db, user);
  const r = await db.query<{ fee_uusdc: string; exec_price_e6: string; qty_e6: string }>(
    `SELECT fee_uusdc, exec_price_e6, qty_e6 FROM fills WHERE position_id = $1 ORDER BY created_at LIMIT 1`,
    [pos.id],
  );
  const row = r.rows[0];
  return { net: BigInt(row.fee_uusdc), gross: fee(notional(BigInt(row.qty_e6), BigInt(row.exec_price_e6)), getFeeBps()) };
}

// the platform defaults are a process-global knob; reset after every test so a setter can't leak into the next.
afterEach(() => setPlatformAffiliateDefaults(db, { cashbackBps: 0, feeDiscountBps: 0, gameRevenueBps: 0 }));

test('applyFeeDiscount + maxCashbackBps', () => {
  assert.equal(applyFeeDiscount(1000n, 5000), 500n); // 50% off
  assert.equal(applyFeeDiscount(1000n, 0), 1000n); // no discount
  assert.equal(applyFeeDiscount(1000n, 10000), 0n); // 100% off
  assert.equal(applyFeeDiscount(1000n, 99999), 0n); // clamped to 10000
  assert.equal(maxCashbackBps(), 5000); // 10000 − feeLpSharePct(50)*100
});

test('setAffiliateTerms creates terms + a code, and validates bounds', async () => {
  const pubkey = 'kol-' + randomUUID().slice(0, 8);
  const row = await setAffiliateTerms(db, { pubkey, code: 'STREAMERX', cashbackBps: 3500, feeDiscountBps: 5000, label: 'X' });
  assert.equal(row.cashbackBps, 3500);
  assert.equal(row.feeDiscountBps, 5000);
  assert.equal(row.code, 'STREAMERX');
  assert.equal(row.active, true);
  assert.ok((await listAffiliates(db)).some((a) => a.pubkey === pubkey));
  // cashback above the house-share ceiling → rejected
  await assert.rejects(() => setAffiliateTerms(db, { pubkey, cashbackBps: 6000, feeDiscountBps: 0 }), /cashbackBps/);
  // discount above 100% / negative cashback → rejected
  await assert.rejects(() => setAffiliateTerms(db, { pubkey, cashbackBps: 0, feeDiscountBps: 20000 }), /feeDiscountBps/);
  await assert.rejects(() => setAffiliateTerms(db, { pubkey, cashbackBps: -1, feeDiscountBps: 0 }), /cashbackBps/);
});

test('editing terms without active preserves a deactivated affiliate', async () => {
  const pubkey = 'kold-' + randomUUID().slice(0, 8);
  await setAffiliateTerms(db, { pubkey, cashbackBps: 1000, feeDiscountBps: 0, active: false });
  // adjust the rate WITHOUT passing active — must NOT silently re-enable
  const row = await setAffiliateTerms(db, { pubkey, cashbackBps: 2000, feeDiscountBps: 0 });
  assert.equal(row.active, false);
  assert.equal(row.cashbackBps, 2000);
  // explicit re-activation still works
  assert.equal((await setAffiliateTerms(db, { pubkey, cashbackBps: 2000, feeDiscountBps: 0, active: true })).active, true);
});

test('resolveFeeAffiliate resolves own discount + referrer cashback', async () => {
  const aff = await setAffiliateTerms(db, { pubkey: 'aff-' + randomUUID().slice(0, 8), cashbackBps: 2000, feeDiscountBps: 4000 });
  const r1 = await resolveFeeAffiliate(db, aff.userId);
  assert.equal(r1.discountBps, 4000);
  assert.equal(r1.cashback, null);

  const referee = await fundedUser(aff.userId);
  const r2 = await resolveFeeAffiliate(db, referee);
  assert.equal(r2.discountBps, 0);
  assert.deepEqual(r2.cashback, { userId: aff.userId, bps: 2000 });

  const normal = await fundedUser();
  const r3 = await resolveFeeAffiliate(db, normal);
  assert.equal(r3.discountBps, 0);
  assert.equal(r3.cashback, null);
});

test('an affiliate pays a discounted fee on their own trade', async () => {
  await setMark(1000);
  const normal = await fundedUser();
  await trade(normal);
  const n = await lastFill(normal);
  assert.ok(n.gross > 0n); // sanity: fees are on
  assert.equal(n.net, n.gross); // no affiliate terms → full fee

  const aff = await setAffiliateTerms(db, { pubkey: 'affd-' + randomUUID().slice(0, 8), cashbackBps: 0, feeDiscountBps: 5000 });
  await creditFaucet(db, aff.userId, 100_000);
  await trade(aff.userId);
  const a = await lastFill(aff.userId);
  assert.equal(a.net, applyFeeDiscount(a.gross, 5000)); // 50% off their own gross fee
  assert.ok(a.net < a.gross); // discount actually applied
});

test("a referee's trade pays the affiliate cashback out of house revenue", async () => {
  await setMark(1000);
  const aff = await setAffiliateTerms(db, { pubkey: 'affc-' + randomUUID().slice(0, 8), cashbackBps: 3500, feeDiscountBps: 0 });
  const affColl = await getOrCreateUserAccount(db, aff.userId, 'USER_COLLATERAL');
  const rev = await getOrCreateSystemAccount(db, 'FEE_REVENUE');
  const affBefore = await getBalance(db, affColl);
  const revBefore = await getBalance(db, rev);

  const referee = await fundedUser(aff.userId);
  await trade(referee);
  const f = await lastFill(referee);
  assert.equal(f.net, f.gross); // referee has no discount → full fee

  const revPart = f.net - LP_PART(f.net); // house share of this fee
  const expectedCb = (f.net * 3500n) / 10000n; // 35% < 50% house share → no clamp
  assert.equal((await getBalance(db, affColl)) - affBefore, expectedCb);
  assert.equal(await getCashbackTotal(db, aff.userId), expectedCb);
  assert.equal((await getBalance(db, rev)) - revBefore, revPart - expectedCb);
  assert.ok((await getBalance(db, rev)) >= 0n);
});

test('cashback clamps to the house share so FEE_REVENUE never goes negative', async () => {
  await setMark(1000);
  // insert an OVER-ceiling cashback directly (bypassing setAffiliateTerms validation) to exercise the runtime clamp
  const affId = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [affId, 'affx-' + affId.slice(0, 8)]);
  await db.query(`INSERT INTO affiliate_terms(user_id, cashback_bps, fee_discount_bps) VALUES($1, 9000, 0)`, [affId]); // 90% > house 50%
  const affColl = await getOrCreateUserAccount(db, affId, 'USER_COLLATERAL');
  const rev = await getOrCreateSystemAccount(db, 'FEE_REVENUE');
  const affBefore = await getBalance(db, affColl);
  const revBefore = await getBalance(db, rev);

  const referee = await fundedUser(affId);
  await trade(referee);
  const f = await lastFill(referee);
  const revPart = f.net - LP_PART(f.net); // house share

  // wanted 90% of the fee, but clamped to the house share; REV nets to zero, not negative
  assert.equal((await getBalance(db, affColl)) - affBefore, revPart);
  assert.equal((await getBalance(db, rev)) - revBefore, 0n);
  assert.ok((await getBalance(db, rev)) >= 0n);
});

test('platform defaults apply to codes without per-wallet terms, and individual terms override them', async () => {
  // baseline (platform default 0): a referred trader gets no discount, and their no-terms referrer no cashback
  const referrer = await fundedUser();
  const referee = await fundedUser(referrer);
  let r = await resolveFeeAffiliate(db, referee);
  assert.equal(r.discountBps, 0);
  assert.equal(r.cashback, null);

  // set platform-wide defaults
  const view = await setPlatformAffiliateDefaults(db, { cashbackBps: 1000, feeDiscountBps: 500, gameRevenueBps: 0 });
  assert.deepEqual({ c: view.cashbackBps, d: view.feeDiscountBps }, { c: 1000, d: 500 });
  assert.equal(getPlatformCashbackBps(), 1000);
  assert.equal(getPlatformFeeDiscountBps(), 500);

  // every trader now gets the default discount on their OWN fee...
  const solo = await fundedUser();
  r = await resolveFeeAffiliate(db, solo);
  assert.equal(r.discountBps, 500);
  assert.equal(r.cashback, null); // solo wasn't referred → nobody to pay cashback to

  // ...and a referred trader earns their (no-terms) referrer the default cashback
  r = await resolveFeeAffiliate(db, referee);
  assert.equal(r.discountBps, 500);
  assert.deepEqual(r.cashback, { userId: referrer, bps: 1000 });

  // an active per-wallet term OVERRIDES the platform default for that wallet — even with a LOWER/zero rate
  const aff = await setAffiliateTerms(db, { pubkey: 'pf-aff-' + randomUUID().slice(0, 8), cashbackBps: 2000, feeDiscountBps: 0 });
  assert.equal((await resolveFeeAffiliate(db, aff.userId)).discountBps, 0); // 0 overrides the 500 default
  const refOfAff = await fundedUser(aff.userId);
  assert.deepEqual((await resolveFeeAffiliate(db, refOfAff)).cashback, { userId: aff.userId, bps: 2000 }); // 2000, not 1000

  await setPlatformAffiliateDefaults(db, { cashbackBps: 0, feeDiscountBps: 0, gameRevenueBps: 0 }); // reset to dormant
  assert.equal(getPlatformCashbackBps(), 0);
});

test('platform fee discount reduces a normal trader’s own fee end-to-end', async () => {
  await setPlatformAffiliateDefaults(db, { cashbackBps: 0, feeDiscountBps: 5000, gameRevenueBps: 0 }); // 50% off for everyone
  await setMark(1000);
  const u = await fundedUser();
  await trade(u);
  const f = await lastFill(u);
  assert.equal(f.net, applyFeeDiscount(f.gross, 5000)); // platform discount applied to a wallet with no terms
  assert.ok(f.net < f.gross);
  await setPlatformAffiliateDefaults(db, { cashbackBps: 0, feeDiscountBps: 0, gameRevenueBps: 0 }); // reset
});

test('a deactivated per-wallet term falls back to the platform default (not zero)', async () => {
  await setPlatformAffiliateDefaults(db, { cashbackBps: 800, feeDiscountBps: 300, gameRevenueBps: 0 });
  // an affiliate the operator deactivated — their custom rates are dormant, so the wallet behaves as a normal
  // one and picks up the platform default (NOT 0, and NOT their own inactive 2500/6000).
  const aff = await setAffiliateTerms(db, { pubkey: 'pf-inact-' + randomUUID().slice(0, 8), cashbackBps: 2500, feeDiscountBps: 6000, active: false });
  assert.equal((await resolveFeeAffiliate(db, aff.userId)).discountBps, 300);
  const referee = await fundedUser(aff.userId);
  assert.deepEqual((await resolveFeeAffiliate(db, referee)).cashback, { userId: aff.userId, bps: 800 });
});

test('setPlatformAffiliateDefaults validates bounds and never partially applies', async () => {
  await assert.rejects(() => setPlatformAffiliateDefaults(db, { cashbackBps: 6000, feeDiscountBps: 0, gameRevenueBps: 0 }), /cashbackBps/); // > 5000 ceiling
  await assert.rejects(() => setPlatformAffiliateDefaults(db, { cashbackBps: 0, feeDiscountBps: 20000, gameRevenueBps: 0 }), /feeDiscountBps/); // > 10000
  await assert.rejects(() => setPlatformAffiliateDefaults(db, { cashbackBps: -1, feeDiscountBps: 0, gameRevenueBps: 0 }), /cashbackBps/);
  await assert.rejects(() => setPlatformAffiliateDefaults(db, { cashbackBps: 0, feeDiscountBps: 0, gameRevenueBps: 20000 }), /gameRevenueBps/); // > 10000
  // a rejected write leaves ALL knobs untouched (validated before any is persisted)
  assert.equal(getPlatformCashbackBps(), 0);
  assert.equal(getPlatformFeeDiscountBps(), 0);
  assert.equal(getPlatformGameRevenueBps(), 0);
});

test('resolveGameRevenueAffiliate: referred player → referrer + game_revenue_bps; not referred → null', async () => {
  const aff = await setAffiliateTerms(db, { pubkey: 'gr-' + randomUUID().slice(0, 8), cashbackBps: 0, feeDiscountBps: 0, gameRevenueBps: 1500 });
  assert.equal(await resolveGameRevenueAffiliate(db, aff.userId), null); // the affiliate themselves wasn't referred
  const referee = await fundedUser(aff.userId);
  assert.deepEqual(await resolveGameRevenueAffiliate(db, referee), { userId: aff.userId, bps: 1500 });
  assert.equal(await resolveGameRevenueAffiliate(db, await fundedUser()), null); // no referrer → null
});

test('game-revenue: a per-wallet term (incl. 0) overrides the platform default', async () => {
  await setPlatformAffiliateDefaults(db, { cashbackBps: 0, feeDiscountBps: 0, gameRevenueBps: 1000 }); // 10% default for every code
  // a referrer WITHOUT per-wallet terms → the platform default applies
  const plain = await fundedUser();
  assert.deepEqual(await resolveGameRevenueAffiliate(db, await fundedUser(plain)), { userId: plain, bps: 1000 });
  // a referrer WITH an active term whose game rate is 0 → overrides the default to 0 (null)
  const aff = await setAffiliateTerms(db, { pubkey: 'grd-' + randomUUID().slice(0, 8), cashbackBps: 0, feeDiscountBps: 0, gameRevenueBps: 0 });
  assert.equal(await resolveGameRevenueAffiliate(db, await fundedUser(aff.userId)), null);
});

test('setAffiliateTerms stores game_revenue_bps + listAffiliates surfaces it; bounds enforced', async () => {
  const pubkey = 'grs-' + randomUUID().slice(0, 8);
  const row = await setAffiliateTerms(db, { pubkey, cashbackBps: 0, feeDiscountBps: 0, gameRevenueBps: 2500 });
  assert.equal(row.gameRevenueBps, 2500);
  assert.equal(maxGameRevenueBps(), 10000);
  const listed = (await listAffiliates(db)).find((a) => a.pubkey === pubkey);
  assert.equal(listed?.gameRevenueBps, 2500);
  assert.equal(listed?.gameRevenuePaidUusdc, '0'); // nothing earned yet
  await assert.rejects(() => setAffiliateTerms(db, { pubkey, cashbackBps: 0, feeDiscountBps: 0, gameRevenueBps: 20000 }), /gameRevenueBps/);
});

after(async () => {
  await closeDb();
});
