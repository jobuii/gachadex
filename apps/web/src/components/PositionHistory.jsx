import { useState } from 'react';
import { formatUsd, formatSignedUsd, notional, initialMargin } from '@pokex/pricing';
import { PnlShareModal, ShareIcon } from './PnlShareModal';

const usd = (e6) => formatUsd(BigInt(e6 ?? '0'));
const qty = (e6) => (Number(e6 ?? 0) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 4 });
const STATUS_LABELS = { closed: 'Closed', liquidated: 'Liquidated', deleveraged: 'Deleveraged' };
const statusLabel = (s) => STATUS_LABELS[s] ?? s;

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(5, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A closed history row → the share-card shape. Closed positions release their margin, so reconstruct
// what was invested = initialMargin(entry notional, leverage); pnl is the realized P/L. (mirrors BottomPanel)
function closedShare(p) {
  const invested = initialMargin(notional(BigInt(p.closedQtyE6), BigInt(p.entryE6)), (p.leverage || 1) * 100);
  return {
    marketId: p.marketId,
    symbol: p.symbol,
    displayName: p.symbol,
    side: (p.side ?? '').toLowerCase(),
    leverage: p.leverage,
    qtyE6: p.closedQtyE6,
    marginUusdc: invested.toString(),
    pnlUusdc: p.realizedPnlUusdc,
  };
}

/** Closed-positions history table — same columns + share card as the exchange bottom panel. */
export function PositionHistory({ positions, onSelect }) {
  const [shareP, setShareP] = useState(null);
  return (
    <>
      <div className="positions-table-wrap">
        <table className="positions-table">
          <thead>
            <tr>
              <th>SYMBOL</th><th>SIDE</th><th>STATUS</th><th>ENTRY</th><th>AVG CLOSE</th>
              <th>REALIZED PNL</th><th>CLOSED QTY</th><th>OPENED</th><th>CLOSED</th>
            </tr>
          </thead>
          <tbody>
            {positions == null ? (
              <tr><td colSpan={9} className="hist-empty">Loading…</td></tr>
            ) : positions.length === 0 ? (
              <tr><td colSpan={9} className="hist-empty">No closed positions yet.</td></tr>
            ) : (
              positions.map((p, i) => (
                <tr key={i}>
                  <td className="link" onClick={() => onSelect?.(p.marketId)}>{p.symbol}</td>
                  <td className={(p.side ?? '').toLowerCase() === 'long' ? 'up' : 'down'}>{p.side} {p.leverage}x</td>
                  <td>{statusLabel(p.status)}</td>
                  <td>{usd(p.entryE6)}</td>
                  <td>{p.avgCloseE6 ? usd(p.avgCloseE6) : '—'}</td>
                  <td>
                    <span className="pnl-cell-line">
                      <span className={BigInt(p.realizedPnlUusdc ?? '0') >= 0n ? 'up' : 'down'}>
                        {formatSignedUsd(p.realizedPnlUusdc ?? '0')}
                      </span>
                      <button className="pnl-share-btn" title="Share PnL card" onClick={() => setShareP(closedShare(p))}>
                        <ShareIcon />
                      </button>
                    </span>
                  </td>
                  <td>{qty(p.closedQtyE6)}</td>
                  <td>{fmtTime(p.openedAt)}</td>
                  <td>{fmtTime(p.closedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {shareP && <PnlShareModal position={shareP} onClose={() => setShareP(null)} />}
    </>
  );
}
