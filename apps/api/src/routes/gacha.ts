import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { rl } from './_ratelimit.ts';
import { authenticate } from '../plugins/auth.ts';
import { getDb } from '../db/client.ts';
import { getNfts, getAllWinners, getMachinesCached, toLobbyMachine, toLobbyCard, toLobbyWinner, defaultCcClient } from '../services/providers/collectorcrypt.ts';
import { getGoldSummary, getGoldHistory } from '../services/gold.ts'; // no @solana/web3.js dep → safe to load eagerly (unlike gacha.ts)
import { gachaConfig, gachaMarkupE6 } from '../services/gacha-config.ts'; // settings-only, no web3 dep → eager-safe
import type { GachaChain } from '../services/custody/gacha-chain.ts';

/**
 * Classic Gacha lobby (docs/classic-gacha-cc-packs-spec.md, P0 — read-only). A public proxy of Collector
 * Crypt's gacha reads (machines / cards / winners), mapped to micro-USDC for the wire. Gated behind
 * CLASSIC_GACHA_ENABLED — 404 while off (the web also hides the entry via /health). No buying/custody here;
 * the open / sell-back / withdraw flows + money are P1+.
 */
const MACHINE_CODE_RE = /^[a-z0-9_-]{1,64}$/i; // CC codes look like "pokemon_50" — a cheap guard before we proxy to CC
const RARITIES = new Set(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']);
const TRADE = { preHandler: authenticate, config: { scope: 'trade' as const } };
const FULL = { preHandler: authenticate, config: { scope: 'full' as const } }; // withdrawing a real NFT is high-risk → full scope + step-up

// The Solana chain + the gacha service are lazy-loaded so @solana/web3.js never loads on the read-only /
// play-money boot path (mirrors how server.ts lazy-loads the custody chain).
let gachaChain: GachaChain | null = null;
async function realChain(): Promise<GachaChain> {
  if (!gachaChain) gachaChain = (await import('../services/custody/gacha-chain.ts')).solanaGachaChain();
  return gachaChain;
}
const gachaSvc = () => import('../services/gacha.ts'); // import() is module-cached

export async function gachaRoutes(app: FastifyInstance): Promise<void> {
  const gate = () => {
    if (!config.classicGachaEnabled) throw new HttpError(404, 'not found');
  };

  // Lobby tiles: the available CC machines (price, tier legend, buyback %, stock). Operator-disabled machines are
  // hidden, and the displayed price carries any GDEX markup so the client sends it back as the expected price.
  app.get('/gacha/machines', rl(config.routeRateLimits.gameFairness), async () => {
    gate();
    const { machines } = await getMachinesCached({ ttlMs: gachaConfig.stockRefreshSecs.get() * 1000, paused: gachaConfig.stockPaused.get() });
    const disabled = new Set(gachaConfig.disabledMachines.get());
    const markupBps = gachaConfig.markupBps.get();
    const out = (machines ?? [])
      .filter((m) => !disabled.has(m.code))
      .map(toLobbyMachine)
      .map((m) => (markupBps > 0 ? { ...m, priceE6: (BigInt(m.priceE6) + gachaMarkupE6(m.priceE6, markupBps)).toString() } : m));
    return { machines: out };
  });

  // The real graded cards in a machine's pool.
  app.get('/gacha/machines/:code/cards', rl(config.routeRateLimits.gameFairness), async (req) => {
    gate();
    const { code } = req.params as { code: string };
    if (!MACHINE_CODE_RE.test(code)) throw new HttpError(400, 'bad machine code'); // don't forward arbitrary strings to CC
    const q = req.query as { rarity?: string; page?: string };
    const rarity = q.rarity && RARITIES.has(q.rarity.toLowerCase()) ? q.rarity.toLowerCase() : undefined;
    const page = q.page ? Math.min(Math.max(Number(q.page) || 1, 1), 50) : undefined;
    const { nfts } = await getNfts(code, { rarity, page });
    return { cards: (nfts ?? []).map(toLobbyCard) };
  });

  // Recent winners ticker (most-recent-first; count caps at 200).
  app.get('/gacha/winners', rl(config.routeRateLimits.gameFairness), async (req) => {
    gate();
    const q = req.query as { count?: string; packType?: string };
    const count = Math.min(Number(q.count) || 50, 200);
    const packType = q.packType && MACHINE_CODE_RE.test(q.packType) ? q.packType : undefined; // validate before proxying to CC (like machineCode)
    const { data } = await getAllWinners({ count, packType });
    return { winners: (data ?? []).map(toLobbyWinner) };
  });

  // ── P1: buy → open → sell-back. Real-funds only (CC takes real on-chain USDC). Trade-scoped + auth'd. ──
  const realGate = () => {
    gate();
    if (!config.realFunds) throw new HttpError(403, 'classic gacha needs real-funds mode');
  };

  app.post('/gacha/open', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    realGate();
    const b = (req.body ?? {}) as { machineCode?: string; idempotencyKey?: string; expectedPriceE6?: string; payWith?: string; turbo?: boolean; claim?: boolean };
    if (!b.machineCode || !MACHINE_CODE_RE.test(b.machineCode)) throw new HttpError(400, 'bad machine code');
    if (typeof b.idempotencyKey !== 'string' || b.idempotencyKey.length < 1 || b.idempotencyKey.length > 100) throw new HttpError(400, 'bad idempotency key');
    const expectedPriceE6 = typeof b.expectedPriceE6 === 'string' && /^\d{1,20}$/.test(b.expectedPriceE6) ? b.expectedPriceE6 : undefined;
    const payWith = b.payWith === 'gold' ? ('gold' as const) : ('usdc' as const);
    const { openPack } = await gachaSvc();
    return openPack(await getDb(), req.userId!, { machineCode: b.machineCode, idempotencyKey: b.idempotencyKey, expectedPriceE6, payWith, turbo: b.turbo === true, claim: b.claim === true }, { chain: await realChain(), cc: defaultCcClient });
  });

  // Poll a single open (the web polls until the reveal lands).
  app.get('/gacha/opens/:id', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => {
    realGate();
    const { getOpen } = await gachaSvc();
    return getOpen(await getDb(), req.userId!, (req.params as { id: string }).id);
  });

  // Sweep the caller's stranded paid opens (fire-and-forget on lobby load + after an open).
  app.post('/gacha/reconcile', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => {
    realGate();
    const { reconcilePending } = await gachaSvc();
    return reconcilePending(await getDb(), req.userId!, { chain: await realChain(), cc: defaultCcClient });
  });

  // The caller's held NFTs (Portfolio → Inventory).
  app.get('/gacha/inventory', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => {
    gate();
    const { listInventory } = await gachaSvc();
    return { inventory: await listInventory(await getDb(), req.userId!) };
  });

  // Loyalty Gold (P4): balance (+ progress to a free pack) and ledger history.
  app.get('/gold/balance', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => {
    gate();
    return getGoldSummary(await getDb(), req.userId!);
  });
  app.get('/gold/history', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => {
    gate();
    return { history: await getGoldHistory(await getDb(), req.userId!) };
  });

  // Sell a held NFT back to CC for USDC (GDEX keeps 5%).
  app.post('/gacha/prizes/:id/sell-back', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    realGate();
    const instant = Boolean(((req.body ?? {}) as { instant?: boolean }).instant); // sell-on-reveal → 10% cut
    const { sellBack } = await gachaSvc();
    return sellBack(await getDb(), req.userId!, (req.params as { id: string }).id, { chain: await realChain(), cc: defaultCcClient }, { instant });
  });

  // Convert a won card → a GDEX perp on its market (lever C): sell-back then open a position with the proceeds.
  // 409 'no_market' when the card has no matched market; stage 2 failing leaves the user with the USDC proceeds.
  app.post('/gacha/prizes/:id/convert', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    realGate();
    const b = (req.body ?? {}) as { side?: string; leverage?: number };
    const side = b.side === 'short' ? 'short' : b.side === 'long' ? 'long' : undefined;
    const leverage = Number.isFinite(b.leverage) ? Number(b.leverage) : undefined;
    const { convert } = await gachaSvc();
    return convert(await getDb(), req.userId!, (req.params as { id: string }).id, { chain: await realChain(), cc: defaultCcClient }, { side, leverage });
  });

  // Withdraw a held NFT to the user's own wallet (P2). Step 1: the step-up nonce/message over (mint, dest).
  app.post('/gacha/prizes/:id/withdraw/nonce', rl(config.routeRateLimits.withdrawNonce, FULL), async (req) => {
    realGate();
    const { dest } = (req.body ?? {}) as { dest?: string };
    if (!dest) throw new HttpError(400, 'dest required');
    const { nftWithdrawNonce } = await gachaSvc();
    return nftWithdrawNonce(await getDb(), req.userId!, req.pubkey!, (req.params as { id: string }).id, dest);
  });

  // Step 2: submit the signed step-up → transfer the NFT out to the destination.
  app.post('/gacha/prizes/:id/withdraw', rl(config.routeRateLimits.withdraw, FULL), async (req) => {
    realGate();
    const b = (req.body ?? {}) as { dest?: string; message?: string; signature?: string };
    if (!b.dest || !b.message || !b.signature) throw new HttpError(400, 'dest, message, signature required');
    const { requestNftWithdraw } = await gachaSvc();
    return requestNftWithdraw(await getDb(), req.userId!, req.pubkey!, (req.params as { id: string }).id, { dest: b.dest, message: b.message, signature: b.signature }, { chain: await realChain(), cc: defaultCcClient });
  });
}
