import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.MAX_REFERRALS_PAID = '1'; // referrer is paid for only their FIRST referral (cap test below)

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');
const { assignReferralCode, getReferralInfo, redeemReferral, setReferralCode } = await import('./referral.ts');
const { getLeaderboard } = await import('./leaderboard.ts');
const { lpDeposit } = await import('./lp.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();

await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

// A signed-up user: a row plus a referral code (mirrors auth.upsertUser).
async function newUser(fund = 10_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await assignReferralCode(db, id);
  if (fund > 0) await creditFaucet(db, id, fund);
  return id;
}

test('every account gets a unique, stable referral code', async () => {
  const a = await newUser();
  const b = await newUser();
  const ca = await getReferralInfo(db, a);
  const cb = await getReferralInfo(db, b);
  assert.match(ca.code, /^POKE-[A-Z2-9]{5}$/);
  assert.notEqual(ca.code, cb.code);
  // idempotent: asking again returns the same code, doesn't mint a new one
  assert.equal((await getReferralInfo(db, a)).code, ca.code);
});

test('redeeming a referral code attributes once and pays both parties', async () => {
  const referrer = await newUser();
  const newbie = await newUser();
  const code = (await getReferralInfo(db, referrer)).code;

  await assert.rejects(redeemReferral(db, newbie, 'POKE-ZZZZZ'), /invalid referral code/);
  await assert.rejects(redeemReferral(db, newbie, (await getReferralInfo(db, newbie)).code), /your own code/);

  const before = await getUserBalances(db, newbie);
  const r = await redeemReferral(db, newbie, code.toLowerCase()); // case-insensitive
  assert.equal(r.credited, true);
  assert.equal(r.bonusUsd, 1000);

  const after = await getUserBalances(db, newbie);
  assert.equal((after.availableUusdc - before.availableUusdc).toString(), (1000n * 1_000_000n).toString());

  const info = await getReferralInfo(db, newbie);
  assert.equal(info.redeemed, true);
  assert.equal(info.referredByCode, code);
  assert.equal((await getReferralInfo(db, referrer)).referralsCount, 1);

  // can't redeem twice
  await assert.rejects(redeemReferral(db, newbie, code), /already redeemed/);
});

test('renaming reserves old codes (anti-hijack) + the POKE- namespace; old links still resolve', async () => {
  const a = await newUser();
  const b = await newUser();
  const aOrig = (await getReferralInfo(db, a)).code; // auto POKE-XXXXX

  assert.equal((await setReferralCode(db, a, 'hugh-1')).code, 'HUGH-1'); // normalized + set
  await setReferralCode(db, a, 'hugh-2'); // HUGH-1 is now a freed custom code
  assert.equal((await getReferralInfo(db, a)).code, 'HUGH-2');

  // nobody else can claim a's current code, a's freed code, or anything POKE-shaped
  await assert.rejects(setReferralCode(db, b, 'HUGH-2'), /already taken/); // a's current
  await assert.rejects(setReferralCode(db, b, 'HUGH-1'), /already taken/); // a's reserved alias
  await assert.rejects(setReferralCode(db, b, aOrig), /reserved/); // POKE- namespace
  await assert.rejects(setReferralCode(db, b, 'POKE-ZZZZZ'), /reserved/);
  await assert.rejects(setReferralCode(db, b, 'ab'), /4-20/); // too short
  await assert.rejects(setReferralCode(db, b, 'no spaces!'), /letters/); // bad charset

  // a can rename back to a code they previously held (their own reserved alias)
  assert.equal((await setReferralCode(db, a, 'hugh-1')).code, 'HUGH-1');

  // old links keep working: b redeems a's now-freed code; attribution resolves to a's current code
  const redeem = await redeemReferral(db, b, 'hugh-2');
  assert.equal(redeem.credited, true);
  assert.equal((await getReferralInfo(db, b)).referredByCode, 'HUGH-1');
});

test('referrer is paid only up to the anti-farming cap (no overpay across referrals)', async () => {
  const referrer = await newUser(); // faucets 10,000
  const code = (await getReferralInfo(db, referrer)).code;
  const beforeRef = await getUserBalances(db, referrer);

  const n1 = await newUser();
  const n2 = await newUser();
  assert.equal((await redeemReferral(db, n1, code)).credited, true); // 1st: referrer paid (cap=1)
  assert.equal((await redeemReferral(db, n2, code)).credited, true); // 2nd: redeemer paid, referrer NOT

  const afterRef = await getUserBalances(db, referrer);
  // referrer received exactly one bonus despite two referrals — the cap held
  assert.equal((afterRef.availableUusdc - beforeRef.availableUusdc).toString(), usdc(1_000).toString());
  // both redeemers still got their own bonus
  assert.equal((await getUserBalances(db, n1)).availableUusdc.toString(), usdc(11_000).toString());
  assert.equal((await getUserBalances(db, n2)).availableUusdc.toString(), usdc(11_000).toString());
  assert.equal((await getReferralInfo(db, referrer)).referralsCount, 2); // both attributed
});

test('leaderboard counts LP capital as account value, not a phantom trading loss', async () => {
  // runs while the pool is still at par, so the LP stake is worth exactly what was deposited
  const lp = await newUser(); // faucets 10,000
  await lpDeposit(db, lp, usdc(5_000));

  const board = await getLeaderboard(db, { viewerUserId: lp });
  const row = board.you;
  assert.ok(row, 'viewer row is present');
  assert.equal(row.realizedPnlUusdc, '0', 'parking capital in the LP pool is not a trading loss');
  assert.equal(row.equityUusdc, usdc(10_000).toString(), 'equity reflects total account value including the LP stake');
});

test('leaderboard ranks a profitable trader above a flat account', async () => {
  const trader = await newUser();
  const idle = await newUser();
  await openPosition(db, trader, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  const [pos] = await getUserPositions(db, trader);
  await closePosition(db, trader, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });

  const lb = await getLeaderboard(db, { limit: 100, viewerUserId: idle });
  const tRow = lb.rows.find((r) => r.userId === trader)!;
  const iRow = lb.rows.find((r) => r.userId === idle)!;
  assert.ok(tRow && iRow);
  assert.ok(tRow.rank < iRow.rank, 'the profitable trader outranks the idle account');
  assert.ok(BigInt(tRow.realizedPnlUusdc) > 0n, 'profitable close shows positive net realized PnL');
  assert.equal(iRow.realizedPnlUusdc, '0', 'an account that only faucets has zero realized PnL');
  assert.ok(BigInt(tRow.volumeUusdc) > 0n, 'the trader has traded volume');
  assert.equal(lb.you?.userId, idle, 'the viewer row is pinned');
});

test('ledger still reconciles after referral bonuses and trading', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
