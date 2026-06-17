import { config } from '../../config.ts';

/**
 * FX rates for pricing non-USD provider quotes (decision #3: JP printings report JPY; convert to USD).
 * Source is Frankfurter (free, no key; ECB reference rates) — `GET {FX_BASE}/v1/latest?base=JPY&symbols=USD`
 * returns `{ amount, base, date, rates: { USD } }` where `rates.USD` is USD per 1 JPY. Rates move slowly,
 * so we cache process-wide for FX_TTL_MS and serve the last good rate if a refresh fails (never block a
 * pricing pass on the FX endpoint). A null result means "no rate" — the caller HALTS a JPY card rather
 * than mis-pricing a yen number as dollars.
 */

const FX_TTL_MS = 12 * 60 * 60 * 1000; // refresh twice a day — ECB publishes once/business-day

let cache: { rate: number; at: number } | null = null;

/** USD per 1 JPY, or null when no rate is available (fetch failed AND nothing cached). Injectable
 *  fetch/clock for tests. Caches the last good rate and reuses it past a failed refresh. */
export async function getJpyUsd(opts: { fetchFn?: typeof fetch; now?: () => number } = {}): Promise<number | null> {
  const now = opts.now ?? Date.now;
  if (cache && now() - cache.at < FX_TTL_MS) return cache.rate;
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`${config.fxBase}/v1/latest?base=JPY&symbols=USD`);
    if (!res.ok) return cache?.rate ?? null; // a stale-but-real rate beats nothing; null only if we never had one
    const json = (await res.json()) as { rates?: { USD?: unknown } };
    const rate = Number(json?.rates?.USD);
    if (Number.isFinite(rate) && rate > 0) {
      cache = { rate, at: now() };
      return rate;
    }
  } catch {
    // network error — fall through to the cached rate (or null)
  }
  return cache?.rate ?? null;
}

/** Test-only: drop the cached rate so each test starts cold. */
export function resetFxCache(): void {
  cache = null;
}
