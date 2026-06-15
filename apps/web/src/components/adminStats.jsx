import { formatUsd } from '@pokex/pricing';

// Small admin dashboard tiles, shared across the operator panels (Main, Customers, Chat). Values are
// micro-USDC (string or bigint); a null value renders an em-dash.

export function Stat({ label, value }) {
  return (
    <div className="admin-stat">
      <div className="lbl">{label}</div>
      <div className="val">{value != null ? formatUsd(BigInt(value)) : '—'}</div>
    </div>
  );
}

// Profit/loss tile — green when the house is up, red when down (handles negative bigints explicitly).
export function PnlStat({ label, value }) {
  const v = BigInt(value);
  const neg = v < 0n;
  return (
    <div className={`admin-stat ${neg ? 'pnl-down' : 'pnl-up'}`}>
      <div className="lbl">{label}</div>
      <div className="val">{neg ? '-' : ''}{formatUsd(neg ? -v : v)}</div>
    </div>
  );
}
