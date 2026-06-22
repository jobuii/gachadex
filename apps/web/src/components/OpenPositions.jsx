import { useState } from 'react';
import { formatUsd, formatSignedUsd, formatPct } from '@pokex/pricing';
import * as api from '../lib/api.js';
import { PnlShareModal, ShareIcon } from './PnlShareModal';

export function OpenPositions({ positions, onChanged, onSelect, emptyLabel = 'No open positions.', compact = false }) {
  const [busy, setBusy] = useState(null);
  const [shareP, setShareP] = useState(null);
  const rows = positions ?? [];

  const close = async (p) => {
    setBusy(p.id);
    try {
      await api.closePosition(p.id, { fractionBps: 10_000, idempotencyKey: crypto.randomUUID() });
      onChanged?.();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    <table className="positions-table">
      <thead>
        <tr>
          <th>SYMBOL</th>
          <th>SIDE</th>
          {!compact && <><th>SIZE</th><th>ENTRY</th><th>MARK</th><th>LIQ</th></>}
          <th>PNL (ROE%)</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={compact ? 4 : 8} className="hist-empty">{emptyLabel}</td></tr>
        )}
        {rows.map((p) => {
          const pnlE6 = BigInt(p.unrealizedPnlUusdc ?? '0');
          const marginE6 = BigInt(p.marginUusdc ?? '0');
          const up = pnlE6 >= 0n;
          // ROE = PnL ÷ the position's own margin (return on what the trader put up).
          const roePct = marginE6 > 0n ? (Number(pnlE6) / Number(marginE6)) * 100 : 0;
          return (
            <tr key={p.id}>
              <td className="link" onClick={() => onSelect?.(p.marketId)}>{p.symbol}</td>
              <td className={p.side === 'long' ? 'up' : 'down'}>
                {(p.side ?? '').toUpperCase()} {p.leverage}x
              </td>
              {!compact && (
                <>
                  <td>{(Number(p.qtyE6) / 1e6).toFixed(2)}</td>
                  <td>{formatUsd(BigInt(p.avgEntryE6 ?? '0'))}</td>
                  <td>{formatUsd(BigInt(p.markE6 ?? '0'))}</td>
                  <td className="down">{formatUsd(BigInt(p.liqPriceE6 ?? '0'))}</td>
                </>
              )}
              <td className={up ? 'up' : 'down'}>
                <div className="pnl-cell">
                  <span className="pnl-cell-line">
                    <span>{formatSignedUsd(p.unrealizedPnlUusdc ?? '0')}</span>
                    <button className="pnl-share-btn" title="Share PnL card" onClick={() => setShareP(p)}>
                      <ShareIcon />
                    </button>
                  </span>
                  <span className="pnl-cell-roe">{formatPct(roePct)}</span>
                </div>
              </td>
              <td>
                <button className="btn-ghost sm" disabled={busy === p.id} onClick={() => close(p)}>
                  {busy === p.id ? '…' : 'Close'}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    {shareP && <PnlShareModal position={shareP} onClose={() => setShareP(null)} />}
    </>
  );
}
