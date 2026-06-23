import { create } from 'zustand';
import { ensureConnected, subscribe, onMessage } from '../lib/ws.js';

/**
 * Games live feed. Subscribes once to the public `games` channel and keeps the most recent rips so the
 * Pack Rip panel can show a "recent pulls" ticker. Mirrors store/realtime.js / store/chat.js.
 */
export const useGames = create((set, get) => ({
  feed: [], // recent { id, game, handle, displayName, imageSmall, valueE6, tier, at }
  _started: false,

  start() {
    if (get()._started) return;
    set({ _started: true });
    ensureConnected();
    subscribe(['games']);
    onMessage((m) => {
      if (m.ch !== 'games' || !m.data) return;
      if (m.type === 'play') {
        set((s) => ({ feed: [m.data, ...s.feed.filter((x) => x.id !== m.data.id)].slice(0, 30) }));
      }
    });
  },
}));
