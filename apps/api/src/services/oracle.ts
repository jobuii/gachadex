import { randomUUID } from 'node:crypto';
import { toE6, SCALE } from '@pokex/pricing';
import { INDEX_CATALOG } from '@pokex/shared-types';
import { config } from '../config.ts';
import type { Db, Queryer } from '../db/client.ts';
import { upsertCardMarket, upsertIndexMarket, getMarketById } from './markets.ts';
import { recomputeMark } from './marks.ts';
import { pokemontcgFetcher } from './providers/pokemontcg.ts';

/**
 * Provider-agnostic card snapshot — the seam between price providers and the oracle (P2 of the
 * tcgpricelookup plan). Each provider module (providers/pokemontcg.ts; tcgpricelookup in P3) owns its
 * own response shape and emits these; `ingest` knows no provider specifics.
 */
export interface OracleCard {
  game: string; // 'pokemon' | 'onepiece' | 'mtg'
  symbol: string; // market symbol: legacy bare id (pokemontcg) or cardSymbol(game, id) (providers)
  cardId: string; // provider display id — keys index constituents + the graded write
  tcgplayerId?: number | null; // stable cross-provider ids (markets.tcgplayer_id / provider_card_id)
  providerCardId?: string | null;
  displayName: string;
  variant: string | null;
  imageSmall: string | null;
  imageLarge?: string | null;
  setLogo?: string | null;
  metadata?: unknown; // provider-extracted detail-panel JSON (markets.metadata column)
  rawE6: bigint; // raw spot in micro-USD; 0n = unpriced (skipped by ingest)
  gradedE6?: bigint | null; // PSA-10 in micro-USD when the provider supplies it inline (P3); else the gradedFetcher fallback runs
  observedAt?: Date | null; // provider freshness timestamp; null/absent -> the ingest pass wall-clock (legacy behavior)
  payload?: unknown; // audit payload stored on the oracle print
}

/** Returns the cards to ingest. Injectable for tests. */
export type CardFetcher = () => Promise<OracleCard[]>;

const OUTLIER_THRESHOLD = 0.6; // reject prints > 60% from last accepted (manipulation/staleness guard)
const BASE_VALUE_E6 = 1_000_000_000n; // indices start at 1000.000000 points
const REANCHOR_JUMP_FACTOR = 4n; // a 1-tick jump beyond this can only be a wrong-scale divisor, not a real basket move

/** Returns the PSA-10 graded price (USD) for a card, or null. Injectable for tests. */
export type GradedFetcher = (card: OracleCard) => Promise<number | null>;

