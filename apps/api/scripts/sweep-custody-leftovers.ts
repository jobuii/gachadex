/**
 * Sweep STRANDED USDC out of Classic-Gacha custody wallets back to the HOT wallet. A custody is a pass-through:
 * hot JIT-funds it the pack price, it pays CC, balance returns to ~0. A hard crash between fund-custody and the
 * CC submit (the same event that leaves a 'paid' open stranded — reconcileAllPending refunds that side) strands
 * the funding in the custody. This recovers it. Standard SPL transfer: custody signs as ATA authority, HOT is
 * fee-payer (custody needs no SOL). Mirrors remediate-joshfed-sweep.ts; generalised to scan every gacha user.
 *
 *   DATABASE_URL=<prod> SOLANA_RPC_URL=<mainnet> HOT_WALLET_SECRET=... DEPOSIT_MASTER_SEED=... USDC_MINT=... \
 *     npx tsx scripts/sweep-custody-leftovers.ts          # DRY RUN — reads balances, sends NOTHING
 *   ...same env... --apply                                # sign + submit each sweep
 *
 * SAFE: skips any user with a 'paid'/'pending' open in the last 5 minutes (a live open's funding is in-flight for
 * only seconds, so this never races a real open and sweeps money CC is about to take). Run AFTER the stuck-open
 * reconciler has refunded the customer side (either is fine — both are reserve-neutral). DRY RUN first, eyeball it.
 */
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { createTransferInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { hotWallet } from '../src/services/custody/solana.ts';
import { getNftCustodyKeypair } from '../src/services/custody/wallet.ts';

const apply = process.argv.includes('--apply');

// Preflight: this moves REAL mainnet funds. Refuse unless the full prod env is injected, and hard-block a
// non-mainnet RPC (a bare shell defaults to devnet) so a misconfigured run can never touch the wrong network.
const missing = [
  !config.usdcMint && 'USDC_MINT',
  !process.env.SOLANA_RPC_URL && 'SOLANA_RPC_URL',
  !process.env.HOT_WALLET_SECRET && 'HOT_WALLET_SECRET',
  !process.env.DEPOSIT_MASTER_SEED && 'DEPOSIT_MASTER_SEED',
  !process.env.DATABASE_URL && 'DATABASE_URL',
].filter(Boolean);
if (missing.length) {
  console.error(`❌ missing prod env: ${missing.join(', ')}\n   Run it through the prod env, e.g.  railway run npx tsx scripts/sweep-custody-leftovers.ts`);
  process.exit(1);
}
if (/devnet|testnet|localhost|127\.0\.0\.1/.test(config.solanaRpcUrl)) {
  console.error(`❌ SOLANA_RPC_URL = ${config.solanaRpcUrl} — refusing to sweep mainnet funds on a non-mainnet RPC.`);
  process.exit(1);
}

await initDb();
const db = await getDb();
const conn = new Connection(config.solanaRpcUrl, 'finalized');
const usdcMint = new PublicKey(config.usdcMint);
const hot = hotWallet();
const hotAta = getAssociatedTokenAddressSync(usdcMint, hot.publicKey);

// Every user who has ever opened a pack (custody is derived per-user).
const users = (await db.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM gacha_pack_opens`)).rows;
console.log(`sweep-custody-leftovers: ${apply ? 'APPLY' : 'DRY RUN'} — scanning ${users.length} gacha custody wallet(s) → hot ${hot.publicKey.toBase58()}\n`);

let found = 0, swept = 0;
let totalE6 = 0n, sweptE6 = 0n;
for (const { user_id } of users) {
  // Only sweep a custody whose opens are ALL resolved. Skip ANY user with an unresolved 'paid'/'pending' open
  // (regardless of age): its funding may still be in-play, and if the stuck-open reconciler hasn't refunded it
  // yet (e.g. CC was unreachable for a while), sweeping would pull money tied to an open that isn't settled. Run
  // the reconciler first (it flips a stranded open to 'failed'); only then is the leftover provably recoverable.
  const unresolved = (await db.query(`SELECT 1 FROM gacha_pack_opens WHERE user_id=$1 AND status IN ('paid','pending') LIMIT 1`, [user_id])).rows[0];
  if (unresolved) continue;

  const custody = await getNftCustodyKeypair(db, user_id);
  const custodyAta = getAssociatedTokenAddressSync(usdcMint, custody.publicKey);
  let raw = 0n;
  try { raw = (await getAccount(conn, custodyAta)).amount; } catch { continue; } // no ATA → nothing here
  if (raw === 0n) continue;

  found++; totalE6 += raw;
  console.log(`• ${custody.publicKey.toBase58()}  (user ${user_id.slice(0, 8)})  $${(Number(raw) / 1e6).toFixed(2)} stranded`);
  if (!apply) continue;

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(hot.publicKey, hotAta, hot.publicKey, usdcMint), // ensure hot ATA (no-op if it exists)
    createTransferInstruction(custodyAta, hotAta, custody.publicKey, raw), // custody authorizes its full balance
  );
  tx.feePayer = hot.publicKey;
  const bh = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = bh.blockhash;
  tx.sign(hot, custody); // hot = fee-payer; custody = ATA authority
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'finalized');
  swept++; sweptE6 += raw;
  console.log(`    ✅ swept → hot  sig: ${sig}`);
}

console.log(`\n${apply ? 'Swept' : 'Found'} ${apply ? swept : found} custody wallet(s), $${(Number(apply ? sweptE6 : totalE6) / 1e6).toFixed(2)} total.`);
if (!apply && found > 0) console.log('Re-run with --apply to sweep.');
await closeDb();
