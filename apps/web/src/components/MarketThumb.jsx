import { thumbSrc } from '../lib/thumb.js';

// Market thumbnail with the index/empty fallback — shared by the trade header (desktop) and the mobile
// market bar so the placeholder logic can't diverge. Index markets resolve to their per-slug card art.
export function MarketThumb({ market, className }) {
  const src = thumbSrc(market);
  return src ? (
    <img src={src} alt="" className={className} />
  ) : (
    <span className={`${className} idx-thumb`}>{market?.kind === 'index' ? 'IDX' : '—'}</span>
  );
}