/** JustTCG graded fallback — used when the raw provider doesn't supply gradedE6 inline. */
async function fetchGradedPrice(card: OracleCard): Promise<number | null> {
  if (!config.justtcgApiKey) return null;
  const query = card.tcgplayerId ? `tcgplayerId=${card.tcgplayerId}` : `cardId=${encodeURIComponent(card.cardId)}`;
  try {
    const res = await fetch(`${config.justtcgBase}/v1/cards?${query}`, { headers: { 'x-api-key': config.justtcgApiKey } });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const row = Array.isArray(json) ? json[0] : (json?.data?.[0] ?? json);
    const psa10 = row?.prices?.psa10 ?? row?.prices?.['psa 10'] ?? row?.prices?.['psa-10'];
    const n = psa10 != null ? Number(psa10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Insert an oracle print, guarding against outliers. Returns whether it was accepted. */
async function recordOracle(
  q: Queryer,
  marketId: string,
  indexE6: bigint,
  observedAt: Date,
  payload: unknown,
): Promise<boolean> {
  const last = await q.query<{ v: string }>(
    `SELECT index_price_e6::text AS v FROM oracle_prices
     WHERE market_id = $1 AND is_accepted ORDER BY source_observed_at DESC LIMIT 1`,
    [marketId],
  );
  let accepted = true;
  let reason: string | null = null;
  const prev = last.rows[0] ? BigInt(last.rows[0].v) : 0n;
  if (prev > 0n) {
    const dev = Number(indexE6 - prev) / Number(prev);
    if (Math.abs(dev) > OUTLIER_THRESHOLD) {
      // Escape hatch: adopt a large move once it PERSISTS (the most recent print already showed
      // this level) so a genuine >60% move can't wedge the market on a frozen reference forever.
      const recent = await q.query<{ v: string }>(
        `SELECT index_price_e6::text AS v FROM oracle_prices WHERE market_id=$1 ORDER BY source_observed_at DESC LIMIT 1`,
        [marketId],
      );
      const lastAny = recent.rows[0] ? BigInt(recent.rows[0].v) : 0n;
      const persisted = lastAny > 0n && lastAny !== prev && Math.abs(Number(indexE6 - lastAny) / Number(lastAny)) <= OUTLIER_THRESHOLD;
      if (persisted) {
        reason = 'force-accepted: level persisted';
      } else {
        accepted = false;
        reason = `outlier ${(dev * 100).toFixed(0)}% vs last`;
      }
    }
  }
  // RETURNING lets us detect a duplicate (no-op) insert so callers don't recompute a stray mark.
  // NOTE for P3: a provider-supplied observedAt makes this ON CONFLICT dedup re-polls of the SAME
  // provider snapshot (intended — one print per provider update). Wall-clock observedAt (the
  // pokemontcg path) never conflicts, so the live feed keeps printing every pass.
  const ins = await q.query<{ id: string }>(
    `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, is_accepted, reject_reason)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT(market_id, source_observed_at) DO NOTHING
     RETURNING id`,
    [marketId, indexE6.toString(), JSON.stringify(payload ?? null), observedAt.toISOString(), accepted, reason],
  );
  return ins.rows.length > 0 && accepted;
}

/** Ingest a price snapshot: upsert card markets, record prints, recompute marks, rebuild indices. */
export async function ingest(
  db: Db,
  fetcher: CardFetcher = pokemontcgFetcher,
  gradedFetcher: GradedFetcher | null = config.justtcgApiKey ? fetchGradedPrice : null,
): Promise<{ cards: number; indices: number; graded: number }> {
  const passObservedAt = new Date();
  const priced = (await fetcher()).filter((c) => c.rawE6 > 0n);

  // Operator-pinned markets carry a manual price (ROADMAP §2) — the auto-oracle never overwrites them.
  const pinnedRows = await db.query<{ id: string }>(`SELECT id FROM markets WHERE price_pinned`);
  const pinned = new Set(pinnedRows.rows.map((r) => r.id));

  for (const c of priced) {
    const marketId = await db.tx((q) =>
      upsertCardMarket(q, {
        game: c.game,
        symbol: c.symbol,
        cardId: c.cardId,
        displayName: c.displayName,
        variant: c.variant,
        imageSmall: c.imageSmall,
        imageLarge: c.imageLarge,
        setLogo: c.setLogo,
        metadata: c.metadata,
        tcgplayerId: c.tcgplayerId,
        providerCardId: c.providerCardId,
      }),
    );
    if (pinned.has(marketId)) continue; // manual override in effect — skip the auto print + mark
    const accepted = await db.tx((q) =>
      recordOracle(q, marketId, c.rawE6, c.observedAt ?? passObservedAt, c.payload ?? null),
    );
    if (accepted) {
      const market = await getMarketById(db, marketId);
      if (market) await db.tx((q) => recomputeMark(q, market, c.rawE6, 0n, 0n));
    }
  }

  // SINGLE-GAME ASSUMPTION (fixed in P4): `sorted` spans the whole pass, so the index + graded baskets
  // below would mix games if a multi-game fetcher ran today. P4 separates per-game featured constituents;
  // until then the cutover flag must not flip a multi-game feed live.
  const sorted = [...priced].sort((a, b) => (b.rawE6 > a.rawE6 ? 1 : b.rawE6 < a.rawE6 ? -1 : 0));

  // Graded (PSA-10) prices for the top-N — powers the Graded index + per-card graded panel. Providers
  // that carry graded inline (tcgpricelookup, P3) need no extra fetch; the gradedFetcher (JustTCG) is
  // the fallback for cards without it.
  const gradedMembers: { cardId: string; priceE6: bigint }[] = [];
  for (const c of sorted.slice(0, config.gradedConstituents)) {
    let gE6 = c.gradedE6 ?? null;
    if (gE6 == null && gradedFetcher) {
      const g = await gradedFetcher(c);
      if (g != null) gE6 = toE6(g); // non-positive values are dropped by the guard below
    }
    if (gE6 != null && gE6 > 0n) {
      await db.query(`UPDATE markets SET graded_psa10_e6=$1 WHERE card_id=$2 AND kind='card'`, [gE6.toString(), c.cardId]);
      gradedMembers.push({ cardId: c.cardId, priceE6: gE6 });
    }
  }

  let indices = 0;
  for (const idx of INDEX_CATALOG) {
    if (idx.slug === 'graded') {
      // tradeable only when we actually have PSA-10 data; priced off the graded basket
      if (gradedMembers.length > 0) {
        await buildIndex(db, idx, gradedMembers, passObservedAt, pinned);
        indices++;
      } else {
        await db.tx((q) => upsertIndexMarket(q, { game: idx.game, slug: idx.slug, name: idx.name, tradeable: false }));
      }
      continue;
    }
    if (!idx.tradeable) {
      await db.tx((q) => upsertIndexMarket(q, { game: idx.game, slug: idx.slug, name: idx.name, tradeable: false }));
      continue;
    }
    const n = idx.topN ?? sorted.length;
    const members = sorted.slice(0, n).map((x) => ({ cardId: x.cardId, priceE6: x.rawE6 }));
    await buildIndex(db, idx, members, passObservedAt, pinned);
    indices++;
  }
  return { cards: priced.length, indices, graded: gradedMembers.length };
}

async function buildIndex(
  db: Db,
  idx: { game: string; slug: string; name: string },
  members: { cardId: string; priceE6: bigint }[],
  observedAt: Date,
  pinned: Set<string>,
): Promise<void> {
  if (members.length === 0) return;
  const rawE6 = members.reduce((a, m) => a + m.priceE6, 0n);
  const marketId = await db.tx((q) => upsertIndexMarket(q, { game: idx.game, slug: idx.slug, name: idx.name, tradeable: true }));
  if (pinned.has(marketId)) return; // operator-pinned manual price — leave it alone

  // Divisor: based at BASE_VALUE on first build, then RE-BASED whenever the constituent set
  // changes so the index value is continuous across rebalances (composition shouldn't move it).
  const newSet = members.map((m) => m.cardId).sort().join(',');
  const oldRows = await db.query<{ card_id: string }>(`SELECT card_id FROM index_constituents WHERE market_id=$1`, [marketId]);
  const oldSet = oldRows.rows.map((r) => r.card_id).sort().join(',');
  const divRow = await db.query<{ d: string }>(
    `SELECT divisor_e6::text AS d FROM index_divisors WHERE market_id = $1`,
    [marketId],
  );
  // The divisor carries 6 fractional digits (the column is divisor_e6): value = rawE6 * SCALE / divisor.
  // Without the scale a sub-$1000 basket would truncate the divisor toward 0 and the index would jump.
  const anchorDivisor = (target: bigint) => {
    const d = (rawE6 * SCALE) / target; // solve  rawE6 * SCALE / d == target
    return d > 0n ? d : 1n; // floor only for the degenerate rawE6 == 0 basket
  };

  let divisor: bigint;
  if (!divRow.rows[0]) {
    divisor = anchorDivisor(BASE_VALUE_E6); // start the index at its base value (1000.000000)
    await db.query(
      `INSERT INTO index_divisors(market_id, divisor_e6, base_value_e6) VALUES($1, $2, $3)
       ON CONFLICT(market_id) DO NOTHING`,
      [marketId, divisor.toString(), BASE_VALUE_E6.toString()],
    );
  } else {
    divisor = BigInt(divRow.rows[0].d);
    const prevRow = await db.query<{ v: string }>(
      `SELECT index_price_e6::text AS v FROM oracle_prices WHERE market_id=$1 AND is_accepted ORDER BY source_observed_at DESC LIMIT 1`,
      [marketId],
    );
    const prevVal = prevRow.rows[0] ? BigInt(prevRow.rows[0].v) : 0n;
    // Re-anchor the divisor (keeping the print continuous) on a constituent-set change, and self-heal a
    // divisor persisted at the wrong scale: a legacy pre-SCALE row would compute a value ~1e6x off, a
    // jump REANCHOR_JUMP_FACTOR catches as impossible for a diversified basket.
    const candidateE6 = (rawE6 * SCALE) / divisor; // value if we kept the stored divisor
    const setChanged = oldSet !== '' && oldSet !== newSet;
    const wrongScale = candidateE6 > prevVal * REANCHOR_JUMP_FACTOR;
    if (prevVal > 0n && (setChanged || wrongScale)) {
      divisor = anchorDivisor(prevVal);
      await db.query(`UPDATE index_divisors SET divisor_e6=$1, as_of=now() WHERE market_id=$2`, [divisor.toString(), marketId]);
    }
  }
  const indexValueE6 = (rawE6 * SCALE) / divisor;

  // Snapshot constituents (transparency / future rebalancing).
  await db.tx(async (q) => {
    await q.query(`DELETE FROM index_constituents WHERE market_id = $1`, [marketId]);
    for (const m of members) {
      await q.query(
        `INSERT INTO index_constituents(id, market_id, card_id, weight_e6) VALUES($1, $2, $3, $4)`,
        [randomUUID(), marketId, m.cardId, m.priceE6.toString()],
      );
    }
  });

  const accepted = await db.tx((q) =>
    recordOracle(q, marketId, indexValueE6, observedAt, { kind: 'index', constituents: members.length }),
  );
  if (accepted) {
    const market = await getMarketById(db, marketId);
    if (market) await db.tx((q) => recomputeMark(q, market, indexValueE6, 0n, 0n));
  }
}
