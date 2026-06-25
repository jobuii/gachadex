import { useState, useMemo, useEffect, Fragment } from 'react';
import { formatUsd } from '@pokex/pricing';
import { indexSeries, INDEX_SERIES_LABELS } from '@pokex/shared-types';
import { useRealtime, liveMarkE6 } from '../store/realtime';
import * as api from '../lib/api.js';

// The Markets "Indices" sub-tab: a financial-style overview of every index — current price, 1D/1W/1M/YTD
// change, and the 52-week low/high — grouped by series (GJ / G&P / Pokedaq). Price + 1D come live from the
// markets feed; the slower windows come from /markets/index-overview (refreshed on a timer). View → Exchange.

// series display order (GJ → G&P → Pokedaq), derived from the shared labels so it can't drift from them
const SERIES_ORDER = Object.fromEntries(Object.keys(INDEX_SERIES_LABELS).map((k, i) => [k, i]));

// live price cell — its own component so the live-mark subscription re-renders just this <td>
function PriceCell({ market }) {
  const priceE6 = useRealtime((s) => liveMarkE6(s.marks, market));
  return <>{priceE6 ? formatUsd(BigInt(priceE6)) : '—'}</>;
}

// a signed % change cell with up/down colour; null (not enough history) → "—"
function ChangeCell({ pct }) {
  if (pct == null) return <td className="num muted">—</td>;
  const up = pct >= 0;
  return (
    <td className={`num ${up ? 'up' : 'down'}`}>
      {up ? '+' : ''}
      {pct.toFixed(2)}%
    </td>
  );
}

export function IndexOverview({ markets, loading, onTradeMarket }) {
  const [stats, setStats] = useState({}); // marketId -> { change1wPct, change1mPct, changeYtdPct, high52wE6, low52wE6 }

  // the slower windows (1w/1m/ytd/52w) are computed server-side; poll them while this sub-tab is mounted
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getIndexOverview()
        .then((r) => alive && setStats(Object.fromEntries((r.indices || []).map((s) => [s.marketId, s]))))
        .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // index markets, grouped by series (GJ -> G&P -> Pokedaq), tradeable first within each
  const indices = useMemo(() => {
    const list = (markets || []).filter((m) => m.kind === 'index');
    return [...list].sort((a, b) => {
      const d = (SERIES_ORDER[indexSeries(a.indexSlug)] ?? 9) - (SERIES_ORDER[indexSeries(b.indexSlug)] ?? 9);
      if (d !== 0) return d;
      if (a.tradeable !== b.tradeable) return a.tradeable ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [markets]);

  if (loading && indices.length === 0) return <div className="empty-state">Loading indices…</div>;
  if (indices.length === 0) return <div className="empty-state">No indices yet.</div>;

  return (
    <div className="index-overview">
      <p className="io-blurb">
        The card-market indices across three methodologies — <strong>GJ</strong> (price-weighted),{' '}
        <strong>G&amp;P</strong> (equal-weight) and <strong>Pokedaq</strong> (capped price-weight). Hit{' '}
        <strong>View</strong> to trade one. <span className="muted">YTD &amp; 52W are over each index's available history.</span>
      </p>
      <div className="io-scroll">
        <table className="io-table">
          <thead>
            <tr>
              <th>Index</th>
              <th className="num">Price</th>
              <th className="num">1D</th>
              <th className="num">1W</th>
              <th className="num">1M</th>
              <th className="num">YTD*</th>
              <th className="num">52W Low / High</th>
              <th aria-label="Trade" />
            </tr>
          </thead>
          <tbody>
            {indices.map((m, i) => {
              const s = stats[m.id] || {};
              const series = indexSeries(m.indexSlug);
              const head = i === 0 || indexSeries(indices[i - 1].indexSlug) !== series;
              return (
                <Fragment key={m.id}>
                  {head && (
                    <tr className="io-series">
                      <td colSpan={8}>{INDEX_SERIES_LABELS[series] ?? '—'}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="io-name">
                      {m.displayName}
                      {!m.tradeable && <span className="io-soon">soon</span>}
                    </td>
                    <td className="num">
                      <PriceCell market={m} />
                    </td>
                    <ChangeCell pct={m.change24hPct} />
                    <ChangeCell pct={s.change1wPct} />
                    <ChangeCell pct={s.change1mPct} />
                    <ChangeCell pct={s.changeYtdPct} />
                    <td className="num io-range">
                      {s.low52wE6 ? formatUsd(BigInt(s.low52wE6)) : '—'} / {s.high52wE6 ? formatUsd(BigInt(s.high52wE6)) : '—'}
                    </td>
                    <td className="num">
                      {m.tradeable ? (
                        <button className="btn-primary sm" onClick={() => onTradeMarket(m)}>
                          View
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
