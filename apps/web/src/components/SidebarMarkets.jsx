import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useRealtime, liveMarkE6 } from '../store/realtime';
import { useAuth } from '../auth/AuthContext';
import * as api from '../lib/api.js';

const TABS = ['indices', 'cards'];

// Game filter (icon-only identity dots). Fixed brand colours, independent of the skin:
// gold = Pokémon, red = One Piece, violet = Magic.
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

/** One whole-catalog search result: trade it if a market exists, list it on demand if it qualifies. */
function CatalogRow({ r, existing, user, onSelect, onListed }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const list = async () => {
    setErr(null);
    setBusy(true);
    try {
      const { marketId } = await api.ensureMarket(r.providerCardId);
      await onListed(marketId);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`market-item catalog-item ${existing ? '' : 'market-item-static'}`} onClick={() => existing && onSelect(existing)}>
      <div className="market-item-left">
        {r.imageSmall ? <img src={r.imageSmall} alt="" className="market-thumb" /> : <span className="market-thumb idx-thumb">?</span>}
        <div className="market-item-info">
          <span className="market-item-name">{r.name}{r.number ? ` #${r.number}` : ''}</span>
          <span className="market-item-set">{r.setName ?? ''}</span>
          {err && <span className="catalog-err">{err}</span>}
        </div>
      </div>
      <div className="market-item-right">
        <span className="market-item-price">{r.priceUsd > 0 ? `$${r.priceUsd.toFixed(2)}` : '—'}</span>
        {existing ? (
          <span className="catalog-state up">TRADE ▸</span>
        ) : r.listable ? (
          user
            ? <button className="list-btn" disabled={busy} onClick={(e) => { e.stopPropagation(); list(); }}>{busy ? '…' : 'LIST'}</button>
            : <span className="catalog-state">sign in</span>
        ) : (
          <span className="catalog-state" title="Needs a $10+ TCGplayer price corroborated by eBay sales">not listable</span>
        )}
      </div>
    </div>
  );
}

export function SidebarMarkets({ markets, loading, selected, onSelect, onListed, collapsed, setCollapsed }) {
  const [tab, setTab] = useState('cards');
  const [game, setGame] = useState('pokemon');
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState(null); // null = inactive; [] = no results
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState(false); // search failed/unavailable (≠ zero matches)
  const marks = useRealtime((s) => s.marks);
  const { user } = useAuth();

  const activeGame = GAMES.find((g) => g.id === game) ?? GAMES[0];
  const livePrice = (m) => liveMarkE6(marks, m);
  const inGame = (m) => (m.game ?? 'pokemon') === game;
  const q = search.trim();

  // Whole-catalog search (cards only): debounced so typing doesn't spray provider requests.
  useEffect(() => {
    if (tab !== 'cards' || q.length < 2) {
      setCatalog(null);
      setCatalogError(false);
      setCatalogLoading(false);
      return;
    }
    setCatalogLoading(true);
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const { results } = await api.searchCatalog(q, game);
        if (alive) {
          setCatalog(results);
          setCatalogError(false);
        }
      } catch {
        // the endpoint is unavailable (catalogue search off) or errored — NOT "zero matches", so
        // don't render it as "· 0". Surface an explicit unavailable state instead.
        if (alive) {
          setCatalog(null);
          setCatalogError(true);
        }
      } finally {
        if (alive) setCatalogLoading(false);
      }
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, game, tab]);

  // Default card list = the featured top-250, highest price first. A search widens to every locally
  // tracked market (long-tail listings included) and adds the whole-catalog section below. Sorted by
  // the REST snapshot price (not live marks) so rows don't reshuffle under the cursor on every tick.
  const list = useMemo(() => {
    const mine = markets.filter((m) => m.kind === (tab === 'indices' ? 'index' : 'card') && inGame(m));
    if (tab === 'indices') {
      return mine
        .filter((m) => m.displayName.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => Number(b.tradeable) - Number(a.tradeable));
    }
    // Default (no search) = the featured top-250. Fall back to ALL cards when nothing is featured —
    // an API build that predates the `featured` field (deploy race / rollback) or a transient data
    // gap must never collapse the list into an empty "coming soon".
    const featured = mine.filter((m) => m.featured);
    const base = q ? mine : featured.length ? featured : mine;
    return base
      .filter((m) => m.displayName.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => Number(b.markE6 ?? 0) - Number(a.markE6 ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, tab, game, q]);

  // Catalog rows whose market is already shown above are noise — keep only new/unlisted cards
  // (and variant twins whose canonical market didn't match the local name filter).
  const shownIds = useMemo(() => new Set(list.map((m) => m.id)), [list]);
  const catalogRows = catalog?.filter((r) => !r.marketId || !shownIds.has(r.marketId));
  const marketById = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);

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
        <input
          type="text"
          placeholder={tab === 'cards' ? 'Search all cards...' : 'Search...'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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

        {/* with an active cards-tab search the catalog section owns all empty messaging */}
        {!loading && list.length === 0 && (tab === 'indices' || !q) && (
          <div className="market-empty">
            <span className="gdot" style={{ '--dot': activeGame.color }} />
            {q ? 'No matches' : `${activeGame.label} ${tab === 'indices' ? 'indices' : 'markets'} coming soon`}
            {!q && <small>Pricing integration in progress.</small>}
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

        {tab === 'cards' && q.length >= 2 && (
          <>
            <div className="catalog-divider">
              <span className="gdot" style={{ '--dot': activeGame.color }} />
              CATALOG{catalogLoading ? ' · searching…' : catalogError ? ' · unavailable' : catalogRows ? ` · ${catalogRows.length}` : ''}
            </div>
            {catalogRows?.map((r) => (
              <CatalogRow
                key={r.providerCardId}
                r={r}
                existing={r.marketId ? marketById.get(r.marketId) ?? null : null}
                user={user}
                onSelect={onSelect}
                onListed={onListed}
              />
            ))}
            {catalogError && !catalogLoading && (
              <div className="market-empty"><small>Catalogue search is unavailable right now.</small></div>
            )}
            {catalogRows && catalogRows.length === 0 && !catalogLoading && (
              <div className="market-empty"><small>Nothing new in the {activeGame.label} catalog for “{q}”.</small></div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
