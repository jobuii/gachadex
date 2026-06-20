// A market's thumbnail image source: a real card uses its provider image; an index uses its per-slug
// card art at /index-cards/<slug>.png (web public/). Null => the caller renders the IDX/— placeholder.
// Lives in lib/ (not a component file) so it can be shared without breaking react-refresh.
export function thumbSrc(market) {
  if (market?.imageSmall) return market.imageSmall;
  if (market?.kind === 'index' && market?.indexSlug) return `/index-cards/${market.indexSlug}.png`;
  return null;
}
