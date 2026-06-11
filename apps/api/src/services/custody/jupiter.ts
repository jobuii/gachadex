import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { config } from '../../config.ts';
import { getLimits } from './limits.ts';

/**
 * Thin Jupiter Swap API v1 client (custody P1.5): swap a deposit wallet's SOL into USDC, in place.
 * Host is api.jup.ag (`/swap/v1/quote` + `/swap/v1/swap`) — the old quote-api.jup.ag/v6 host is retired.
 * TODO: v1 (Metis) is on Jupiter's deprecation path. Migrate to Swap API v2 (`/swap/v2/order` +
 * `/swap/v2/execute`, a different quote→order→execute contract) before v1 sunsets — a tracked
 * follow-up, not this host hotfix.
 * The output lands on the wallet's own USDC ATA, where the regular USDC deposit path
 * detects and credits the ACTUAL proceeds — this module never touches the ledger.
 *
 * The deposit wallet pays its own swap fee from the SOL being swapped (it has SOL by
 * definition); `wrapAndUnwrapSol` lets Jupiter handle wSOL wrapping + ATA creation.
 *
 * Note: Jupiter aggregates MAINNET liquidity only — on devnet there is no route, so SOL
 * deposits stay parked (USDC deposits are unaffected). The logic is exercised by the
 * injectable-chain tests; live swaps are a mainnet dark-launch concern (P4).
 */

const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface QuoteResponse {
  error?: string;
  outAmount?: string;
}

export async function swapSolToUsdcViaJupiter(conn: Connection, from: Keypair, lamports: bigint): Promise<string> {
  // Optional Portal API key (x-api-key) for higher rate limits; keyless works at 0.5 RPS.
  const authHeaders: Record<string, string> = config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {};
  const quoteUrl =
    `${config.jupiterBase}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${config.usdcMint}` +
    `&amount=${lamports.toString()}&slippageBps=${getLimits().swapSlippageBps}`;
  const quote = (await (await fetch(quoteUrl, { headers: authHeaders })).json()) as QuoteResponse;
  if (!quote || quote.error || !quote.outAmount) {
    throw new Error(`jupiter quote failed: ${quote?.error ?? 'no route'}`);
  }

  const swapRes = (await (
    await fetch(`${config.jupiterBase}/swap/v1/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: from.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    })
  ).json()) as { swapTransaction?: string; error?: string };
  if (!swapRes.swapTransaction) {
    throw new Error(`jupiter swap build failed: ${swapRes.error ?? 'no transaction returned'}`);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
  tx.sign([from]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  const bh = await conn.getLatestBlockhash('finalized');
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'finalized');
  return sig;
}
