// A compact 24h trend sparkline for the markets tables (indices + cards). The line slopes UP (green) for a
// non-negative 24h change and DOWN (red) for a negative one, with the slope reflecting the magnitude (capped
// at ±15%). It is derived from the 24h change %, not intraday ticks (the markets feed carries no per-row
// price series), so it's a directional summary — drawn monotonically, with no fabricated reversals. Mirrors
// the trend column from the Option B mockup.
const W = 64;
const H = 22;

export function TrendSpark({ pct }) {
  if (pct == null) return <span className="trend-spark-na" aria-hidden="true">—</span>;
  const mid = H / 2;
  const up = pct >= 0;
  const mag = Math.min(Math.abs(pct), 15) / 15;     // 0..1, saturates at ±15%
  const amp = 3 + mag * (H / 2 - 5);                 // vertical travel from the midline
  const ys = up
    ? [mid + amp, mid + amp * 0.35, mid - amp * 0.35, mid - amp]   // low → high
    : [mid - amp, mid - amp * 0.35, mid + amp * 0.35, mid + amp];  // high → low
  const points = ys.map((y, i) => `${((i / 3) * W).toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg
      className={`trend-spark ${up ? 'up' : 'down'}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`24h trend ${up ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)} percent`}
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
