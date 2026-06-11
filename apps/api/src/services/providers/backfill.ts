import type { Db } from '../../db/client.ts';
import { rawPriceUsd, type TcgPriceLookupClient, type TplCard } from './tcgpricelookup.ts';
import { parseDisplayName } from './display.ts';

/**
 * One-time backfill (P1): stamp existing card markets with their stable tcgpricelookup identity
 * (markets.tcgplayer_id + provider_card_id) so the P5 cutover re-prices them IN PLACE instead of
 * orphaning them. pokemontcg exposes no tcgplayer product id (verified live), so matching is by
 * name + collector number + set name against the tcgpricelookup search — and it is deliberately
 * CONSERVATIVE: only an unambiguous match is stamped; everything else lands in the report for the
 * operator. Idempotent: only rows with provider_card_id IS NULL are considered.
 */

/** Collector numbers: '006/197' ~ '6'. Compare the pre-slash part, zero-stripped, case-folded. */
export function normNumber(n: string | null | undefined): string | null {
  if (!n) return null;
  const head = n.split('/')[0].trim().toLowerCase();
  const stripped = head.replace(/^0+/, '');
  return stripped || head; // '000' stays '000' rather than ''
}

/** Set names: case/punctuation-insensitive, '&' ~ 'and' ('Base Set' ~ 'base-set'). */
export function normSet(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  return n || null;
}

// pokemontcg set names that differ from tcgpricelookup's beyond prefixing (normalized form).
// Deterministic aliases beat looser containment heuristics, which would false-positive siblings
// ('Base Set' ⊂ 'Base Set 2').
const SET_ALIASES: Record<string, string> = {
  base: 'baseset', // pokemontcg 'Base' = tpl 'Base Set'
  expeditionbaseset: 'expedition', // pokemontcg 'Expedition Base Set' = tpl 'Expedition'
};

/** tcgpricelookup prefixes set codes ('SWSH07: Evolving Skies' vs pokemontcg 'Evolving Skies'), so
 *  set agreement is normalized SUFFIX containment, either direction — exact stays a special case.
 *  `b` is the MARKET's set name (alias-corrected); `a` is the provider candidate's. */
export function setsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normSet(a);
  const nbRaw = normSet(b);
  if (!na || !nbRaw) return false;
  const nb = SET_ALIASES[nbRaw] ?? nbRaw;
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

/** Printing variants normalize across providers: pokemontcg 'reverseHolofoil' ~ tpl 'Reverse Holofoil'. */
export function normVariant(v: string | null | undefined): string | null {
  if (!v) return null;
  const n = v.toLowerCase().replace(/[^a-z0-9]/g, '');
  return n || null;
}

/** Narrow a same-set variant pool by the market's own variant: exact match first, then suffix
 *  ('holofoil' selects 'Unlimited Holofoil'-style supersets); no agreement leaves the pool as-is. */
function narrowByVariant(pool: TplCard[], marketVariant: string | null | undefined): TplCard[] {
  const v = normVariant(marketVariant);
  if (!v) return pool;
  const exact = pool.filter((c) => normVariant(c.variant) === v);
  if (exact.length > 0) return exact;
  const suffix = pool.filter((c) => normVariant(c.variant)?.endsWith(v));
  return suffix.length > 0 ? suffix : pool;
}

export interface MarketToMatch {
  number: string | null; // collector number parsed from display_name
  setName: string | null; // markets.metadata->>'setName'
  variant?: string | null; // markets.variant — disambiguates same-set printing rows (Holo vs Reverse)
  priceUsd?: number | null; // the market's latest oracle price — disambiguates printing variants
}

// Price tie-break tolerance: among same-set+number printing variants (Unlimited / 1st Edition /
// Shadowless…), prices differ 3-10×, so "the unique candidate within ±40% of the market's own price"
// is a safe fingerprint. Two candidates inside the band stays ambiguous (never guess).
const PRICE_MATCH_TOLERANCE = 0.4;
const MAX_CANDIDATES = 600; // search-pagination cap per market (biggest observed name: Charizard, 560)

function uniqueByPrice(pool: TplCard[], priceUsd: number | null | undefined): TplCard | null {
  if (priceUsd == null || priceUsd <= 0) return null;
  const within = pool.filter((c) => {
    const p = rawPriceUsd(c);
    return p > 0 && Math.abs(p / priceUsd - 1) <= PRICE_MATCH_TOLERANCE;
  });
  return within.length === 1 ? within[0] : null;
}

