/* Collector Crypt gacha API client — server-only, READ-ONLY subset for the Classic Gacha lobby (P0).
   docs/classic-gacha-cc-packs-spec.md §3. Ported from rare.win's proven lib/collectorcrypt.ts.

   Base: gacha.collectorcrypt.com (CC_ENV=dev → dev-gacha.collectorcrypt.com; CC_GACHA_URL overrides).
   Auth: optional x-api-key (config.ccApiKey), never required by CC.
   Monetary fields from these GET reads (machines.price/ev, getNfts.insured_value, winners.insuredValue) are
   DOLLARS, not base units — the `toLobby*` mappers convert to micro-USDC for the wire. The open / buyback /
   submit (paying) endpoints are deliberately NOT here; they arrive in P1 with the custody work. */
import { config } from '../../config.ts';
import { usdc } from '../../money.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function gachaBase(): string {
  if (config.ccGachaUrl) return config.ccGachaUrl;
  return config.ccEnv === 'dev' ? 'https://dev-gacha.collectorcrypt.com' : 'https://gacha.collectorcrypt.com';
}

/* Shared gacha GET. Idempotent reads opt into retry (default 2) on network / timeout / 5xx with backoff;
   a 15s AbortController timeout caps a hung request (the body read is inside the timeout too). Paying
   mutations would pass retries:0 so they never double-process — but P0 has none. `fetchFn` is injectable
   for tests. */
async function gachaGet<T>(
  path: string,
  opts: { retries?: number; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<T> {
  const { retries = 2, timeoutMs = 15_000, fetchFn = fetch } = opts;
  const base = gachaBase();
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: 'GET',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...(config.ccApiKey ? { 'x-api-key': config.ccApiKey } : {}) },
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) { await sleep(300 * 2 ** attempt); continue; } // network / timeout → retry
      throw e;
    }
    if (res.ok) {
      try { return (await res.json()) as T; } finally { clearTimeout(timer); }
    }
    clearTimeout(timer);
    if (res.status >= 500 && attempt < retries) { await sleep(300 * 2 ** attempt); continue; } // transient 5xx → retry
    throw new Error(`CC gacha ${path} → ${res.status}`);
  }
}

// ── CC response shapes (dollars; see header note) ──
export type CcMachine = {
  code: string; // e.g. "pokemon_50" — the pack key
  name: string;
  shortName?: string;
  price: number; // $
  instantBuyback: number; // buyback % (e.g. 85)
  odds: Record<string, number>; // fixed rarity weights (sum ≈ 1)
  tierRanges?: Record<string, { start: number; end: number }>; // insured-value bands per tier ($)
  stock: Record<string, number>; // current card count per tier
  ev?: number; // CC's odds-weighted expected insured value ($)
  turboMode?: boolean;
  thumbnailUrl?: string;
  public?: boolean;
};
export type CcPackNft = { id?: string; nft_address: string; name: string; rarity: string; image: string; insured_value: number };
export type CcWinner = {
  winner: string;
  nft_address: string;
  nft?: { content?: { metadata?: { name?: string }; links?: { image?: string } } };
  insuredValue: number; // $
  prize_tier: number; // 1=epic … 4=common
  pack_type: string;
  created_at: string | number;
};

/** Available pack machines (lobby tiles). */
export function getMachines(opts: { fetchFn?: typeof fetch } = {}): Promise<{ machines: CcMachine[] }> {
  return gachaGet('/api/machines', opts);
}
/** Cards in a machine's pool. `code` = machine code (e.g. "pokemon_50"). */
export function getNfts(code: string, opts: { rarity?: string; page?: number; limit?: number; fetchFn?: typeof fetch } = {}): Promise<{ nfts: CcPackNft[] }> {
  const q = new URLSearchParams({ code });
  if (opts.rarity) q.set('rarity', opts.rarity);
  if (opts.page) q.set('page', String(opts.page));
  q.set('limit', String(opts.limit ?? 40));
  return gachaGet(`/api/getNfts?${q.toString()}`, opts);
}
/** Recent winners feed (lobby ticker), most-recent-first. `count` caps at 200. */
export function getAllWinners(opts: { count?: number; packType?: string; fetchFn?: typeof fetch } = {}): Promise<{ success: boolean; data: CcWinner[] }> {
  const q = new URLSearchParams();
  if (opts.count) q.set('count', String(opts.count));
  if (opts.packType) q.set('packType', opts.packType);
  return gachaGet(`/api/getAllWinners?${q.toString()}`, opts);
}

// ── Wire shapes (micro-USDC strings) + pure mappers (unit-tested in collectorcrypt.test.ts) ──
export type LobbyMachine = {
  code: string; name: string; game: string;
  priceE6: string; buybackPct: number;
  tiers: Array<{ label: string; pct: number; minE6: string | null; maxE6: string | null }>;
  stock: Record<string, number>; image: string | null;
};
export type LobbyCard = { mint: string; name: string; imageUrl: string; valueE6: string; rarity: string };
export type LobbyWinner = { winner: string; mint: string; name: string | null; imageUrl: string | null; valueE6: string; tier: number; packType: string };

/** Dollars → micro-USDC string (0 for non-finite). */
const e6 = (dollars: number | undefined | null): string => usdc(Number.isFinite(dollars as number) ? (dollars as number) : 0).toString();
/** Category from the machine code prefix (e.g. "pokemon_50" → "pokemon"), for the lobby's game tabs. */
function gameOf(code: string): string {
  return (code.split(/[_-]/)[0] || '').toLowerCase() || 'other';
}

export function toLobbyMachine(m: CcMachine): LobbyMachine {
  const tiers = Object.entries(m.odds ?? {}).map(([label, p]) => {
    const r = m.tierRanges?.[label];
    return { label, pct: Math.round((p ?? 0) * 1000) / 10, minE6: r ? e6(r.start) : null, maxE6: r ? e6(r.end) : null };
  });
  return { code: m.code, name: m.name, game: gameOf(m.code), priceE6: e6(m.price), buybackPct: m.instantBuyback ?? 0, tiers, stock: m.stock ?? {}, image: m.thumbnailUrl ?? null };
}
export function toLobbyCard(n: CcPackNft): LobbyCard {
  return { mint: n.nft_address, name: n.name, imageUrl: n.image, valueE6: e6(n.insured_value), rarity: n.rarity };
}
export function toLobbyWinner(w: CcWinner): LobbyWinner {
  return {
    winner: w.winner,
    mint: w.nft_address,
    name: w.nft?.content?.metadata?.name ?? null,
    imageUrl: w.nft?.content?.links?.image ?? null,
    valueE6: e6(w.insuredValue),
    tier: w.prize_tier,
    packType: w.pack_type,
  };
}
