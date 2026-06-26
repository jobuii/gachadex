/**
 * Reclaim idle SOL from per-user NFT-custody wallets back to the HOT wallet. The old fundCustody sent 0.012 SOL
 * per open that the custody wallet never spends (hot is fee-payer everywhere + pays the USDC-ATA rent, CC covers
 * the pack-payment gas — verified on-chain), so it just accumulated idle. This sweeps each FUNDED custody wallet's
 * SOL → hot, LEAVING the rent-exempt minimum in place (so the account stays valid and we avoid any drain-to-zero
 * edge). Custody signs as the source; HOT is the fee-payer. Targets only wallets that actually funded a gacha open.
 *
 *   DATABASE_URL=<public prod> SOLANA_RPC_URL=<mainnet> HOT_WALLET_SECRET=… DEPOSIT_MASTER_SEED=… \
 *     npx tsx scripts/reclaim-custody-sol.ts          # DRY RUN — reads balances, prints, sends nothing
 *   ...same env... --apply                            # sign + submit one reclaim tx per wallet
 *
 * ⚠️  UNTESTED LOCALLY (no keys/mainnet in dev). Run the DRY RUN first. Refuses to run on a non-mainnet RPC.
 */
import { Connection, SystemProgram, Transaction } from '@solana/web3.js';
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { hotWallet } from '../src/services/custody/solana.ts';
import { deriveNftCustodyKeypair } from '../src/services/custody/wallet.ts';

const apply = process.argv.includes('--apply');
const MIN_RECLAIM_LAMPORTS = 2_000_000; // skip a wallet if < 0.002 SOL would be reclaimed (not worth a tx)

// Preflight: real mainnet funds. Refuse without the prod mainnet env; hard-block any non-mainnet RPC.
const missing = [
  !process.env.SOLANA_RPC_URL && 'SOLANA_RPC_URL',
  !process.env.HOT_WALLET_SECRET && 'HOT_WALLET_SECRET',
  !process.env.DEPOSIT_MASTER_SEED && 'DEPOSIT_MASTER_SEED',
  !process.env.DATABASE_URL && 'DATABASE_URL',
].filter(Boolean);
if (missing.length) {
  console.error(`❌ missing prod env: ${missing.join(', ')}\n   Run with the prod mainnet env injected (DATABASE_URL must be the PUBLIC railway url).`);
  process.exit(1);
}
if (/devnet|testnet|localhost|127\.0\.0\.1/.test(config.solanaRpcUrl)) {
  console.error(`❌ SOLANA_RPC_URL = ${config.solanaRpcUrl} — refusing to move mainnet funds on a non-mainnet RPC.`);
  process.exit(1);
}

await initDb();
const db = await getDb();
const conn = new Connection(config.solanaRpcUrl, 'finalized');
const hot = hotWallet();
const rentMin = await conn.getMinimumBalanceForRentExemption(0); // leave this in each wallet
const sol = (lamports: number) => `${(lamports / 1e9).toFixed(6)} SOL`;
console.log(`reclaim-custody-sol: ${apply ? 'APPLY' : 'DRY RUN'} — leaves ${sol(rentMin)} (rent-exempt min) per wallet`);
console.log(`hot ${hot.publicKey.toBase58()}\n`);

// Every custody wallet that actually got funded == a wallet with a gacha open that reached CC (has a memo).
const rows = (await db.query<{ user_id: string; derivation_index: number; custody_pubkey: string }>(
  `SELECT DISTINCT o.user_id, da.derivation_index, o.custody_pubkey
   FROM gacha_pack_opens o JOIN deposit_addresses da ON da.user_id = o.user_id
   WHERE o.cc_memo IS NOT NULL AND o.custody_pubkey IS NOT NULL`)).rows;
console.log(`${rows.length} funded custody wallet(s) to check\n`);

let total = 0, swept = 0, skipped = 0;
for (const r of rows) {
  const kp = deriveNftCustodyKeypair(r.derivation_index);
  if (kp.publicKey.toBase58() !== r.custody_pubkey) {
    console.log(`  SKIP   ${r.custody_pubkey}  derived ${kp.publicKey.toBase58()} ≠ stored — tripwire, untouched`);
    skipped++; continue;
  }
  const bal = await conn.getBalance(kp.publicKey);
  const reclaim = bal - rentMin;
  if (reclaim < MIN_RECLAIM_LAMPORTS) {
    console.log(`  skip   ${r.custody_pubkey}  balance ${sol(bal)} → nothing meaningful to reclaim`);
    skipped++; continue;
  }
  if (!apply) {
    console.log(`  would  ${r.custody_pubkey}  balance ${sol(bal)} → reclaim ${sol(reclaim)} → hot`);
    total += reclaim; continue;
  }
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: hot.publicKey, lamports: reclaim }));
  tx.feePayer = hot.publicKey;
  const bh = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = bh.blockhash;
  tx.sign(hot, kp); // hot = fee-payer; custody = source/authority
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'finalized');
  console.log(`  ✅     ${r.custody_pubkey}  reclaimed ${sol(reclaim)} → hot  sig ${sig}`);
  total += reclaim; swept++;
}
console.log(`\n— ${apply ? `reclaimed ${sol(total)} across ${swept} wallet(s)` : `would reclaim ${sol(total)} across ${rows.length - skipped} wallet(s)`}; ${skipped} skipped —`);
await closeDb();
