import { useCallback, useMemo, useSyncExternalStore } from 'react';

// Reactive media-query hook — drives the mobile/desktop composition switch (the breakpoint
// must match mobile.css). One MediaQueryList per query; useSyncExternalStore keeps render
// and subscription tear-free.
export function useMediaQuery(query) {
  const mql = useMemo(() => window.matchMedia(query), [query]);
  const subscribe = useCallback(
    (onChange) => {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [mql],
  );
  return useSyncExternalStore(subscribe, () => mql.matches);
}

export const MOBILE_QUERY = '(max-width: 768px)';
