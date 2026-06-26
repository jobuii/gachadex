/**
 * One-off on-chain sweep for joshfed's remediation: move the idle USDC in his custody wallet (8nNkwF — the
 * un-credited turbo buyback proceeds) back to the HOT wallet, so the ledger TREASURY debit posted by
 * remediate-joshfed-turbo.ts is backed by real USDC in hot. Standard SPL transfer; custody signs (authority),
 * HOT is fee-payer (custody needs no SOL). USDC ONLY — the ~0.096 idle SOL is reclaimed in the system-wide SOL
 * cleanup, not here (avoids the drain-to-zero rent edge on a one-off).
 *
 *   DATABASE_URL=<prod> SOLANA_RPC_URL=<mainnet> HOT_WALLET_SECRET=... DEPOSIT_MASTER_SEED=... \
 *     npx tsx scripts/remediate-joshfed-sweep.ts          # DRY RUN — reads balances, sends NOTHING
 *   ...same env... --apply                                # sign + submit the sweep
 *
 * ⚠️  UNTESTED LOCALLY (no keys/mainnet in dev). Run the DRY RUN first and eyeball the amount + destination;
 *     ideally dust-test the custody→hot path once before --apply. Recommended order: sweep, confirm USDC landed
 *     in hot, THEN run remediate-joshfed-turbo.ts --apply (so the credit is backed before joshfed can withdraw).
 */
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { createTransferInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { hotWallet } from '../src/services/custody/solana.ts';
import { getNftCustodyKeypair } from '../src/services/custody/wallet.ts';

const USER_ID = '9522dfe3-b666-4921-a385-6d4f19c979e6'; // joshfed
const EXPECT_CUSTODY = '8nNkwFTJSEJDuWjwD2jjJc97CeVPJD1FoFvwFNFV6SAf'; // tripwire: the derived custody MUST match this
const apply = process.argv.includes('--apply');

// Preflight: this moves REAL mainnet funds. A bare shell defaults SOLANA_RPC_URL to devnet + USDC_MINT to '',
// which would crash ("Invalid public key") or — worse — operate on the wrong network. Refuse unless the full prod
// mainnet env + secrets are injected (run via `railway run`), and hard-block any non-mainnet RPC.
const missing = [
  !config.usdcMint && 'USDC_MINT',
  !process.env.SOLANA_RPC_URL && 'SOLANA_RPC_URL',
  !process.env.HOT_WALLET_SECRET && 'HOT_WALLET_SECRET',
  !process.env.DEPOSIT_MASTER_SEED && 'DEPOSIT_MASTER_SEED',
  !process.env.DATABASE_URL && 'DATABASE_URL',
].filter(Boolean);
if (missing.length) {
  console.error(`❌ missing prod env: ${missing.join(', ')}\n   Run it through the prod env, e.g.  railway run npx tsx scripts/remediate-joshfed-sweep.ts`);
  process.exit(1);
}
if (/devnet|testnet|localhost|127\.0\.0\.1/.test(config.solanaRpcUrl)) {
  console.error(`❌ SOLANA_RPC_URL = ${config.solanaRpcUrl} — refusing to sweep mainnet funds on a non-mainnet RPC. Inject the prod env.`);
  process.exit(1);
}

await initDb();
const db = await getDb();
const conn = new Connection(config.solanaRpcUrl, 'finalized');
const usdcMint = new PublicKey(config.usdcMint);
const hot = hotWallet();
const custody = await getNftCustodyKeypair(db, USER_ID);

if (custody.publicKey.toBase58() !== EXPECT_CUSTODY) {
  throw new Error(`derived custody ${custody.publicKey.toBase58()} ≠ expected ${EXPECT_CUSTODY} — ABORT (wrong seed/user)`);
}
console.log(`remediate-joshfed-sweep (USDC): ${apply ? 'APPLY' : 'DRY RUN'}`);
console.log(`custody ${custody.publicKey.toBase58()} → hot ${hot.publicKey.toBase58()}\n`);

const custodyAta = getAssociatedTokenAddressSync(usdcMint, custody.publicKey);
const hotAta = getAssociatedTokenAddressSync(usdcMint, hot.publicKey);
let usdcRaw = 0n;
try { usdcRaw = (await getAccount(conn, custodyAta)).amount; } catch { /* no ATA → 0 */ }
console.log(`custody USDC: $${(Number(usdcRaw) / 1e6).toFixed(2)} (${usdcRaw} base units)`);

if (usdcRaw === 0n) { console.log('\nnothing to sweep (USDC is 0).'); await closeDb(); process.exit(0); }

if (!apply) {
  console.log(`\nDRY RUN — would transfer $${(Number(usdcRaw) / 1e6).toFixed(2)} USDC → hot (fee-payer: hot). Re-run with --apply.`);
  await closeDb(); process.exit(0);
}

const tx = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(hot.publicKey, hotAta, hot.publicKey, usdcMint), // ensure hot ATA (hot pays; no-op if it exists)
  createTransferInstruction(custodyAta, hotAta, custody.publicKey, usdcRaw), // custody authorizes the full balance
);
tx.feePayer = hot.publicKey;
const bh = await conn.getLatestBlockhash('finalized');
tx.recentBlockhash = bh.blockhash;
tx.sign(hot, custody); // hot = fee-payer; custody = ATA authority
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'finalized');

let after = 0n;
try { after = (await getAccount(conn, custodyAta)).amount; } catch { /* ATA gone → 0 */ }
console.log(`\n✅ swept. sig: ${sig}`);
console.log(`custody USDC now: $${(Number(after) / 1e6).toFixed(2)}`);
console.log(`\nNext: run remediate-joshfed-turbo.ts --apply to credit joshfed + post the ledger.`);
await closeDb();
