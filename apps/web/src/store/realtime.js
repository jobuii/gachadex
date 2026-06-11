import { create } from 'zustand';
import { ensureConnected, subscribe, unsubscribe, onMessage } from '../lib/ws.js';

/**
 * Live market data store. `marks[marketId]` and `oi[marketId]` are kept fresh from the
 * WebSocket. Components call watch(marketId)/unwatch(marketId) to (un)subscribe.
 */
// Live mark with REST fallback — the one expression for "what price do we show for this market".
export const liveMarkE6 = (marks, m) => marks[m.id]?.markE6 ?? m.markE6;

export const useRealtime = create((set, get) => ({
  marks: {}, // marketId -> { markE6, indexE6, premiumE6, ts }
  oi: {}, // marketId -> { longUusdc, shortUusdc }
  _started: false,

  start() {
    if (get()._started) return;
    set({ _started: true });
    ensureConnected();
    onMessage((msg) => {
      const { type, data } = msg;
      if (!data || !data.marketId) return;
      if (type === 'mark') set((s) => ({ marks: { ...s.marks, [data.marketId]: data } }));
      else if (type === 'oi') set((s) => ({ oi: { ...s.oi, [data.marketId]: data } }));
    });
  },

  watch(marketId) {
    if (!marketId) return;
    subscribe([`mark:${marketId}`, `oi:${marketId}`, `stats:${marketId}`]);
  },
  unwatch(marketId) {
    if (!marketId) return;
    unsubscribe([`mark:${marketId}`, `oi:${marketId}`, `stats:${marketId}`]);
  },
}));
