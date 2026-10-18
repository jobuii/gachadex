// 24h traded volume, compact: — for none, $950, $12K, $1.2M (screener + printing switcher)
export function fmtVol(usd) {
  if (!usd || usd <= 0) return '—';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}
