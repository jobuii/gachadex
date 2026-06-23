import { useState, useEffect, useCallback } from 'react';
import * as api from './api.js';

// Resting orders (limit / stop-loss / take-profit). Polled on the same 5s cadence as positions/balance
// (the app has no private WS channel for per-user data). `enabled` feature-detects the backend flag: the
// endpoints 404 while RESTING_ORDERS_ENABLED is off, so the whole resting-order UI stays hidden until it's
// on. Returns the active orders + helpers; usdToTriggerE6 converts a $ input to the micro-unit the API wants.
export function useRestingOrders(user) {
  const [orders, setOrders] = useState([]);
  const [enabled, setEnabled] = useState(null); // null = unknown, false = flag off, true = on

  const refresh = useCallback(() => {
    if (!user) {
      setOrders([]);
      return;
    }
    api
      .getRestingOrders()
      .then((r) => {
        setOrders(r.orders || []);
        setEnabled(true);
      })
      .catch((e) => {
        if (e.status === 404) setEnabled(false); // feature off — hide the UI
        // any other error (network/5xx): keep the last-known state, retry next tick
      });
  }, [user]);

  useEffect(() => {
    refresh();
    if (!user) return undefined;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, user]);

  return { orders, enabled, refresh };
}

// a $ string → integer micro-unit string (e.g. "950.5" → "950500000"); null/empty/≤0 → null
export function usdToE6(usd) {
  const n = parseFloat(usd);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 1e6)).toString();
}
