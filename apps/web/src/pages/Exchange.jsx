import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import { Navbar } from '../components/Navbar';
import { SidebarMarkets } from '../components/SidebarMarkets';
import { TradingView } from '../components/TradingView';
import { OrderEntry } from '../components/OrderEntry';
import { BottomPanel } from '../components/BottomPanel';
import { MarketsView } from '../components/MarketsView';
import { Portfolio } from '../components/Portfolio';
import { PoolView } from '../components/PoolView';
import { GamesView } from '../components/GamesView';
import { Leaderboard } from '../components/Leaderboard';
import { AdminPanel } from '../components/AdminPanel';
import { ChatSidebar } from '../components/ChatSidebar';
import { MarketThumb } from '../components/MarketThumb';
import { Toasts } from '../components/Toasts';
import { useRealtime, liveMarkE6 } from '../store/realtime';
import { initialChatOpen, persistChatOpen } from '../store/chat';
import { useMediaQuery, MOBILE_QUERY } from '../lib/useMediaQuery.js';
import * as api from '../lib/api.js';

// Own component so the live-mark subscription re-renders this <span>, not the whole page.
function MktBarPrice({ market }) {
  const priceE6 = useRealtime((s) => liveMarkE6(s.marks, market));
  return <span className="mkt-bar-price">{priceE6 ? formatUsd(BigInt(priceE6)) : '—'}</span>;
}

export function Exchange() {
  const [markets, setMarkets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState('trade');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [gamesVisible, setGamesVisible] = useState(false); // Games nav + page stay hidden until GAMES_ENABLED (via /health)
  const isMobile = useMediaQuery(MOBILE_QUERY);
  // Mobile Trade screen: show the market PICKER (the default, and on re-tapping Trade) vs the selected
  // card's chart. Remembers the last card — leaving Trade and coming back restores it; tapping Trade while
  // already on Trade resets to the picker (see selectView).
  const [mobilePicker, setMobilePicker] = useState(true);
  const [chatOpen, setChatOpen] = useState(initialChatOpen);

  // Tab navigation: re-tapping Trade while already on it returns to the market picker; switching to Trade
  // from another view leaves mobilePicker as-is (restoring the last card). Drives the desktop nav + tab bar.
  const selectView = (id) => {
    if (id === 'trade' && activeView === 'trade') setMobilePicker(true);
    setActiveView(id);
  };

  const toggleChat = () =>
    setChatOpen((o) => {
      const next = !o;
      persistChatOpen(next);
      return next;
    });

  // Operator panel is reachable at #admin only (not in the public nav).
  useEffect(() => {
    const sync = () => { if (window.location.hash === '#admin') setActiveView('admin'); };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  // Games are hidden from customers (no nav tab, no page) until the operator flips GAMES_ENABLED on the
  // API — /health surfaces that flag. Default false, so a fresh deploy never exposes games.
  useEffect(() => {
    api.getHealth().then((h) => setGamesVisible(!!h.gamesEnabled)).catch(() => {});
  }, []);

  const loadMarkets = useCallback(async () => {
    try {
      const { markets: m } = await api.getMarkets();
      setMarkets(m);
      setSelectedId((cur) => cur ?? m.find((x) => x.kind === 'card' && x.markE6)?.id ?? m[0]?.id ?? null);
    } catch (e) {
      console.error('Failed to load markets', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMarkets();
    const t = setInterval(loadMarkets, 30_000);
    return () => clearInterval(t);
  }, [loadMarkets]);

  const selected = markets.find((m) => m.id === selectedId) || null;
  const onSelectMarket = (m) => setSelectedId(m.id);
  // Jump to a market from a bottom-panel row — by id (open positions) or symbol (history rows),
  // resolved against the loaded markets list.
  const goToMarket = (idOrSymbol) => {
    const m = markets.find((x) => x.id === idOrSymbol || x.symbol === idOrSymbol);
    if (m) setSelectedId(m.id);
  };
  // A just-listed catalog card: refresh the markets list, then jump to the new market.
  const onMarketListed = useCallback(async (marketId) => {
    await loadMarkets();
    setSelectedId(marketId);
  }, [loadMarkets]);
  const handleTradeMarket = (m) => {
    setSelectedId(m.id);
    setMobilePicker(false); // jump straight to the chosen card's chart, not the picker
    setActiveView('trade');
  };

  return (
    <>
      <div className="skin-cardback" aria-hidden="true"><span className="skin-emblem" /></div>
      <div className={`app-container ${chatOpen ? 'chat-open' : ''}`}>
      <ChatSidebar open={chatOpen} onToggle={toggleChat} />
      <Navbar activeView={activeView} setActiveView={selectView} chatOpen={chatOpen} onToggleChat={toggleChat} gamesVisible={gamesVisible} />

      {activeView === 'trade' && !isMobile && (
        <div className={`main-grid ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          <SidebarMarkets
            markets={markets}
            loading={loading}
            selected={selected}
            onSelect={onSelectMarket}
            onListed={onMarketListed}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
          />
          <TradingView market={selected} onGoToMarket={goToMarket} />
          <OrderEntry market={selected} onTraded={loadMarkets} />
        </div>
      )}

      {activeView === 'trade' && isMobile && (
        <div className="trade-mobile">
          {mobilePicker || !selected ? (
            // default + re-tap: the inline market picker — flows above the bottom tab bar, never covers it
            <div className="mobile-market-picker">
              <SidebarMarkets
                markets={markets}
                loading={loading}
                selected={selected}
                onSelect={(m) => { onSelectMarket(m); setMobilePicker(false); }}
                onListed={async (id) => { await onMarketListed(id); setMobilePicker(false); }}
                collapsed={false}
                setCollapsed={() => {}}
              />
            </div>
          ) : (
            <>
              {/* current market — tap to return to the picker */}
              <button className="mkt-bar" onClick={() => setMobilePicker(true)}>
                <MarketThumb market={selected} className="mkt-bar-thumb" />
                <span className="mkt-bar-name">{selected?.displayName ?? 'Select a market'}</span>
                {selected && <MktBarPrice market={selected} />}
                <span className="mkt-bar-caret">▾</span>
              </button>
              <TradingView market={selected} mobile />
              <OrderEntry market={selected} onTraded={loadMarkets} />
              <BottomPanel market={selected} onGoToMarket={goToMarket} />
            </>
          )}
        </div>
      )}

      {activeView === 'markets' && <MarketsView markets={markets} loading={loading} onTradeMarket={handleTradeMarket} />}
      {activeView === 'portfolio' && <Portfolio markets={markets} onSelect={handleTradeMarket} />}
      {activeView === 'pool' && <PoolView />}
      {activeView === 'games' && gamesVisible && <GamesView onTradeMarket={handleTradeMarket} />}
      {activeView === 'leaderboard' && <Leaderboard />}
      {activeView === 'admin' && <AdminPanel onGoToMarket={(id) => handleTradeMarket({ id })} />}

      <Toasts />
      </div>
    </>
  );
}
