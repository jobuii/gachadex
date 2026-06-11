// Market thumbnail with the index/empty fallback — shared by the trade header (desktop)
// and the mobile market bar so the placeholder logic can't diverge.
export function MarketThumb({ market, className }) {
  return market?.imageSmall ? (
    <img src={market.imageSmall} alt="" className={className} />
  ) : (
    <span className={`${className} idx-thumb`}>{market?.kind === 'index' ? 'IDX' : '—'}</span>
  );
}
