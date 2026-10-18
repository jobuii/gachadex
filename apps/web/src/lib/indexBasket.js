import { useState, useEffect } from 'react';
import * as api from './api.js';

/** "4 Nov" in UTC — index change dates are UTC days. */
export const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** One index's basket view (GET /markets/index-basket): { view, error }, both null while loading. Re-read every
 *  60 s (like the Indices overview), so an open trade view sees a change announced or applied. */
export function useIndexBasket(symbol) {
  const [state, setState] = useState({ symbol: null, view: null, error: null });
  useEffect(() => {
    if (!symbol) return undefined;
    let alive = true;
    const load = () =>
      api
        .getIndexBasket(symbol)
        .then((view) => alive && setState({ symbol, view, error: null }))
        .catch((e) => alive && setState((s) => (s.symbol === symbol && s.view ? s : { symbol, view: null, error: e.message }))); // a failed refresh keeps the last view
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol]);
  return state.symbol === symbol ? state : { view: null, error: null };
}
