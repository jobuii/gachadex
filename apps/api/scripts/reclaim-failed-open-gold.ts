/**
 * One-off: claw back loyalty Gold earned on gacha opens that later FAILED/REFUNDED. Gold is credited at payment
 * (PACK_OPEN_EARN); before the settleRefund fix, a refunded USDC open kept that Gold even though the USDC was
 * returned. This reverses the still-owed Gold for every failed/refunded USDC open, idempotently (reverseEarnedGold
 * nets against any prior reversal), so it's safe to re-run and won't double-claw an open the live fix already handled.
 *
 *   DATABASE_URL=<public prod> npx tsx scripts/reclaim-failed-open-gold.ts          # DRY RUN — prints, writes nothing
 *   DATABASE_URL=<public prod> npx tsx scripts/reclaim-failed-open-gold.ts --apply  # write the reversals
 *
 * Gold is non-withdrawable loyalty points (not USDC / not on-chain), so this is DB-only — no keys, no RPC.
 */
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { reverseEarnedGold, FREE_PACK_GOLD } from '../src/services/gold.ts';

const apply = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) {
  console.error('❌ missing DATABASE_URL (use the PUBLIC railway url).');
  process.exit(1);
}

await initDb();
const db = await getDb();

// Failed/refunded USDC opens that STILL hold un-reversed earned Gold (earn + any prior reversal nets positive).
const rows = (
  await db.query<{ user_id: string; open_id: string; net: string }>(
    `SELECT g.user_id, g.ref_id AS open_id, SUM(g.delta)::text AS net
       FROM gold_ledger g
       JOIN gacha_pack_opens o ON o.id = g.ref_id AND o.paid_with = 'usdc' AND o.status IN ('failed', 'refunded')
      WHERE g.ref_type = 'gacha_open' AND g.reason IN ('PACK_OPEN_EARN', 'PACK_OPEN_EARN_REVERSAL')
      GROUP BY g.user_id, g.ref_id
     HAVING SUM(g.delta) > 0`,
  )
).rows;

const totalGold = rows.reduce((s, r) => s + BigInt(r.net), 0n);
console.log(
  `${rows.length} failed/refunded USDC open(s) still hold earned Gold — total to claw back: ${totalGold} Gold ` +
    `(≈ ${(Number(totalGold) / Number(FREE_PACK_GOLD)).toFixed(2)} free $25 pack(s)).`,
);
const byUser = new Map<string, bigint>();
for (const r of rows) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0n) + BigInt(r.net));
for (const [u, g] of [...byUser.entries()].sort((a, b) => Number(b[1] - a[1]))) console.log(`  user ${u}: −${g} Gold`);

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to post the reversals.');
  await closeDb();
  process.exit(0);
}

let reversed = 0n;
let n = 0;
for (const r of rows) {
  const got = await db.tx((q) => reverseEarnedGold(q, r.user_id, r.open_id));
  if (got > 0n) {
    reversed += got;
    n++;
  }
}
console.log(`\n✅ reversed ${reversed} Gold across ${n} open(s).`);
await closeDb();
process.exit(0);
