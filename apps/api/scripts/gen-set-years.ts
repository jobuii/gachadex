/**
 * Generator for `src/services/providers/set-years.data.ts` — the committed slug→release-year table.
 *
 *   TCGPRICELOOKUP_API_KEY=<key> npx tsx scripts/gen-set-years.ts
 *
 * Why a static table: the price oracle (tcgpricelookup) returns `released_at: null` for EVERY set —
 * it carries no release dates. So we source the year ONCE, here, and commit the result. Two inputs:
 *   1. tcgpricelookup GET /sets  — the set SLUGS (the key markets join on, via metadata.setSlug).
 *   2. tcgcsv.com TCGplayer group `publishedOn` — the actual release date, free + no key, all games.
 * Sets are matched by normalized name (tpl set names are code-prefixed, e.g. "SWSH11: Lost Origin").
 *
 * Re-run when new sets get listed (rare). It only touches the committed data file; nothing reads the
 * network at runtime. Real-market coverage is ~100% (unmatched sets are tiny tpl name fragments and
 * promo aggregations that have no single release date — they simply render no Release Year).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../src/config.ts';
import { GAMES } from '@pokex/shared-types';

if (!config.tcgpricelookupApiKey) {
  console.error('TCGPRICELOOKUP_API_KEY is not set');
  process.exit(1);
}

// tcgcsv mirrors TCGplayer categories; these are the three games we trade.
const TCGCSV_CATEGORY: Record<string, number> = { pokemon: 3, mtg: 1, onepiece: 68 };
const UA = 'gachadex-set-year-generator (+https://gachadex.fun)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NUMWORD: Record<string, string> = {
  '1st': 'first', '2nd': 'second', '3rd': 'third', '4th': 'fourth', '5th': 'fifth',
  '6th': 'sixth', '7th': 'seventh', '8th': 'eighth', '9th': 'ninth', '10th': 'tenth',
};

/** Canonical comparison key: lowercase, drop parentheticals/punctuation, spell out edition numbers. */
function normName(name: string): string {
  let s = name.toLowerCase().trim();
  s = s.replace(/\([^)]*\)/g, ''); // "(Shadowless)" etc.
  s = s.replace(/&/g, 'and').replace(/é/g, 'e').replace(/—/g, '-').replace(/’/g, "'");
  s = s.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  return s.split(' ').map((w) => NUMWORD[w] ?? w).join(' ');
}

/** Candidate keys for a tpl set name: with/without a "CODE: " or "CODE - " prefix, and a trailing
 *  "base set" trimmed (tpl's "Sword & Shield Base Set" is tcgplayer's "Sword & Shield"). */
function candidateKeys(name: string): string[] {
  const forms = new Set<string>([name]);
  if (name.includes(':')) forms.add(name.slice(name.indexOf(':') + 1));
  if (name.includes(' - ')) forms.add(name.slice(name.indexOf(' - ') + 3));
  const out = new Set<string>();
  for (const f of forms) {
    const b = normName(f);
    out.add(b);
    out.add(b.replace(/\bbase set$/, '').trim());
  }
  out.delete('');
  return [...out].filter((k) => k.length >= 3); // 1-2 char keys ("sm", "xy") collide on noise
}

async function fetchJson(url: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'X-API-Key': config.tcgpricelookupApiKey } });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
}

/** base(name) -> release year, from tcgcsv's TCGplayer groups for one game. */
async function yearByName(game: string): Promise<Map<string, number>> {
  const cat = TCGCSV_CATEGORY[game];
  const json = await fetchJson(`https://tcgcsv.com/tcgplayer/${cat}/groups`);
  const map = new Map<string, number>();
  for (const g of json.results ?? []) {
    // Real release dates are stamped at exactly midnight ("1999-01-09T00:00:00"). Groups with no real
    // date (ongoing promo buckets, aggregations) carry a CRAWL-TIME placeholder instead, e.g.
    // "2026-06-13T20:00:06.0089346Z" — reject those, or every one mis-dates to the crawl year.
    if (!/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(String(g.publishedOn ?? ''))) continue;
    const year = Number(String(g.publishedOn).slice(0, 4));
    if (!Number.isInteger(year)) continue;
    const key = normName(g.name);
    const prev = map.get(key);
    if (prev == null || year < prev) map.set(key, year); // earliest printing wins, deterministically
  }
  return map;
}

/** Every set slug + name from tcgpricelookup, paged. */
async function tplSets(game: string): Promise<{ slug: string; name: string }[]> {
  const out: { slug: string; name: string }[] = [];
  for (let offset = 0; ; ) {
    const json = await fetchJson(`${config.tcgpricelookupBase}/sets?game=${game}&limit=100&offset=${offset}`);
    const data: { slug: string; name: string }[] = json.data ?? [];
    out.push(...data.map((s) => ({ slug: s.slug, name: s.name })));
    offset += data.length;
    if (data.length === 0 || offset >= Number(json.total ?? 0)) break;
    await sleep(1200); // tpl paces ~1 req/s
  }
  return out;
}

const rows: { game: string; slug: string; name: string; year: number }[] = [];
let matched = 0;
let total = 0;
for (const game of GAMES) {
  const years = await yearByName(game);
  const sets = await tplSets(game);
  total += sets.length;
  let hit = 0;
  for (const s of sets) {
    const year = candidateKeys(s.name).map((k) => years.get(k)).find((y) => y != null);
    if (year != null) {
      rows.push({ game, slug: s.slug, name: s.name, year });
      hit++;
    }
  }
  matched += hit;
  console.log(`${game}: ${hit}/${sets.length} sets dated`);
  await sleep(1200);
}
rows.sort((a, b) => a.game.localeCompare(b.game) || a.slug.localeCompare(b.slug));

const header = `// AUTO-GENERATED by scripts/gen-set-years.ts — do NOT edit by hand.
// Release years for card sets, matched from tcgcsv.com TCGplayer group publishedOn dates (the price
// oracle carries none). Keyed by the tcgpricelookup set slug that markets store in metadata.setSlug.
// Regenerate: TCGPRICELOOKUP_API_KEY=<key> npx tsx scripts/gen-set-years.ts

export interface SetYear {
  game: string;
  slug: string;
  name: string;
  year: number;
}

export const SET_YEARS: readonly SetYear[] = [
`;
const body = rows
  .map((r) => `  { game: ${JSON.stringify(r.game)}, slug: ${JSON.stringify(r.slug)}, name: ${JSON.stringify(r.name)}, year: ${r.year} },`)
  .join('\n');
const out = `${header}${body}\n];\n`;

const dest = join(dirname(fileURLToPath(import.meta.url)), '../src/services/providers/set-years.data.ts');
writeFileSync(dest, out);
console.log(`\nwrote ${rows.length}/${total} sets -> ${dest} (${Math.round((100 * matched) / total)}% matched)`);
