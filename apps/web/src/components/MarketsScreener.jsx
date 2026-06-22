import { useState, useMemo, useEffect } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useRealtime, liveMarkE6 } from '../store/realtime';
import { useStickyState } from '../lib/useStickyState';

// Dedicated "Markets" screener (the filters/Option-C page): a sortable table of every card market with
// top-mover tabs (Top/Volume/Gainers/Losers), a game filter, a rarity filter, and search. Sorting keys
// off the 30s REST snapshot (markE6 / volume24hUsd / change24hPct) so the order doesn't thrash on every
// live tick; the price cell subscribes to the live mark so only it re-renders. Row click → trade view.

// Fixed brand dot colours, matching SidebarMarkets' game tabs (gold/red/violet); 'All' = neutral.
const GAMES = [
  { id: 'all', label: 'All', color: '#8b949e' },
  { id: 'pokemon', label: 'Pokémon', color: '#f0c040' },
  { id: 'onepiece', label: 'One Piece', color: '#d4202a' },
  { id: 'mtg', label: 'Magic', color: '#7c5cff' },
];
const SORTS = [
  { id: 'top', label: 'Top' },
  { id: 'volume', label: 'Volume' },
  { id: 'gainers', label: 'Gainers' },
  { id: 'losers', label: 'Losers' },
];
// Top-mover sort comparators, keyed off the REST snapshot (same set as SidebarMarkets' CARD_SORTS).
const CARD_SORTS = {
  top: (a, b) => Number(b.markE6 ?? 0) - Number(a.markE6 ?? 0),
  volume: (a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0),
  gainers: (a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0),
  losers: (a, b) => (a.change24hPct ?? 0) - (b.change24hPct ?? 0),
};

// Live price cell — its own component so the live-mark subscription re-renders just this <td>.
function PriceCell({ market }) {
  const priceE6 = useRealtime((s) => liveMarkE6(s.marks, market));
  return <>{priceE6 ? formatUsd(BigInt(priceE6)) : '—'}</>;
}

function fmtVol(usd) {
  if (!usd || usd <= 0) return '—';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}

export function MarketsScreener({ markets, loading, onTradeMarket }) {
  const [game, setGame] = useState('all');
  const [sort, setSort] = useState('top');
  const [rarity, setRarity] = useState('all');
  const [search, setSearch] = useState('');
  const [showJpy, setShowJpy] = useStickyState('pokeX_showJpy', false); // persists across refresh (shared key with the sidebar toggle)

  const cards = useMemo(() => (markets || []).filter((m) => m.kind === 'card'), [markets]);
  // The game + JPY filters bound which rarities can appear, so derive the dropdown options from THAT
  // view (not the whole card list) — otherwise it offers rarities that only exist on hidden cards and
  // yield an empty table.
  const scoped = useMemo(() => {
    let r = cards;
    if (!showJpy) r = r.filter((c) => !c.jpy);
    if (game !== 'all') r = r.filter((c) => c.game === game);
    return r;
  }, [cards, showJpy, game]);
  const rarities = useMemo(() => [...new Set(scoped.map((c) => c.rarity).filter(Boolean))].sort(), [scoped]);
  // If the selected rarity leaves the current view (game/JPY changed), fall back to All rather than
  // silently showing zero rows against an option the dropdown no longer lists.
  useEffect(() => {
    if (rarity !== 'all' && !rarities.includes(rarity)) setRarity('all');
  }, [rarities, rarity]);

  const rows = useMemo(() => {
    let r = scoped;
    if (rarity !== 'all') r = r.filter((c) => c.rarity === rarity);
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((c) => c.displayName.toLowerCase().includes(q));
    return [...r].sort(CARD_SORTS[sort] ?? CARD_SORTS.top);
  }, [scoped, rarity, search, sort]);

  return (
    <div className="screener">
      <div className="screener-bar">
        <div className="screener-games" role="tablist" aria-label="Game">
          {GAMES.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={game === g.id}
              className={`game-tab-btn ${game === g.id ? 'on' : ''}`}
              style={{ '--dot': g.color }}
              onClick={() => setGame(g.id)}
            >
              <span className="gdot" />{g.label}
            </button>
          ))}
        </div>
        <div className="screener-sorts" role="tablist" aria-label="Sort">
          {SORTS.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={sort === s.id}
              className={`sidebar-tab-btn ${sort === s.id ? 'active' : ''}`}
              onClick={() => setSort(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="screener-right">
          <select className="screener-select" value={rarity} onChange={(e) => setRarity(e.target.value)}>
            <option value="all">Rarity: All</option>
            {rarities.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button className={`screener-jpy ${showJpy ? 'on' : ''}`} onClick={() => setShowJpy((v) => !v)} aria-pressed={showJpy} title="Show Japanese-market cards">
            JPY {showJpy ? 'ON' : 'OFF'}
          </button>
          <input className="screener-search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <div className="screener-empty">Loading markets…</div>
      ) : (
        <div className="screener-table-wrap">
          <table className="screener-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>CARD</th>
                <th className={`num ${sort === 'top' ? 'sorted' : ''}`}>PRICE</th>
                <th className={`num ${sort === 'gainers' || sort === 'losers' ? 'sorted' : ''}`}>24H %</th>
                <th className={`num ${sort === 'volume' ? 'sorted' : ''}`}>VOLUME</th>
                <th>RARITY</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => {
                const ch = m.change24hPct ?? 0;
                const up = ch >= 0;
                return (
                  <tr key={m.id} className="screener-row" onClick={() => onTradeMarket(m)}>
                    <td className="num">{i + 1}</td>
                    <td>
                      <div className="screener-card">
                        {m.imageSmall ? <img src={m.imageSmall} alt="" className="screener-thumb" /> : <span className="screener-thumb" />}
                        <span className="screener-name">{m.displayName}</span>
                      </div>
                    </td>
                    <td className="num"><PriceCell market={m} /></td>
                    <td className={`num ${up ? 'up' : 'down'}`}>{up ? '+' : ''}{ch.toFixed(2)}%</td>
                    <td className="num">{fmtVol(m.volume24hUsd)}</td>
                    <td><span className="screener-badge">{m.rarity || '—'}</span></td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="screener-empty">No markets match these filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
