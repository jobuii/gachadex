/**
 * One-off remediation: credit customer "joshfed" for 5 YOLO/turbo Common opens that CC auto-sold but our
 * pre-fix deliverOpen mis-recorded as `held` slabs (never credited — the TURBO_MODE_BUYBACK ordering bug).
 * Books each EXACTLY as a normal turbo sell would have (payout = gross −10% → USER_COLLATERAL, cut → FEE_REVENUE,
 * gross → TREASURY debit) via the tested remediateMisrecordedTurboCommon(); strictly guarded + idempotent.
 *
 *   DATABASE_URL=<prod> npx tsx scripts/remediate-joshfed-turbo.ts          # DRY RUN (report only)
 *   DATABASE_URL=<prod> npx tsx scripts/remediate-joshfed-turbo.ts --apply  # write the ledger + statuses
 *
 * NOTE: this is ONLY the off-chain ledger half. The on-chain sweep (88.40 USDC + ~0.096 SOL: custody 8nNkwF →
 * hot) is a SEPARATE operator step (see remediate-joshfed-sweep.ts) so the TREASURY debit stays backed by real
 * USDC in the hot wallet. Recommended order: run the sweep, confirm it landed in hot, then run this with --apply.
 */
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import type { Db } from '../src/db/client.ts';
import { defaultCcClient } from '../src/services/providers/collectorcrypt.ts';
import { remediateMisrecordedTurboCommon } from '../src/services/gacha.ts';

const USER_ID = '9522dfe3-b666-4921-a385-6d4f19c979e6'; // joshfed
const CUSTODY = '8nNkwFTJSEJDuWjwD2jjJc97CeVPJD1FoFvwFNFV6SAf';
// The 5 mis-recorded turbo Commons. expectedGrossE6 = CC's confirmed buyback (base units), verified 2026-06-26
// via /api/pack/status. We re-fetch live below and TRIPWIRE against this so we never credit against changed data.
const PRIZES = [
  { name: 'Safcon 1st Ed PSA', prizeId: '85d5a363-1a08-440a-88fd-8a3ec462ab41', memo: 'cc-2a372112-b131-49fd-afb6-1a93e6ec6980', expectedGrossE6: 21_250_000n },
  { name: 'Gholdengo CGC 10', prizeId: '9c93e8f8-f089-49cc-a70a-1ebbc7205d8f', memo: 'cc-d634d02e-0bb5-494a-a252-69d2e4fa901b', expectedGrossE6: 11_900_000n },
  { name: 'Persian CGC 9.5', prizeId: 'eca6d6b8-03fe-47cc-a77e-29476ca27a9f', memo: 'cc-538a072f-3141-46f5-aad9-225420066ed8', expectedGrossE6: 17_000_000n },
  { name: 'Dusknoir PSA 7', prizeId: '1aa9bf9a-243f-4ce4-8d04-6c1781908785', memo: 'cc-2ab882fd-cac2-4431-8e44-6369c84103be', expectedGrossE6: 21_250_000n },
  { name: 'Zapdos-Holo PSA 3', prizeId: '8fdd1aa4-e542-4c08-a8f2-63f9f00ab905', memo: 'cc-fd594785-3df7-4a9c-ace1-47d336c01035', expectedGrossE6: 17_000_000n },
];

const fmt = (e6: bigint) => `$${(Number(e6) / 1e6).toFixed(2)}`;
async function collOf(db: Db, userId: string): Promise<bigint> {
  const r = await db.query<{ a: string }>(`SELECT COALESCE(b.amount_uusdc,0) AS a FROM accounts a LEFT JOIN balances b ON b.account_id=a.id WHERE a.user_id=$1 AND a.type='USER_COLLATERAL'`, [userId]);
  return BigInt(r.rows[0]?.a ?? '0');
}
async function sysBal(db: Db, type: string): Promise<bigint> {
  const r = await db.query<{ a: string }>(`SELECT COALESCE(b.amount_uusdc,0) AS a FROM accounts a LEFT JOIN balances b ON b.account_id=a.id WHERE a.user_id IS NULL AND a.type=$1`, [type]);
  return BigInt(r.rows[0]?.a ?? '0');
}

