import { Fragment, useEffect, useState } from 'react';
import { formatUsd, formatSignedUsd, shortenPubkey } from '@pokex/pricing';
import * as api from '../lib/api.js';

// Operator "Customers" tab: one row per user, paginated + sortable, each expandable to its open
// positions per market. Renders inside the AdminPanel (monospace data font + access gate); takes the
// verified admin key as a prop.
const PAGE = 50;
const SORTS = [
  ['volume', 'Volume'],
  ['fees', 'Fees'],
  ['free', 'Balance'],
  ['locked', 'In trades'],
  ['pnl', 'Realized P/L'],
  ['joined', 'Joined'],
];
const COLS = 15; // table width (for the expand-row + empty-state colSpan)

const short = (a) => shortenPubkey(a) || '—';
const usd = (e6) => formatUsd(BigInt(e6 ?? 0)); // ?? 0 guards against an older API missing the new fields
const signed = (e6) => ({ color: BigInt(e6 ?? 0) < 0n ? 'var(--danger)' : 'var(--success)' });

export function CustomersView({ adminKey }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState('volume');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(null);
  const [expanded, setExpanded] = useState(null); // userId currently expanded
  const [positions, setPositions] = useState({}); // userId -> positions[] | 'loading'

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .adminGetCustomers({ limit: PAGE, offset, sort }, adminKey)
      .then((r) => {
        if (!live) return;
        setRows(r.customers || []);
        setTotal(r.total || 0);
        setErr(null);
      })
      .catch((e) => live && setErr(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [adminKey, offset, sort]);

  const copy = (text) => {
    if (!text) return;
    navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1000);
  };

  // Expand a row to its open positions per market — lazy-loaded once, then cached.
  const toggle = (userId) => {
    if (expanded === userId) {
      setExpanded(null);
      return;
    }
    setExpanded(userId);
    if (positions[userId] === undefined) {
      setPositions((p) => ({ ...p, [userId]: 'loading' }));
      api
        .adminGetCustomerPositions(userId, adminKey)
        .then((r) => setPositions((p) => ({ ...p, [userId]: r.positions || [] })))
        .catch(() => setPositions((p) => ({ ...p, [userId]: [] })));
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <div>
      <h3 style={{ marginTop: '1rem' }}>Customers ({total})</h3>
      <p className="ref-blurb">
        One row per user. Sort with the buttons; click a wallet/deposit address to copy it; click the ▸ to
        expand a customer's open positions per market. <strong>P/L</strong> is realized (closed trades);{' '}
        <strong>uP/L</strong> is unrealized (open positions).
      </p>
      {err && <div className="order-error">{err}</div>}

      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0.5rem 0' }}>
        {SORTS.map(([k, label]) => (
          <button
            key={k}
            className={`${sort === k ? 'btn-primary' : 'btn-ghost'} sm`}
            onClick={() => {
              setSort(k);
              setOffset(0);
            }}
          >
            {label}
            {sort === k ? ' ↓' : ''}
          </button>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="cust-table">
          <thead>
            <tr>
              <th />
              <th>Wallet</th>
              <th>Deposit addr</th>
              <th>Balance</th>
              <th>In trades</th>
              <th>Volume</th>
              <th>Fees paid</th>
              <th>Funding paid</th>
              <th>P/L (realized)</th>
              <th>uP/L (unreal.)</th>
              <th>Deposits</th>
              <th>Withdrawals</th>
              <th>Pending</th>
              <th>Open</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const open = c.openPositions > 0;
              const pos = positions[c.userId];
              return (
                <Fragment key={c.userId}>
                  <tr className={expanded === c.userId ? 'cust-row-open' : ''}>
                    <td
                      className="cust-caret"
                      style={{ cursor: open ? 'pointer' : 'default', opacity: open ? 1 : 0.25 }}
                      onClick={() => open && toggle(c.userId)}
                    >
                      {open ? (expanded === c.userId ? '▾' : '▸') : ''}
                    </td>
                    <td className="addr" title={c.pubkey} onClick={() => copy(c.pubkey)}>
                      {copied && copied === c.pubkey ? 'copied!' : short(c.pubkey)}
                    </td>
                    <td className="addr" title={c.depositAddress || ''} onClick={() => copy(c.depositAddress)}>
                      {copied && copied === c.depositAddress ? 'copied!' : short(c.depositAddress)}
                    </td>
                    <td className="num">{usd(c.freeE6)}</td>
                    <td className="num">{usd(c.lockedE6)}</td>
                    <td className="num">{usd(c.volumeE6)}</td>
                    <td className="num">{usd(c.feesE6)}</td>
                    <td className="num">{usd(c.fundingPaidE6)}</td>
                    <td className="num" style={signed(c.pnlE6)}>{formatSignedUsd(c.pnlE6)}</td>
                    <td className="num" style={signed(c.upnlE6)}>{formatSignedUsd(c.upnlE6)}</td>
                    <td className="num">{usd(c.depositsE6)}</td>
                    <td className="num">{usd(c.withdrawalsE6)}</td>
                    <td className="num">{usd(c.pendingWithdrawalsE6)}</td>
                    <td className="num">{c.openPositions}</td>
                    <td>{(c.joinedAt || '').slice(0, 10)}</td>
                  </tr>
                  {expanded === c.userId && (
                    <tr className="cust-expand">
                      <td />
                      <td colSpan={COLS - 1}>
                        {pos === 'loading' && <span className="muted">loading positions…</span>}
                        {Array.isArray(pos) && pos.length === 0 && <span className="muted">No open positions.</span>}
                        {Array.isArray(pos) && pos.length > 0 && (
                          <table className="cust-subtable">
                            <thead>
                              <tr>
                                <th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th>
                                <th>uP/L</th><th>Margin</th><th>Liq</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pos.map((p) => (
                                <tr key={p.id}>
                                  <td>{p.symbol}</td>
                                  <td className={p.side === 'long' ? 'up' : 'down'}>{p.side.toUpperCase()} {p.leverage}x</td>
                                  <td className="num">{(Number(p.qtyE6) / 1e6).toFixed(2)}</td>
                                  <td className="num">{usd(p.avgEntryE6)}</td>
                                  <td className="num">{usd(p.markE6)}</td>
                                  <td className="num" style={signed(p.unrealizedPnlUusdc)}>{formatSignedUsd(p.unrealizedPnlUusdc)}</td>
                                  <td className="num">{usd(p.marginUusdc)}</td>
                                  <td className="num down">{usd(p.liqPriceE6)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={COLS} className="muted" style={{ textAlign: 'center', padding: '1rem' }}>
                  No customers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginTop: '0.6rem' }}>
        <button className="btn-ghost sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          ← Prev
        </button>
        <span className="muted" style={{ fontSize: '0.78rem' }}>
          Page {page} / {pages}
        </span>
        <button className="btn-ghost sm" disabled={page >= pages} onClick={() => setOffset(offset + PAGE)}>
          Next →
        </button>
        {loading && (
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            loading…
          </span>
        )}
      </div>
    </div>
  );
}
