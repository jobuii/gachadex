import { useState } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useRealtime, liveMarkE6 } from '../store/realtime';

const TABS = ['indices', 'cards'];

// Game filter (icon-only identity dots). Fixed brand colours, independent of the skin:
// gold = Pokémon, red = One Piece, violet = Magic. Markets without a `game` (the current
// Pokémon-only backend) read as 'pokemon'; One Piece / MTG stay empty until the data lands.
const GAMES = [
  { id: 'pokemon', label: 'Pokémon', color: '#f0c040' },
  { id: 'onepiece', label: 'One Piece', color: '#d4202a' },
  { id: 'mtg', label: 'Magic', color: '#7c5cff' },
];

// Subtitle under a market row: a card shows its set logo (falling back to its symbol), an index
// shows its leverage or a "soon" badge when it isn't tradeable yet.
function marketSubtitle(m) {
  if (m.kind === 'card') {
    return m.setLogo
      ? <img src={m.setLogo} alt="" className="set-logo" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      : m.symbol;
  }
  return m.tradeable ? `Index · ${m.maxLeverage}x` : 'Soon';
}

export function SidebarMarkets({ markets, loading, selected, onSelect, collapsed, setCollapsed }) {
  const [tab, setTab] = useState('cards');
  const [game, setGame] = useState('pokemon');
  const [search, setSearch] = useState('');
  const marks = useRealtime((s) => s.marks);

  const activeGame = GAMES.find((g) => g.id === game) ?? GAMES[0];
  const livePrice = (m) => liveMarkE6(marks, m);
  // the dot switcher scopes both tabs; treat untagged markets as Pokémon (backend is Pokémon-only for now)
  const inGame = (m) => (m.game ?? 'pokemon') === game;
  const cards = markets.filter((m) => m.kind === 'card' && inGame(m));
  const indices = markets.filter((m) => m.kind === 'index' && inGame(m));
  const list = (tab === 'indices' ? indices : cards)
    .filter((m) => m.displayName.toLowerCase().includes(search.toLowerCase()))
    // tradeable markets first, so the gated "Soon" indices sink below the live ones (stable otherwise)
    .sort((a, b) => Number(b.tradeable) - Number(a.tradeable));

  return (
    <div className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <span>Markets</span>
        <button className="collapse-btn" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? '▶' : '◀'}
        </button>
      </div>

      <div className="game-tabs" role="tablist" aria-label="Game">
        {GAMES.map((g) => (
          <button
            key={g.id}
            role="tab"
            aria-selected={game === g.id}
            className={`game-tab-btn ${game === g.id ? 'on' : ''}`}
            style={{ '--dot': g.color }}
            onClick={() => setGame(g.id)}
          >
            <span className="gdot" />
            {g.label}
          </button>
        ))}
      </div>

      <div className="sidebar-tabs">
        {TABS.map((t) => (
          <button key={t} className={`sidebar-tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="sidebar-search">
        <input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="sidebar-col-headers">
        <span>#</span>
        <span>{tab === 'indices' ? 'INDEX' : 'CARD'}</span>
        <span>PRICE</span>
      </div>

      <div className="market-list">
        {loading && (
          <div className="loading-pixel" style={{ padding: '2rem' }}>
            <span /><span /><span />
          </div>
        )}

        {!loading && list.length === 0 && (
          <div className="market-empty">
            <span className="gdot" style={{ '--dot': activeGame.color }} />
            {activeGame.label} {tab === 'indices' ? 'indices' : 'markets'} coming soon
            <small>Pricing integration in progress.</small>
          </div>
        )}

        {list.map((m, i) => {
          const ch = m.change24hPct || 0;
          const up = ch >= 0;
          const price = livePrice(m);
          return (
            <div
              key={m.id}
              className={`market-item ${selected?.id === m.id ? 'selected' : ''} ${m.tradeable ? '' : 'market-item-disabled'}`}
              onClick={() => onSelect(m)}
              title={m.tradeable ? '' : 'Data source pending'}
            >
              <div className="market-item-left">
                <span className="market-index">{i + 1}.</span>
                {m.imageSmall ? <img src={m.imageSmall} alt="" className="market-thumb" /> : <span className="market-thumb idx-thumb">IDX</span>}
                <div className="market-item-info">
                  <span className="market-item-name">{m.displayName}</span>
                  <span className="market-item-set">{marketSubtitle(m)}</span>
                </div>
              </div>
              <div className="market-item-right">
                <span className="market-item-price">{price ? formatUsd(BigInt(price)) : '—'}</span>
                <span className={`market-item-change ${up ? 'up' : 'down'}`}>
                  {up ? '▲' : '▼'} {Math.abs(ch).toFixed(2)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
