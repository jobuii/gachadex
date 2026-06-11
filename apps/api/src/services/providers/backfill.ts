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

/** Set names: case/punctuation-insensitive ('Base Set' ~ 'base-set'). */
export function normSet(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return n || null;
}

export interface MarketToMatch {
  number: string | null; // collector number parsed from display_name
  setName: string | null; // markets.metadata->>'setName'
  priceUsd?: number | null; // the market's latest oracle price — disambiguates printing variants
}

// Price tie-break tolerance: among same-set+number printing variants (Unlimited / 1st Edition /
// Shadowless…), prices differ 3-10×, so "the unique candidate within ±40% of the market's own price"
// is a safe fingerprint. Two candidates inside the band stays ambiguous (never guess).
const PRICE_MATCH_TOLERANCE = 0.4;

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
  const set = normSet(market.setName);
  if (!num) return null; // without a collector number a name-only match is too risky to stamp

  const byNumber = candidates.filter((c) => normNumber(c.number) === num);
  const setMatched = set ? byNumber.filter((c) => normSet(c.set?.name) === set) : [];
  if (setMatched.length === 1) return setMatched[0];
  // Same set + number more than once = printing variants — the only pool where the price rationale
  // holds, so only here does the tie-break apply.
  if (setMatched.length > 1) return uniqueByPrice(setMatched, market.priceUsd);
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
  const rows = await db.query<{ id: string; display_name: string; game: string; set_name: string | null; price_e6: string | null }>(
    `SELECT m.id, m.display_name, m.game, m.metadata->>'setName' AS set_name,
            (SELECT op.index_price_e6::text FROM oracle_prices op
              WHERE op.market_id = m.id AND op.is_accepted
              ORDER BY op.source_observed_at DESC LIMIT 1) AS price_e6
       FROM markets m WHERE m.kind = 'card' AND m.provider_card_id IS NULL ORDER BY m.display_name`,
  );

  const report: BackfillReport = { total: rows.rows.length, matched: 0, applied: 0, unmatched: [] };
  for (const row of rows.rows) {
    const { name, number } = parseDisplayName(row.display_name);
    const page = await client.searchCards({ q: name, game: row.game, limit: 50 }, 'discovery');
    const priceUsd = row.price_e6 != null ? Number(row.price_e6) / 1_000_000 : null;
    const match = matchCard({ number, setName: row.set_name, priceUsd }, page.data);
    if (!match) {
      const reason = page.data.length === 0 ? 'no-results' : 'ambiguous';
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
