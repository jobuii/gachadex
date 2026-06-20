import { useEffect, useState } from 'react';

// useState that persists to localStorage under `key`, so a toggle/preference survives a refresh.
// JSON-encoded; falls back to `initial` on a missing/corrupt value or a storage-blocked (private-mode)
// environment. Components sharing a key reconcile on (re)mount — it's persistence, not a live cross-
// component subscription (no storage-event listener).
export function useStickyState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable (private mode) — keep the in-memory value */
    }
  }, [key, value]);
  return [value, setValue];
}
