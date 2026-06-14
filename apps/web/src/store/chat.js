import { create } from 'zustand';
import { ensureConnected, subscribe, onMessage } from '../lib/ws.js';
import { MOBILE_QUERY } from '../lib/useMediaQuery.js';
import * as api from '../lib/api.js';

// Open-state for the chat rail (Landing + Exchange): a remembered preference on desktop;
// on mobile the rail is a full-screen overlay that always starts closed, and toggling it
// there must not clobber the desktop preference — so the key is only read AND written
// off-mobile.
export const initialChatOpen = () =>
  localStorage.getItem('gachadex_chat_open') !== '0' && !window.matchMedia(MOBILE_QUERY).matches;

export const persistChatOpen = (open) => {
  if (!window.matchMedia(MOBILE_QUERY).matches) {
    localStorage.setItem('gachadex_chat_open', open ? '1' : '0');
  }
};

/**
 * Global chat store, shared by the chat rail (renders messages) and the navbar toggle (shows the
 * unread badge). Subscribes once for the app's lifetime; `unread` accrues on new messages and is
 * cleared by markRead() whenever the rail is open.
 */
export const useChat = create((set, get) => ({
  messages: [],
  unread: 0,
  modState: {}, // userId -> { mutedUntil, banned } — live mute/ban snapshots from the server
  _started: false,

  start() {
    if (get()._started) return;
    set({ _started: true });
    ensureConnected();
    subscribe(['chat']);
    api.getChat().then((r) => set({ messages: r.messages })).catch(() => {});
    onMessage((m) => {
      if (m.ch !== 'chat' || !m.data) return;
      // a moderator deleted a message — drop it everywhere, no unread bump
      if (m.type === 'delete') {
        set((s) => ({ messages: s.messages.filter((x) => x.id !== m.data.id) }));
        return;
      }
      // a user's mute/ban changed — record the snapshot (drives the disabled input + mod toggle buttons)
      if (m.type === 'modstate') {
        set((s) => ({ modState: { ...s.modState, [m.data.userId]: { mutedUntil: m.data.mutedUntil, banned: m.data.banned } } }));
        return;
      }
      // 'message' = a user post; 'event' = a BIG BET / BIG WIN action bar (rendered inline in the rail)
      if (m.type !== 'message' && m.type !== 'event') return;
      set((s) =>
        s.messages.some((x) => x.id === m.data.id)
          ? s
          : { messages: [...s.messages.slice(-199), m.data], unread: s.unread + 1 },
      );
    });
  },

  markRead() {
    if (get().unread !== 0) set({ unread: 0 });
  },

  async send(body, replyTo) {
    const b = body.trim();
    if (b) await api.postChat(b, replyTo); // the WS echo appends it for everyone, including us
  },

  // optimistically relabel a user's already-rendered messages after they change their username
  relabel(userId, handle) {
    set((s) => ({ messages: s.messages.map((m) => (m.userId === userId ? { ...m, handle } : m)) }));
  },
}));
