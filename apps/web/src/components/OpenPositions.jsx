import { Fragment, useState } from 'react';
import { formatUsd, formatSignedUsd, formatPct } from '@pokex/pricing';
import * as api from '../lib/api.js';
import { usdToE6 } from '../lib/useRestingOrders.js';
import { PnlShareModal, ShareIcon } from './PnlShareModal';

export function OpenPositions({
  positions,
  onChanged,
  onSelect,
  emptyLabel = 'No open positions.',
  compact = false,
  // resting-orders (P3): when the feature is on, each row gets a stop-loss / take-profit editor
  restingOrders = [],
  restingEnabled = false,
  onBracketChanged,
}) {
  const [busy, setBusy] = useState(null);
  const [shareP, setShareP] = useState(null);
  const [editing, setEditing] = useState(null); // position id whose SL/TP editor is open
  const [slInput, setSlInput] = useState('');
  const [tpInput, setTpInput] = useState('');
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

  const bracketsFor = (p) => ({
    sl: restingOrders.find((o) => o.positionId === p.id && o.kind === 'stop_loss'),
    tp: restingOrders.find((o) => o.positionId === p.id && o.kind === 'take_profit'),
  });
  const toEdit = (e6) => (e6 ? (Number(e6) / 1e6).toString() : '');
  const openEditor = (p) => {
    if (editing === p.id) { setEditing(null); return; }
    const { sl, tp } = bracketsFor(p);
    setSlInput(toEdit(sl?.triggerPriceE6));
    setTpInput(toEdit(tp?.triggerPriceE6));
    setEditing(p.id);
  };
  const saveBracket = async (p) => {
    setBusy(p.id);
    try {
      const slE6 = usdToE6(slInput);
      const tpE6 = usdToE6(tpInput);
      // placing the same kind on a position replaces it (server-side); skip a field to leave it unchanged
      if (slE6) await api.placeRestingOrder({ marketId: p.marketId, kind: 'stop_loss', positionId: p.id, triggerPriceE6: slE6, reduceOnly: true, idempotencyKey: crypto.randomUUID() });
      if (tpE6) await api.placeRestingOrder({ marketId: p.marketId, kind: 'take_profit', positionId: p.id, triggerPriceE6: tpE6, reduceOnly: true, idempotencyKey: crypto.randomUUID() });
      setEditing(null);
      onBracketChanged?.();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  };
  const clearBracket = async (p) => {
    setBusy(p.id);
    try {
      const { sl, tp } = bracketsFor(p);
      if (sl) await api.cancelRestingOrder(sl.id);
      if (tp) await api.cancelRestingOrder(tp.id);
      setEditing(null);
      onBracketChanged?.();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  };

  const span = compact ? 4 : 8;

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
          <tr><td colSpan={span} className="hist-empty">{emptyLabel}</td></tr>
        )}
        {rows.map((p) => {
          const pnlE6 = BigInt(p.unrealizedPnlUusdc ?? '0');
          const marginE6 = BigInt(p.marginUusdc ?? '0');
          const up = pnlE6 >= 0n;
          // ROE = PnL ÷ the position's own margin (return on what the trader put up).
          const roePct = marginE6 > 0n ? (Number(pnlE6) / Number(marginE6)) * 100 : 0;
          const { sl, tp } = bracketsFor(p);
          const hasBracket = Boolean(sl || tp);
          return (
            <Fragment key={p.id}>
            <tr>
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
                <div className="pos-actions">
                  {restingEnabled && (
                    <button
                      className={`btn-ghost sm ${hasBracket ? 'on' : ''}`}
                      title="Set a stop-loss / take-profit"
                      disabled={busy === p.id}
                      onClick={() => openEditor(p)}
                    >
                      {hasBracket ? 'SL/TP ✓' : 'SL/TP'}
                    </button>
                  )}
                  <button className="btn-ghost sm" disabled={busy === p.id} onClick={() => close(p)}>
                    {busy === p.id ? '…' : 'Close'}
                  </button>
                </div>
              </td>
            </tr>
            {restingEnabled && editing === p.id && (
              <tr className="bracket-row">
                <td colSpan={span}>
                  <div className="bracket-editor">
                    <label>Stop-loss <input type="number" min="0" placeholder="price" value={slInput} onChange={(e) => setSlInput(e.target.value)} /></label>
                    <label>Take-profit <input type="number" min="0" placeholder="price" value={tpInput} onChange={(e) => setTpInput(e.target.value)} /></label>
                    <button className="btn-primary sm" disabled={busy === p.id} onClick={() => saveBracket(p)}>Save</button>
                    {hasBracket && <button className="btn-ghost sm" disabled={busy === p.id} onClick={() => clearBracket(p)}>Clear</button>}
                    <button className="btn-ghost sm" onClick={() => setEditing(null)} title="Close">×</button>
                  </div>
                </td>
              </tr>
            )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
    {shareP && <PnlShareModal position={shareP} onClose={() => setShareP(null)} />}
    </>
  );
}
