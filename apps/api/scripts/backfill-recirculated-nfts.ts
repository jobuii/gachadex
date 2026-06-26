/**
 * One-off backfill: opens that delivered a RE-CIRCULATED NFT (a mint a prior holder had sold back) were marked
 * `opened` but never got a `gacha_nft_inventory` row — the old global `UNIQUE(mint)` + `ON CONFLICT (mint) DO
 * NOTHING` silently skipped the insert against the prior holder's stale `sold` row. The NFTs ARE delivered
 * (verified on-chain); this writes the missing `held` rows so the customers can sell/withdraw. Run AFTER the
 * schema fix is deployed (it relies on the dropped global-unique + the new partial index).
 *
 *   HELIUS_DAS_URL=<rpc> DATABASE_URL=<prod> npx tsx scripts/backfill-recirculated-nfts.ts          # DRY RUN
 *   HELIUS_DAS_URL=<rpc> DATABASE_URL=<prod> npx tsx scripts/backfill-recirculated-nfts.ts --apply  # write rows
 *
 * SAFE: for each affected open it re-checks the mint's CURRENT on-chain owner via DAS and only inserts when the
 * owner == the open's custody wallet (the NFT really is ours). Anything not in custody is reported, never written
 * (that would be a genuine phantom → a refund decision, not a backfill). Idempotent (ON CONFLICT (open_id)).
 */
import { randomUUID } from 'node:crypto';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';

const APPLY = process.argv.includes('--apply');
const RPC = process.env.HELIUS_DAS_URL || process.env.SOLANA_RPC_URL || '';

interface Affected {
  open_id: string; user_id: string; nft_mint: string; custody_pubkey: string;
  nft_name: string | null; grade: string | null; insured_value_e6: string | null;
  nft_market_id: string | null; nft_year: string | null; nft_image: string | null; cc_memo: string | null; paid: string;
}

/** Current on-chain owner of a mint via DAS getAsset (null if not found / error). */
async function ownerOf(mint: string): Promise<string | null> {
  try {
    const res = await fetch(RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
    });
    const j = (await res.json()) as { result?: { ownership?: { owner?: string }; burnt?: boolean } };
    if (j.result?.burnt) return 'BURNT';
    return j.result?.ownership?.owner ?? null;
  } catch (e) {
    console.error(`  ! DAS error for ${mint}:`, (e as Error).message);
    return null;
  }
}

async function main(): Promise<void> {
  if (!RPC) throw new Error('set HELIUS_DAS_URL (or SOLANA_RPC_URL) to a DAS-capable RPC');
  await initDb();
  const db = await getDb();
  const rows = (await db.query<Affected>(
    `SELECT o.id AS open_id, o.user_id, o.nft_mint, o.custody_pubkey, o.nft_name, o.grade,
            o.insured_value_e6::text AS insured_value_e6, o.nft_market_id, o.nft_year, o.nft_image, o.cc_memo,
            (o.price_e6/1e6)::numeric(12,2)::text AS paid
       FROM gacha_pack_opens o
      WHERE o.status = 'opened' AND o.nft_mint IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM gacha_nft_inventory i WHERE i.open_id = o.id)
      ORDER BY o.created_at`,
  )).rows;

  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} open(s) with no inventory row\n`);
  let backfilled = 0, skipped = 0;
  for (const r of rows) {
    const owner = await ownerOf(r.nft_mint);
    const inCustody = owner === r.custody_pubkey;
    const tag = inCustody ? 'IN CUSTODY → backfill' : `NOT in custody (owner=${owner}) → SKIP`;
    console.log(`• ${r.cc_memo}  $${r.paid}  ${r.nft_name ?? r.nft_mint}\n    mint ${r.nft_mint}\n    custody ${r.custody_pubkey} · on-chain owner ${owner}\n    ${tag}`);
    if (!inCustody) { skipped++; continue; }
    if (APPLY) {
      await db.query(
        `INSERT INTO gacha_nft_inventory(id, user_id, open_id, mint, custody_pubkey, name, grade, set_name, year, image_url, insured_value_e6, market_id, status)
         VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,'held') ON CONFLICT (open_id) DO NOTHING`,
        [randomUUID(), r.user_id, r.open_id, r.nft_mint, r.custody_pubkey, r.nft_name, r.grade, r.nft_year, r.nft_image, r.insured_value_e6, r.nft_market_id],
      );
    }
    backfilled++;
  }
  console.log(`\n${APPLY ? 'Wrote' : 'Would write'} ${backfilled} held row(s); skipped ${skipped} not-in-custody.\n`);
  if (!APPLY && backfilled > 0) console.log('Re-run with --apply to write the rows.\n');
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
