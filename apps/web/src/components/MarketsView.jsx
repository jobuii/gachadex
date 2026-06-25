import { useStickyState } from '../lib/useStickyState';
import { MarketsScreener } from './MarketsScreener';
import { IndexOverview } from './IndexOverview';

// The Markets page hosts two views behind an Indices | Cards switch (mirrors the sidebar's split).
// Indices is the default — they're the platform's headline product — and renders the overview table;
// Cards is the existing screener. The choice persists across refresh.
export function MarketsView({ markets, loading, onTradeMarket }) {
  const [mode, setMode] = useStickyState('pokeX_marketsMode', 'indices');
  return (
    <div className="markets-view">
      <div className="markets-mode" role="tablist" aria-label="Markets view">
        <button role="tab" aria-selected={mode === 'indices'} className={mode === 'indices' ? 'active' : ''} onClick={() => setMode('indices')}>
          Indices
        </button>
        <button role="tab" aria-selected={mode === 'cards'} className={mode === 'cards' ? 'active' : ''} onClick={() => setMode('cards')}>
          Cards
        </button>
      </div>
      {mode === 'indices' ? (
        <IndexOverview markets={markets} loading={loading} onTradeMarket={onTradeMarket} />
      ) : (
        <MarketsScreener markets={markets} loading={loading} onTradeMarket={onTradeMarket} />
      )}
    </div>
  );
}
