import { config } from '../config.ts';

/**
 * Solana DAS (Digital Asset Standard) reads for Classic Gacha (docs/classic-gacha-cc-packs-spec.md). CC cards
 * are Metaplex Core assets (MplCoreAsset, verified on live mints), so to transfer one out we need its
 * `collection` (required by the MPL Core program to move a collection asset). Needs a DAS-capable RPC (Helius);
 * `config.heliusDasUrl` (fallback `config.solanaRpcUrl`). Ported from rare.win's proven dasNfts.getAssetTransferInfo.
 */

/** One getAsset call: `collection` (required to transfer a Core collection asset), `owner` (so a re-attempted
 *  transfer is idempotent — if `dest` already owns it, a prior transfer landed), and `frozen` (can't transfer a
 *  frozen asset). Returns null on any error (the caller decides the fallback). */
export async function getAssetTransferInfo(mint: string): Promise<{ collection: string | null; owner: string | null; frozen: boolean } | null> {
  const url = config.heliusDasUrl || config.solanaRpcUrl;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'gdex', method: 'getAsset', params: { id: mint } }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: { grouping?: Array<{ group_key?: string; group_value?: string }>; ownership?: { owner?: string; frozen?: boolean } };
    };
    const r = json.result;
    if (!r) return null;
    return {
      collection: r.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? null,
      owner: r.ownership?.owner ?? null,
      frozen: Boolean(r.ownership?.frozen),
    };
  } catch (e) {
    console.error('[das] getAssetTransferInfo failed', e);
    return null;
  }
}
