import { useEffect, useState } from 'react';
import { formatUsd, formatSignedUsd, shortenPubkey } from '@pokex/pricing';
import * as api from '../lib/api.js';

// Operator "Customers" tab: one row per user, paginated + sortable. Renders inside the AdminPanel
// (which provides the monospace data font + access gate); takes the verified admin key as a prop.
const PAGE = 50;
const SORTS = [
  ['volume', 'Volume'],
  ['fees', 'Fees'],
  ['free', 'Balance'],
  ['locked', 'In trades'],
  ['pnl', 'P/L'],
  ['joined', 'Joined'],
];

const short = (a) => shortenPubkey(a) || '—';
const usd = (e6) => formatUsd(BigInt(e6));

export function CustomersView({ adminKey }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState('volume');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(null);

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

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <div>
      <h3 style={{ marginTop: '1rem' }}>Customers ({total})</h3>
      <p className="ref-blurb">One row per user. Sort with the buttons; click a wallet or deposit address to copy it.</p>
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
              <th>Wallet</th>
              <th>Deposit addr</th>
              <th>Balance</th>
              <th>In trades</th>
              <th>Volume</th>
              <th>Fees paid</th>
              <th>P/L</th>
              <th>Open</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.userId}>
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
                <td className="num" style={{ color: BigInt(c.pnlE6) < 0n ? 'var(--danger)' : 'var(--success)' }}>
                  {formatSignedUsd(c.pnlE6)}
                </td>
                <td className="num">{c.openPositions}</td>
                <td>{(c.joinedAt || '').slice(0, 10)}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: '1rem' }}>
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
