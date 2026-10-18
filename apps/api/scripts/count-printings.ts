/**
 * Plan P5 step 1 (read-only report): how many EXTRA card printings would become markets under "one market per
 * printing", and the Scrydex printing names our live markets would have to map (the name map).
 *
 *   railway run --service "@pokex/api" env DATABASE_URL="$PRODDB" npx tsx scripts/count-printings.ts [--games pokemon,mtg,onepiece] [--names-only]
 *
 * --names-only skips the catalogue read (~5 Scrydex credits, a minute) and lists each live market whose ONE Scrydex
 * printing on its product disagrees with it on foil-ness — the matcher takes a lone printing without a name check.
 *
 * Reads the whole tcgpricelookup catalogue once per game (~2,200 requests in total at 1 req/s, ~40 min; the same read
 * the weekly discovery job makes) and the Scrydex cards of our live markets (~5 credits). Writes NOTHING except the
 * shared provider request counters (provider_rate) that every provider call updates. Deliberately does NOT run the
 * schema migration (no initDb), so running it from an undeployed checkout can't change the prod schema.
 */
import { GAMES } from '@pokex/shared-types';
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { TcgPriceLookupClient, rawPriceUsd, hasLiquiditySignal, tplTcgplayerId, MIN_LIST_PRICE_USD } from '../src/services/providers/tcgpricelookup.ts';
import { getDefaultScrydexClient, scrydexSlug } from '../src/services/providers/scrydex.ts';
import { normVariant } from '../src/services/providers/backfill.ts';

if (!config.tcgpricelookupApiKey) {
  console.error('TCGPRICELOOKUP_API_KEY is not set (run it through `railway run`)');
  process.exit(1);
}
const gi = process.argv.indexOf('--games');
const games = gi > 0 ? (process.argv[gi + 1] ?? '').split(',').filter((g) => (GAMES as readonly string[]).includes(g)) : [...GAMES];
const db = await getDb();
const tpl = new TcgPriceLookupClient(db);
const PER_MARKET_DAY = 0.23; // tcgpricelookup requests per priced market per day (measured 18 Oct 2026)
const namesOnly = process.argv.includes('--names-only');

console.log(`count-printings: ${games.join(', ')} — ${namesOnly ? 'Scrydex names only' : 'catalogue read'}, no writes\n`);
let totalExtra = 0;
for (const game of namesOnly ? [] : games) {
  // product → listable printings (≥ $10 AND a sales signal: the plan's one listing rule for printings)
  const byProduct = new Map<number, { id: string; usd: number; variant: string | null }[]>();
  let scanned = 0;
  for (let offset = 0; ; ) {
    const page = await tpl.searchCards({ game, limit: 100, offset }, 'discovery');
    for (const c of page.data) {
      const usd = rawPriceUsd(c);
      const tid = tplTcgplayerId(c);
      if (tid == null || usd < MIN_LIST_PRICE_USD || !hasLiquiditySignal(c)) continue;
      const list = byProduct.get(tid) ?? [];
      list.push({ id: c.id, usd, variant: c.variant });
      byProduct.set(tid, list);
    }
    scanned += page.data.length;
    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.total) break;
    if (Math.floor(offset / 100) % 100 === 0) console.log(`  …${game}: ${offset}/${page.total}`);
  }
  const multi = [...byProduct.values()].filter((l) => l.length > 1);
  const extra = multi.reduce((a, l) => a + l.length - 1, 0);
  const extraOf = (tids: Set<number>) => [...byProduct].filter(([tid, l]) => l.length > 1 && tids.has(tid)).reduce((a, [, l]) => a + l.length - 1, 0);
  const listed = new Set(
    (await db.query<{ tid: string }>(`SELECT tcgplayer_id::text AS tid FROM markets WHERE kind = 'card' AND game = $1 AND status <> 'delisted' AND tcgplayer_id IS NOT NULL`, [game])).rows.map((r) => Number(r.tid)),
  );
  const extraOfListed = extraOf(listed);
  const featuredTids = new Set(
    (await db.query<{ tid: string }>(`SELECT tcgplayer_id::text AS tid FROM markets WHERE kind = 'card' AND game = $1 AND featured AND tcgplayer_id IS NOT NULL`, [game])).rows.map((r) => Number(r.tid)),
  );
  const extraOfFeatured = extraOf(featuredTids);
  const variants = new Map<string, number>();
  for (const l of multi) {
    for (const p of l) {
      const name = p.variant ?? '(none)';
      variants.set(name, (variants.get(name) ?? 0) + 1);
    }
  }
  totalExtra += extraOfFeatured;
  console.log(`${game}: scanned ${scanned}; listable products ${byProduct.size}; with 2+ listable printings ${multi.length}`);
  console.log(`  extra printings: all ${extra} · of products we already list ${extraOfListed} · of FEATURED products ${extraOfFeatured} (what discovery would add)`);
  console.log(`  printing names among them: ${[...variants].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, n]) => `${v} ${n}`).join(' · ')}`);
}

// Scrydex printing names our LIVE markets map to (for the name map; ~1 credit per 100 cards).
const sx = getDefaultScrydexClient(db);
const tracked = (
  await db.query<{ game: string; symbol: string; display_name: string; scrydex_card_id: string; variant: string | null; tcgplayer_id: string | null }>(
    `SELECT game, symbol, display_name, scrydex_card_id, variant, tcgplayer_id::text AS tcgplayer_id FROM markets
      WHERE kind = 'card' AND status <> 'delisted' AND scrydex_card_id IS NOT NULL AND game = ANY($1)`,
    [games],
  )
).rows;
console.log(`\nScrydex printing names for ${tracked.length} live markets:`);
for (const game of games) {
  const slug = scrydexSlug(game);
  const rows = tracked.filter((t) => t.game === game);
  if (!slug || !rows.length) continue;
  const cards = new Map((await sx.getCardsByIds(slug, [...new Set(rows.map((r) => r.scrydex_card_id))], 'discovery')).map((c) => [c.id, c]));
  const pairs = new Map<string, number>();
  const lone: string[] = [];
  const foily = (v: string | null | undefined) => (normVariant(v) ?? '').includes('foil');
  let ambiguous = 0;
  for (const r of rows) {
    const cand = (cards.get(r.scrydex_card_id)?.variants ?? []).filter((v) => (v.marketplaces ?? []).some((m) => String(m.product_id) === r.tcgplayer_id));
    if (cand.length > 1) ambiguous++;
    // One Piece names never say "foil" (art names), so foil-ness can't disagree meaningfully there
    if (cand.length === 1 && game !== 'onepiece' && foily(r.variant) !== foily(cand[0].name)) {
      lone.push(`    ${r.symbol}  tcgplayer ${r.tcgplayer_id}  ${r.variant ?? '(none)'} → ${cand[0].name}  ${r.display_name}`);
    }
    const key = `${r.variant ?? '(none)'} → ${cand.map((v) => v.name).join('|') || '(no printing on this product)'}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  console.log(`${game}: ${rows.length} markets, ${ambiguous} with 2+ Scrydex printings on their product`);
  for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(4)}  ${k}`);
  if (lone.length) console.log(`  one Scrydex printing, other foil-ness (priced off it without a name check): ${lone.length}\n${lone.join('\n')}`);
}
if (!namesOnly) console.log(`\nEstimated tcgpricelookup cost if discovery lists the extra printings of featured products: +${Math.round(totalExtra * PER_MARKET_DAY)} requests/day`);
await closeDb();
