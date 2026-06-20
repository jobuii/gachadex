import { useState, useEffect } from 'react';
import { formatUsd, formatSignedUsd, notional, initialMargin } from '@pokex/pricing';
import { useRealtime } from '../store/realtime';
import { useAuth } from '../auth/AuthContext';
import { OpenPositions } from './OpenPositions';
import { PnlShareModal, ShareIcon } from './PnlShareModal';
import * as api from '../lib/api.js';

// A closed history row → the share-card shape. Closed positions release their margin (margin_uusdc=0),
// so reconstruct what was invested = initialMargin(entry notional, leverage); pnl is the realized P/L.
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

const TABS = [
  ['oi', 'Open Interest'],
  ['positions', 'Positions'],
  ['orders', 'Order History'],
  ['trades', 'Trade History'],
  ['transactions', 'Transactions'],
];

const usd = (e6) => formatUsd(BigInt(e6 ?? '0'));
const qty = (e6) => (Number(e6 ?? 0) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 4 });
const sideCls = (s) => (s === 'Buy' || s === 'Long' ? 'up' : 'down');
const STATUS_LABELS = { closed: 'Closed', liquidated: 'Liquidated', deleveraged: 'Deleveraged' };
const statusLabel = (s) => STATUS_LABELS[s] ?? s;

function Signed({ e6 }) {
  return <span className={BigInt(e6 ?? '0') >= 0n ? 'up' : 'down'}>{formatSignedUsd(e6 ?? '0')}</span>;
}

// Symbol cell — a link that jumps to that market (empty/em-dash when there's no symbol, e.g. a deposit).
const SymCell = ({ symbol, onGo }) =>
  symbol ? <td className="link" onClick={() => onGo?.(symbol)}>{symbol}</td> : <td className="muted">—</td>;