const apply = process.argv.includes('--apply');
await initDb();
const db = await getDb();
console.log(`remediate-joshfed-turbo: ${apply ? 'APPLY' : 'DRY RUN'} (pass --apply to write)`);
console.log(`user ${USER_ID} (joshfed) · custody ${CUSTODY}\n`);

const freeBefore = await collOf(db, USER_ID);
const feeBefore = await sysBal(db, 'FEE_REVENUE');
const treBefore = await sysBal(db, 'TREASURY_USDC');

let totGross = 0n, totPayout = 0n, totCut = 0n, appliedN = 0, skipped = 0;
for (const p of PRIZES) {
  // Source of truth: re-fetch CC's confirmed buyback for this memo + tripwire against the expected amount.
  const st = await defaultCcClient.getPackStatus(p.memo);
  const bb = (st.buyback || [])[0];
  if (!bb || bb.status !== 'confirmed' || !bb.refund_amount) {
    console.log(`  SKIP   ${p.name.padEnd(20)} CC buyback not confirmed (status=${bb?.status ?? 'none'}) — untouched`);
    skipped++; continue;
  }
  const liveGross = BigInt(bb.refund_amount);
  if (liveGross !== p.expectedGrossE6) {
    console.log(`  SKIP   ${p.name.padEnd(20)} CC gross ${fmt(liveGross)} ≠ expected ${fmt(p.expectedGrossE6)} — tripwire, untouched`);
    skipped++; continue;
  }
  const res = await remediateMisrecordedTurboCommon(db, p.prizeId, liveGross, { dryRun: !apply });
  if (res.userId !== USER_ID) { throw new Error(`prize ${p.prizeId} belongs to ${res.userId}, not joshfed — ABORT`); }
  console.log(`  ${res.status.padEnd(12)} ${p.name.padEnd(20)} gross ${fmt(BigInt(res.grossE6))}  payout ${fmt(BigInt(res.payoutE6))}  cut ${fmt(BigInt(res.cutE6))}`);
  if (res.status === 'applied' || res.status === 'dry_run') {
    totGross += BigInt(res.grossE6); totPayout += BigInt(res.payoutE6); totCut += BigInt(res.cutE6);
    if (res.status === 'applied') appliedN++;
  }
}

console.log(`\n— totals (${appliedN} applied, ${skipped} skipped) —`);
console.log(`gross:                               ${fmt(totGross)}`);
console.log(`payout → joshfed (USER_COLLATERAL):  ${fmt(totPayout)}`);
console.log(`cut → FEE_REVENUE:                   ${fmt(totCut)}`);
console.log(`TREASURY_USDC debit:                 ${fmt(totGross)}`);

if (apply) {
  const freeAfter = await collOf(db, USER_ID);
  const feeAfter = await sysBal(db, 'FEE_REVENUE');
  const treAfter = await sysBal(db, 'TREASURY_USDC');
  console.log(`\n— verification (after apply) —`);
  console.log(`joshfed free:  ${fmt(freeBefore)} → ${fmt(freeAfter)}   (Δ ${fmt(freeAfter - freeBefore)})`);
  console.log(`FEE_REVENUE:   Δ ${fmt(feeAfter - feeBefore)}`);
  console.log(`TREASURY_USDC: Δ -${fmt(treBefore - treAfter)}`);
  const ok = freeAfter - freeBefore === totPayout && feeAfter - feeBefore === totCut && treBefore - treAfter === totGross;
  console.log(ok ? '✅ ledger deltas match expected' : '❌ LEDGER DELTAS DO NOT MATCH — investigate before doing anything else');
  console.log(`\n⚠️  Now run the on-chain sweep (custody → hot: ${fmt(totGross)} USDC + ~0.096 SOL) so the TREASURY debit is backed.`);
} else {
  console.log(`\n(dry run — nothing written. Re-run with --apply to commit, after the sweep.)`);
}

await closeDb();
