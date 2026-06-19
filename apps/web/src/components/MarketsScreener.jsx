import { useState, useMemo } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useRealtime, liveMarkE6 } from '../store/realtime';

// Dedicated "Markets" screener (the filters/Option-C page): a sortable table of every card market with
// top-mover tabs (Top/Volume/Gainers/Losers), a game filter, a rarity filter, and search. Sorting keys
// off the 30s REST snapshot (markE6 / volume24hUsd / change24hPct) so the order doesn't thrash on every
// live tick; the price cell subscribes to the live mark so only it re-renders. Row click → trade view.

const GAMES = [
  { id: 'all', label: 'All' },
  { id: 'pokemon', label: 'Pokémon' },
  { id: 'onepiece', label: 'One Piece' },
  { id: 'mtg', label: 'Magic' },
];
const SORTS = [
  { id: 'top', label: 'Top' },
  { id: 'volume', label: 'Volume' },
  { id: 'gainers', label: 'Gainers' },
  { id: 'losers', label: 'Losers' },
];

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

  const cards = useMemo(() => (markets || []).filter((m) => m.kind === 'card'), [markets]);
  const rarities = useMemo(() => [...new Set(cards.map((c) => c.rarity).filter(Boolean))].sort(), [cards]);

  const rows = useMemo(() => {
    let r = cards;
    if (game !== 'all') r = r.filter((c) => c.game === game);
    if (rarity !== 'all') r = r.filter((c) => c.rarity === rarity);
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((c) => c.displayName.toLowerCase().includes(q));
    const by = {
      top: (a, b) => Number(b.markE6 ?? 0) - Number(a.markE6 ?? 0),
      volume: (a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0),
      gainers: (a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0),
      losers: (a, b) => (a.change24hPct ?? 0) - (b.change24hPct ?? 0),
    };
    return [...r].sort(by[sort]);
  }, [cards, game, rarity, search, sort]);

  return (
    <div className="screener">
      <div className="screener-bar">
        <div className="screener-games">
          {GAMES.map((g) => (
            <button key={g.id} className={`game-tab-btn ${game === g.id ? 'active' : ''}`} onClick={() => setGame(g.id)}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="screener-sorts">
          {SORTS.map((s) => (
            <button key={s.id} className={`sidebar-tab-btn ${sort === s.id ? 'active' : ''}`} onClick={() => setSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="screener-spacer" />
        <select className="screener-select" value={rarity} onChange={(e) => setRarity(e.target.value)}>
          <option value="all">Rarity: All</option>
          {rarities.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <input className="screener-search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
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