function positionsEmptyLabel(user, rows) {
  if (!user) return 'Sign in to view your positions.';
  if (rows == null) return 'Loading…';
  return 'No open positions.';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(5, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MsgRow = ({ cols, cls, children }) => (
  <tr><td colSpan={cols} className={`hist-empty ${cls ?? ''}`}>{children}</td></tr>
);

// A history table that ALWAYS shows its column headers; the body reflects the current state
// (signed-out / loading / empty / rows) so the columns are visible even with no data yet.
function DataTab({ head, user, err, rows, empty, renderRows }) {
  const n = head.length;
  let body;
  if (!user) body = <MsgRow cols={n}>Sign in to view your history.</MsgRow>;
  else if (err) body = <MsgRow cols={n} cls="down">{err}</MsgRow>;
  else if (rows == null) body = <MsgRow cols={n}>Loading…</MsgRow>;
  else if (rows.length === 0) body = <MsgRow cols={n}>{empty}</MsgRow>;
  else body = renderRows(rows);
  return (
    <table className="hist-table">
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{body}</tbody>
    </table>
  );
}

export function BottomPanel({ market, height, onGoToMarket }) {
  const { user } = useAuth();
  const oi = useRealtime((s) => s.oi);
  const [tab, setTab] = useState('oi');
  const [posTab, setPosTab] = useState('open');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [shareP, setShareP] = useState(null); // closed position being shared as a PnL card

  // Clear rows on any tab switch so the previous tab's data (a different row shape) can't render
  // under the new tab for a frame before the fetch effect resets it.
  const selectTab = (v) => { setTab(v); setRows(null); setErr(null); };
  const selectPosTab = (v) => { setPosTab(v); setRows(null); setErr(null); };

  useEffect(() => {
    if (tab === 'oi' || !user) {
      setRows(null);
      setErr(null);
      return;
    }
    let alive = true;
    setErr(null);
    setRows(null);
    const fetchFor = () => {
      if (tab === 'positions') return (posTab === 'open' ? api.getPositions() : api.getPositionHistory()).then((r) => r.positions);
      if (tab === 'orders') return api.getOrderHistory().then((r) => r.orders);
      if (tab === 'trades') return api.getTradeHistory().then((r) => r.trades);
      return api.getTransactionHistory().then((r) => r.transactions);
    };
    const load = () => fetchFor().then((d) => alive && setRows(d)).catch((e) => alive && setErr(e.message));
    load();
    const poll = tab === 'positions' && posTab === 'open' ? setInterval(load, 5000) : null;
    return () => {
      alive = false;
      if (poll) clearInterval(poll);
    };
  }, [tab, posTab, user, reloadKey]);

  const o = market ? oi[market.id] : null;
  const longU = o ? Number(o.longUusdc) / 1e6 : 0;
  const shortU = o ? Number(o.shortUusdc) / 1e6 : 0;
  const totalOi = longU + shortU;
  const longPct = totalOi > 0 ? (longU / totalOi) * 100 : 50;

  return (
    <div className="bottom-panel" style={height ? { height: `${height}px` } : undefined}>
      <div className="bottom-tabs">
        {TABS.map(([v, label]) => (
          <button key={v} className={`bottom-tab-btn ${tab === v ? 'active' : ''}`} onClick={() => selectTab(v)}>
            {label}
          </button>
        ))}
      </div>

      <div className="bottom-content">
        {tab === 'oi' && (
          <div className="oi-block">
            <div className="oi-row">
              <span className="up">▲ Long {formatUsd(longU, { compact: true })}</span>
              <span className="down">Short {formatUsd(shortU, { compact: true })} ▼</span>
            </div>
            <div className="oi-bar">
              <div className="oi-bar-long" style={{ width: `${longPct}%` }} />
              <div className="oi-bar-short" style={{ width: `${100 - longPct}%` }} />
            </div>
            <div className="oi-hint">Mark = index {market?.kind === 'index' ? '(basket NAV)' : ''} ± a bounded skew premium from open interest.</div>
          </div>
        )}

        {tab === 'positions' && (
          <>
            <div className="sub-tabs">
              <button className={`sub-tab-btn ${posTab === 'open' ? 'active' : ''}`} onClick={() => selectPosTab('open')}>Open</button>
              <button className={`sub-tab-btn ${posTab === 'history' ? 'active' : ''}`} onClick={() => selectPosTab('history')}>History</button>
            </div>
            {posTab === 'open' ? (
              <OpenPositions
                positions={user ? rows : []}
                onChanged={() => setReloadKey((k) => k + 1)}
                onSelect={onGoToMarket}
                emptyLabel={positionsEmptyLabel(user, rows)}
              />
            ) : (
              <DataTab
                head={['SYMBOL', 'SIDE', 'STATUS', 'ENTRY', 'AVG CLOSE', 'REALIZED PNL', 'CLOSED QTY', 'OPENED', 'CLOSED']}
                user={user}
                err={err}
                rows={rows}
                empty="No closed positions yet."
                renderRows={(rs) => rs.map((p, i) => (
                  <tr key={i}>
                    <SymCell symbol={p.symbol} onGo={onGoToMarket} />
                    <td className={sideCls(p.side)}>{p.side} {p.leverage}x</td>
                    <td>{statusLabel(p.status)}</td>
                    <td>{usd(p.entryE6)}</td>
                    <td>{p.avgCloseE6 ? usd(p.avgCloseE6) : '—'}</td>
                    <td>
                      <div className="pnl-cell">
                        <Signed e6={p.realizedPnlUusdc} />
                        <button className="pnl-share-btn" title="Share PnL card" onClick={() => setShareP(closedShare(p))}>
                          <ShareIcon />
                        </button>
                      </div>
                    </td>
                    <td>{qty(p.closedQtyE6)}</td>
                    <td>{fmtTime(p.openedAt)}</td>
                    <td>{fmtTime(p.closedAt)}</td>
                  </tr>
                ))}
              />
            )}
          </>
        )}

        {tab === 'orders' && (
          <DataTab
            head={['TIME', 'SYMBOL', 'SIDE', 'PRICE', 'FILLED', 'VALUE', 'REDUCE', 'STATUS']}
            user={user}
            err={err}
            rows={rows}
            empty="No orders yet."
            renderRows={(rs) => rs.map((r, i) => (
              <tr key={i}>
                <td>{fmtTime(r.time)}</td>
                <SymCell symbol={r.symbol} onGo={onGoToMarket} />
                <td className={sideCls(r.side)}>{r.side}</td>
                <td>{usd(r.priceE6)}</td>
                <td>{qty(r.filledE6)}</td>
                <td>{usd(r.valueE6)}</td>
                <td>{r.reduceOnly ? 'Yes' : 'No'}</td>
                <td className="muted">{r.status}</td>
              </tr>
            ))}
          />
        )}

        {tab === 'trades' && (
          <DataTab
            head={['TIME', 'SYMBOL', 'SIDE', 'PRICE', 'AMOUNT', 'VALUE', 'FEE', 'REALIZED', 'ROLE']}
            user={user}
            err={err}
            rows={rows}
            empty="No trades yet."
            renderRows={(rs) => rs.map((r, i) => (
              <tr key={i}>
                <td>{fmtTime(r.time)}</td>
                <SymCell symbol={r.symbol} onGo={onGoToMarket} />
                <td className={sideCls(r.side)}>{r.side}</td>
                <td>{usd(r.priceE6)}</td>
                <td>{qty(r.amountE6)}</td>
                <td>{usd(r.valueE6)}</td>
                <td>{usd(r.feeUusdc)}</td>
                <td><Signed e6={r.realizedPnlUusdc} /></td>
                <td className="muted">{r.role}</td>
              </tr>
            ))}
          />
        )}

        {tab === 'transactions' && (
          <DataTab
            head={['TIME', 'TYPE', 'AMOUNT', 'SYMBOL']}
            user={user}
            err={err}
            rows={rows}
            empty="No transactions yet."
            renderRows={(rs) => rs.map((r, i) => (
              <tr key={i}>
                <td>{fmtTime(r.time)}</td>
                <td>{r.type}</td>
                <td><Signed e6={r.amountUusdc} /></td>
                <SymCell symbol={r.symbol} onGo={onGoToMarket} />
              </tr>
            ))}
          />
        )}
      </div>
      {shareP && <PnlShareModal position={shareP} onClose={() => setShareP(null)} />}
    </div>
  );
}
