// A compact 24h trend sparkline for the markets tables (indices + cards) — a jagged chart line that nets
// UP (green) for a non-negative 24h change and DOWN (red) for a negative one, slope ∝ |change| (capped
// ±15%). The markets feed carries no per-row price series, so the intraday wiggle is synthesized
// DETERMINISTICALLY from the row's id (stable per row, never jitters on re-render — only the net
// direction/slope follows the live change). A directional summary, not real ticks. "—" when unknown.
const W = 64;
const H = 22;
const N = 9; // points across the width

// deterministic 0..1 from a stable seed + index (FNV-1a + a final mix) — same seed → same wiggle every render
function rand(seed, i) {
  let h = (2166136261 ^ Math.imul(i + 1, 2654435761)) >>> 0;
  const s = String(seed);
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function TrendSpark({ pct, seed = '' }) {
  if (pct == null) return <span className="trend-spark-na" aria-hidden="true">—</span>;
  const up = pct >= 0;
  const mid = H / 2;
  const mag = Math.min(Math.abs(pct), 15) / 15; // 0..1
  const drift = 2 + mag * (H / 2 - 4);          // net trend travel (endpoints), ~2..9
  const wob = 1 + mag * 3;                       // intraday wobble amplitude, ~1..4 (kept below the drift)
  const ys = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1); // 0..1
    const base = up ? (mid + drift) - t * 2 * drift : (mid - drift) + t * 2 * drift; // overall up/down
    const calm = i === 0 || i === N - 1 ? 0.25 : 1; // settle the endpoints so the direction reads clearly
    const w = (rand(seed, i) - 0.5) * 2 * wob * calm;
    ys.push(Math.max(2, Math.min(H - 2, base + w)));
  }
  const points = ys.map((y, i) => `${((i / (N - 1)) * W).toFixed(1)},${y.toFixed(1)}`).join(' ');
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
