import { config } from '../config.ts';

/**
 * Solana DAS (Digital Asset Standard) reads for Classic Gacha (docs/classic-gacha-cc-packs-spec.md). CC cards
 * are Metaplex Core assets (MplCoreAsset, verified on live mints), so to transfer one out we need its
 * `collection` (required by the MPL Core program to move a collection asset). Needs a DAS-capable RPC (Helius);
 * `config.heliusDasUrl` (fallback `config.solanaRpcUrl`). Ported from rare.win's proven dasNfts.getAssetTransferInfo.
 */

type DasAsset = {
  grouping?: Array<{ group_key?: string; group_value?: string }>;
  ownership?: { owner?: string; frozen?: boolean };
  content?: { links?: { image?: string }; files?: Array<{ uri?: string; mime?: string }> };
};

/** One DAS `getAsset` call by mint → the `result` object (or null on any transport/parse error). The RPC
 *  boilerplate lives here so the field-specific readers below share a single code path. */
async function dasGetAsset(mint: string): Promise<DasAsset | null> {
  const url = config.heliusDasUrl || config.solanaRpcUrl;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'gdex', method: 'getAsset', params: { id: mint } }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: DasAsset };
    return json.result ?? null;
  } catch (e) {
    console.error('[das] getAsset failed', mint, e);
    return null;
  }
}

/** `collection` (required to transfer a Core collection asset), `owner` (so a re-attempted transfer is
 *  idempotent — if `dest` already owns it, a prior transfer landed), and `frozen` (can't transfer a frozen
 *  asset). Returns null on any error (the caller decides the fallback). */
export async function getAssetTransferInfo(mint: string): Promise<{ collection: string | null; owner: string | null; frozen: boolean } | null> {
  const r = await dasGetAsset(mint);
  if (!r) return null;
  return {
    collection: r.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? null,
    owner: r.ownership?.owner ?? null,
    frozen: Boolean(r.ownership?.frozen),
  };
}

/** Best-effort image URL for a mint via DAS getAsset — recovers a reveal image when CC's openPack response
 *  carried a null `content.links.image` (their payload is trimmed / their indexer lagged) even though the
 *  on-chain asset has art. Prefers the resolved `links.image`, then the first image `files[]` uri. Returns
 *  null on any error, or when the asset genuinely exposes no image (caller falls back to the placeholder). */
export async function getAssetImage(mint: string): Promise<string | null> {
  const c = (await dasGetAsset(mint))?.content;
  if (!c) return null;
  if (c.links?.image) return c.links.image;
  // guard the predicate against a malformed files entry (null element / non-string mime) so this best-effort
  // lookup can never throw into the money-safety delivery path — every failure resolves to null, not a reject.
  const file = (c.files ?? []).find((f) => typeof f?.mime === 'string' && f.mime.startsWith('image')) ?? (c.files ?? [])[0];
  return file?.uri ?? null;
}
