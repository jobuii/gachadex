import type { Db } from '../../db/client.ts';
import type { TcgPriceLookupClient, TplCard } from './tcgpricelookup.ts';

/**
 * One-time backfill (P1): stamp existing card markets with their stable tcgpricelookup identity
 * (markets.tcgplayer_id + provider_card_id) so the P5 cutover re-prices them IN PLACE instead of
 * orphaning them. pokemontcg exposes no tcgplayer product id (verified live), so matching is by
 * name + collector number + set name against the tcgpricelookup search — and it is deliberately
 * CONSERVATIVE: only an unambiguous match is stamped; everything else lands in the report for the
 * operator. Idempotent: only rows with provider_card_id IS NULL are considered.
 */

/** "Charizard ex #223" -> { name: 'Charizard ex', number: '223' } (the ingest displayName format). */
export function parseDisplayName(displayName: string): { name: string; number: string | null } {
  const m = displayName.match(/^(.*) #([^#]+)$/);
  return m ? { name: m[1], number: m[2] } : { name: displayName, number: null };
}

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
}

/** Pick the ONE candidate that matches on collector number + set name; ambiguity returns null. */
export function matchCard(market: MarketToMatch, candidates: TplCard[]): TplCard | null {
  const num = normNumber(market.number);
  const set = normSet(market.setName);
  if (!num) return null; // without a collector number a name-only match is too risky to stamp

  const byNumber = candidates.filter((c) => normNumber(c.number) === num);
  if (set) {
    const exact = byNumber.filter((c) => normSet(c.set?.name) === set);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null; // same set + number twice (variants) — operator decides
  }
  // No set metadata stored (or no set match): accept only if the number alone is unambiguous.
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
  const rows = await db.query<{ id: string; display_name: string; game: string; set_name: string | null }>(
    `SELECT id, display_name, game, metadata->>'setName' AS set_name
       FROM markets WHERE kind = 'card' AND provider_card_id IS NULL ORDER BY display_name`,
  );

  const report: BackfillReport = { total: rows.rows.length, matched: 0, applied: 0, unmatched: [] };
  for (const row of rows.rows) {
    const { name, number } = parseDisplayName(row.display_name);
    const page = await client.searchCards({ q: name, game: row.game, limit: 50 }, 'discovery');
    const match = matchCard({ number, setName: row.set_name }, page.data);
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
