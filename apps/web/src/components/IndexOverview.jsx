import { useState, useMemo, useEffect, Fragment } from 'react';
import { formatUsd } from '@pokex/pricing';
import { indexSeries, INDEX_SERIES_LABELS } from '@pokex/shared-types';
import { useRealtime, liveMarkE6 } from '../store/realtime';
import * as api from '../lib/api.js';

// The Markets "Indices" sub-tab: a financial-style overview of every index. Top-level sections are the GAMES
// (Pokémon → One Piece → Magic), each enclosed in its own panel; within a panel, rows are grouped by series
// (GJ / G&P / Pokedaq). Per index: price, 1D/1W/1M/YTD change, 52-week low & high, and View → Exchange.
// Price + 1D come live from the markets feed; the slower windows come from /markets/index-overview.

const GAME_ORDER = ['pokemon', 'onepiece', 'mtg'];
const GAME_META = {
  pokemon: { label: 'Pokémon', color: '#f0c040' },
  onepiece: { label: 'One Piece', color: '#d4202a' },
  mtg: { label: 'Magic', color: '#7c5cff' },
};
const SERIES_ORDER = Object.fromEntries(Object.keys(INDEX_SERIES_LABELS).map((k, i) => [k, i]));

const fmtE6 = (e6) => (e6 ? formatUsd(BigInt(e6)) : '—');

// live price cell — its own component so the live-mark subscription re-renders just this <td>
function PriceCell({ market }) {
  const priceE6 = useRealtime((s) => liveMarkE6(s.marks, market));
  return <>{priceE6 ? formatUsd(BigInt(priceE6)) : '—'}</>;
}

// a % change cell: plain colored text + a directional caret (no per-row pills); null → muted dash
function ChangeCell({ pct }) {
  if (pct == null) return <td className="num io-delta muted">—</td>;
  const up = pct >= 0;
  return (
    <td className={`num io-delta ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
    </td>
  );
}

export function IndexOverview({ markets, loading, onTradeMarket }) {
  const [stats, setStats] = useState({}); // marketId -> { change1wPct, change1mPct, changeYtdPct, high52wE6, low52wE6 }

  // the slower windows (1w/1m/ytd/52w) are computed server-side; poll while this sub-tab is mounted
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

  // group indices by game (Pokémon → One Piece → Magic), each game's rows sorted by series then tradeable
  const sections = useMemo(() => {
    const groups = {};
    for (const m of (markets || []).filter((m) => m.kind === 'index')) (groups[m.game] ??= []).push(m);
    for (const list of Object.values(groups)) {
      list.sort((a, b) => {
        const d = (SERIES_ORDER[indexSeries(a.indexSlug)] ?? 9) - (SERIES_ORDER[indexSeries(b.indexSlug)] ?? 9);
        if (d !== 0) return d;
        if (a.tradeable !== b.tradeable) return a.tradeable ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
      });
    }
    // known games in order, then any others, keeping only games that actually have indices
    const order = [...GAME_ORDER, ...Object.keys(groups).filter((g) => !GAME_ORDER.includes(g))];
    return order.filter((g) => groups[g]?.length).map((g) => [g, groups[g]]);
  }, [markets]);

  if (loading && sections.length === 0) return <div className="empty-state">Loading indices…</div>;
  if (sections.length === 0) return <div className="empty-state">No indices yet.</div>;

  return (
    <div className="index-overview">
      <p className="io-blurb">
        The card-market indices across three methodologies — <strong>GJ</strong> (price-weighted),{' '}
        <strong>G&amp;P</strong> (equal-weight) and <strong>Pokedaq</strong> (capped price-weight). Click a row to
        trade it. <span className="muted">YTD &amp; 52W are measured over each index's available history.</span>
      </p>

      {sections.map(([game, list]) => {
        const meta = GAME_META[game] || { label: game, color: 'var(--accent)' };
        return (
          <section className="io-section" key={game} style={{ '--game-color': meta.color }}>
            <header className="io-section-head">
              <span className="io-section-dot" />
              <h3>{meta.label}</h3>
              <span className="io-section-count">
                {list.length} {list.length === 1 ? 'index' : 'indices'}
              </span>
            </header>
            <div className="io-scroll">
              <table className="io-table">
                <thead>
                  <tr>
                    <th className="label">Index</th>
                    <th className="num">Price</th>
                    <th className="num">1D</th>
                    <th className="num">1W</th>
                    <th className="num">1M</th>
                    <th className="num">YTD*</th>
                    <th className="num">52W Low</th>
                    <th className="num">52W High</th>
                    <th className="io-action" aria-label="Trade" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((m, i) => {
                    const s = stats[m.id] || {};
                    const series = indexSeries(m.indexSlug);
                    const head = i === 0 || indexSeries(list[i - 1].indexSlug) !== series;
                    return (
                      <Fragment key={m.id}>
                        {head && (
                          <tr className="io-subhead">
                            <td colSpan={9}>{INDEX_SERIES_LABELS[series] ?? '—'}</td>
                          </tr>
                        )}
                        <tr className={`io-row ${m.tradeable ? '' : 'io-row-soon'}`} onClick={() => m.tradeable && onTradeMarket(m)}>
                          <td className="io-name">
                            {m.displayName}
                            {!m.tradeable && <span className="io-soon">soon</span>}
                          </td>
                          <td className="num io-price">
                            <PriceCell market={m} />
                          </td>
                          <ChangeCell pct={m.change24hPct} />
                          <ChangeCell pct={s.change1wPct} />
                          <ChangeCell pct={s.change1mPct} />
                          <ChangeCell pct={s.changeYtdPct} />
                          <td className="num io-range">{fmtE6(s.low52wE6)}</td>
                          <td className="num io-range">{fmtE6(s.high52wE6)}</td>
                          <td className="num io-action">
                            {m.tradeable ? <span className="io-cta">View →</span> : <span className="muted">—</span>}
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
