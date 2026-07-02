import { useMemo } from 'react';
import { formatUsd } from '@pokex/pricing';

const TOP_N = 16;

/**
 * Running ticker tape of the biggest 24h card-price movers — shown below the navbar on the Trade view.
 * Reads the markets snapshot the Exchange already polls (markE6 / change24hPct); takes the cards with the
 * largest absolute 24h move (gainers AND losers). The set is duplicated and the track translates -50% for a
 * seamless loop; each item is clickable to trade that card. Hover / prefers-reduced-motion pause the scroll.
 */
export function MarketTicker({ markets, onTrade }) {
  const movers = useMemo(() => (
    (markets ?? [])
      .filter((m) => m.kind === 'card' && m.markE6 && m.change24hPct != null && m.change24hPct !== 0)
      .sort((a, b) => Math.abs(b.change24hPct) - Math.abs(a.change24hPct))
      .slice(0, TOP_N)
  ), [markets]);

  if (movers.length === 0) return null;

  const duration = `${Math.max(24, movers.length * 4)}s`; // ~4s/item → constant scroll speed regardless of count
  const loop = [...movers, ...movers];                    // duplicate the set for a seamless -50% loop

  return (
    <div className="mkt-ticker" aria-label="Biggest 24-hour card movers">
      <div className="mkt-ticker-track" style={{ animationDuration: duration }}>
        {loop.map((m, i) => {
          const real = i < movers.length; // only the first set is interactive/announced; the dup is decorative
          const up = m.change24hPct >= 0;
          return (
            <button
              key={`${m.id}-${i}`}
              type="button"
              className="mkt-tick"
              onClick={() => onTrade?.(m)}
              tabIndex={real ? 0 : -1}
              aria-hidden={real ? undefined : 'true'}
              title={`Trade ${m.displayName}`}
            >
              <span className="mkt-tick-nm">{m.displayName}</span>
              <span className="mkt-tick-pr">{formatUsd(BigInt(m.markE6), { compact: true, decimals: 0 })}</span>
              <span className={`mkt-tick-ch ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(m.change24hPct).toFixed(1)}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