/** Pick the ONE candidate matching on collector number + set name; printing-variant ambiguity is
 *  resolved by price proximity (unique candidate near the market's own price); else null. */
export function matchCard(market: MarketToMatch, candidates: TplCard[]): TplCard | null {
  const num = normNumber(market.number);
  if (!num) return null; // without a collector number a name-only match is too risky to stamp

  const byNumber = candidates.filter((c) => normNumber(c.number) === num);
  const setMatched = market.setName ? byNumber.filter((c) => setsMatch(c.set?.name, market.setName)) : [];
  if (setMatched.length === 1) return setMatched[0];
  // Same set + number more than once = printing variants. Tie-break cascade: the market's own
  // variant first (exact, then suffix), then price — the only pool where these rationales hold.
  if (setMatched.length > 1) {
    const narrowed = narrowByVariant(setMatched, market.variant);
    if (narrowed.length === 1) return narrowed[0];
    return uniqueByPrice(narrowed, market.priceUsd);
  }
  // No set metadata (or no set agreement): cross-set same-number cards have no price-separation
  // guarantee, so stay strictly conservative — unique or nothing.
  return byNumber.length === 1 ? byNumber[0] : null;
}

export interface BackfillReport {
  total: number;
  matched: number;
  applied: number;
  unmatched: { id: string; name: string; reason: 'no-results' | 'ambiguous' | 'conflict' }[];
}

/** Match every unstamped card market against tcgpricelookup and (with apply=true) write the ids. */
export async function backfillProviderIds(
  db: Db,
  client: TcgPriceLookupClient,
  opts: { apply: boolean; log?: (msg: string) => void },
): Promise<BackfillReport> {
  const log = opts.log ?? (() => {});
  const rows = await db.query<{ id: string; display_name: string; game: string; set_name: string | null; variant: string | null; price_e6: string | null }>(
    `SELECT m.id, m.display_name, m.game, m.metadata->>'setName' AS set_name, m.variant,
            (SELECT op.index_price_e6::text FROM oracle_prices op
              WHERE op.market_id = m.id AND op.is_accepted
              ORDER BY op.source_observed_at DESC LIMIT 1) AS price_e6
       FROM markets m WHERE m.kind = 'card' AND m.provider_card_id IS NULL ORDER BY m.display_name`,
  );

  const report: BackfillReport = { total: rows.rows.length, matched: 0, applied: 0, unmatched: [] };
  for (const row of rows.rows) {
    const { name, number } = parseDisplayName(row.display_name);
    // Popular names return hundreds of results (Charizard: 560) — page until exhausted (capped) so the
    // right candidate is actually in the pool.
    const candidates: TplCard[] = [];
    for (let offset = 0; ; ) {
      const page = await client.searchCards({ q: name, game: row.game, limit: 100, offset }, 'discovery');
      candidates.push(...page.data);
      offset += page.data.length;
      if (page.data.length === 0 || offset >= page.total || offset >= MAX_CANDIDATES) break;
    }
    const priceUsd = row.price_e6 != null ? Number(row.price_e6) / 1_000_000 : null;
    const match = matchCard({ number, setName: row.set_name, variant: row.variant, priceUsd }, candidates);
    if (!match) {
      const reason = candidates.length === 0 ? 'no-results' : 'ambiguous';
      report.unmatched.push({ id: row.id, name: row.display_name, reason });
      log(`✗ ${row.display_name} — ${reason}`);
      continue;
    }
    if (!opts.apply) {
      report.matched++;
      log(`✓ ${row.display_name} -> ${match.id} (tcgplayer ${match.tcgplayer_id ?? '—'})`);
      continue;
    }
    try {
      await db.query(
        `UPDATE markets
            SET provider_card_id = $2,
                tcgplayer_id = COALESCE(tcgplayer_id, $3)
          WHERE id = $1 AND provider_card_id IS NULL`,
        [row.id, match.id, match.tcgplayer_id],
      );
      report.matched++;
      report.applied++;
      log(`✓ ${row.display_name} -> ${match.id} (tcgplayer ${match.tcgplayer_id ?? '—'})`);
    } catch {
      // unique-index violation: another market already claimed this provider card — surface, don't stamp
      report.unmatched.push({ id: row.id, name: row.display_name, reason: 'conflict' });
      log(`✗ ${row.display_name} — conflict (provider card already claimed)`);
    }
  }
  return report;
}
