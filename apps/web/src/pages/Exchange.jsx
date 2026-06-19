import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import { Navbar } from '../components/Navbar';
import { SidebarMarkets } from '../components/SidebarMarkets';
import { TradingView } from '../components/TradingView';
import { OrderEntry } from '../components/OrderEntry';
import { BottomPanel } from '../components/BottomPanel';
import { MarketsScreener } from '../components/MarketsScreener';
import { Portfolio } from '../components/Portfolio';
import { PoolView } from '../components/PoolView';
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
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [marketsOpen, setMarketsOpen] = useState(false);
  // the list stays mounted through the slide-out animation, then unmounts (it subscribes to
  // live marks, so it must not stay mounted while the drawer idles closed)
  const [marketsMounted, setMarketsMounted] = useState(false);
  const openMarkets = () => { setMarketsMounted(true); setMarketsOpen(true); };
  const [chatOpen, setChatOpen] = useState(initialChatOpen);

  // leaving mobile unmounts the drawer; clear its state so it can't reappear open on re-entry
  useEffect(() => {
    if (!isMobile) {
      setMarketsOpen(false);
      setMarketsMounted(false);
    }
  }, [isMobile]);

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
  // A just-listed catalog card: refresh the markets list, then jump to the new market.
  const onMarketListed = useCallback(async (marketId) => {
    await loadMarkets();
    setSelectedId(marketId);
  }, [loadMarkets]);
  const handleTradeMarket = (m) => {
    setSelectedId(m.id);
    setActiveView('trade');
  };

  return (
    <>
      <div className="skin-cardback" aria-hidden="true"><span className="skin-emblem" /></div>
      <div className={`app-container ${chatOpen ? 'chat-open' : ''}`}>
      <ChatSidebar open={chatOpen} onToggle={toggleChat} />
      <Navbar activeView={activeView} setActiveView={setActiveView} chatOpen={chatOpen} onToggleChat={toggleChat} />

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
          <TradingView market={selected} />
          <OrderEntry market={selected} onTraded={loadMarkets} />
        </div>
      )}

      {activeView === 'trade' && isMobile && (
        <div className="trade-mobile">
          {/* current market — tap to open the full markets list */}
          <button className="mkt-bar" onClick={openMarkets} aria-haspopup="dialog">
            <MarketThumb market={selected} className="mkt-bar-thumb" />
            <span className="mkt-bar-name">{selected?.displayName ?? 'Select a market'}</span>
            {selected && <MktBarPrice market={selected} />}
            <span className="mkt-bar-caret">▾</span>
          </button>

          <TradingView market={selected} mobile />
          <OrderEntry market={selected} onTraded={loadMarkets} />
          <BottomPanel market={selected} />

          <div
            className={`mobile-markets-drawer ${marketsOpen ? 'open' : ''}`}
            role="dialog"
            aria-label="Select market"
            aria-hidden={!marketsOpen}
            onTransitionEnd={(e) => {
              // unmount the list once the slide-out finishes (reopen mid-close keeps it)
              if (e.propertyName === 'transform' && !marketsOpen) setMarketsMounted(false);
            }}
          >
            {/* reuses the chat overlay's header chrome */}
            <div className="chat-header">
              <span className="chat-title">Select market</span>
              <button className="chat-collapse" onClick={() => setMarketsOpen(false)} aria-label="Close">✕</button>
            </div>
            {marketsMounted && (
              <SidebarMarkets
                markets={markets}
                loading={loading}
                selected={selected}
                onSelect={(m) => { onSelectMarket(m); setMarketsOpen(false); }}
                onListed={async (id) => { await onMarketListed(id); setMarketsOpen(false); }}
                collapsed={false}
                setCollapsed={() => {}}
              />
            )}
          </div>
        </div>
      )}

      {activeView === 'markets' && <MarketsScreener markets={markets} loading={loading} onTradeMarket={handleTradeMarket} />}
      {activeView === 'portfolio' && <Portfolio markets={markets} onSelect={handleTradeMarket} />}
      {activeView === 'pool' && <PoolView />}
      {activeView === 'leaderboard' && <Leaderboard />}
      {activeView === 'admin' && <AdminPanel onGoToMarket={(id) => handleTradeMarket({ id })} />}

      <Toasts />
      </div>
    </>
  );
}
