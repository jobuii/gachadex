import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { formatUsd, formatSignedUsd, shortenPubkey } from '@pokex/pricing';
import * as api from '../lib/api.js';

// Operator "Customers" tab: one row per user, paginated + sortable, each expandable to its open
// positions per market. Renders inside the AdminPanel (monospace data font + access gate); takes the
// verified admin key as a prop. `onGoToMarket(marketId)` jumps the exchange to a position's market.
const PAGE = 50;
const SORTS = [
  ['volume', 'Volume'],
  ['fees', 'Fees'],
  ['free', 'Balance'],
  ['locked', 'In trades'],
  ['pnl', 'Realized P/L'],
  ['tips', 'Tips'],
  ['joined', 'Joined'],
];
const COLS = 17; // table width (for the expand-row + empty-state colSpan)
const KILL_PHRASE = 'CLOSE ALL';

const short = (a) => shortenPubkey(a) || '—';
const usd = (e6) => formatUsd(BigInt(e6 ?? 0)); // ?? 0 guards against an older API missing the new fields
const signed = (e6) => ({ color: BigInt(e6 ?? 0) < 0n ? 'var(--danger)' : 'var(--success)' });

export function CustomersView({ adminKey, onGoToMarket }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState('volume');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(null);
  const [expanded, setExpanded] = useState(null); // userId currently expanded
  const [positions, setPositions] = useState({}); // userId -> positions[] | 'loading'
  const [busy, setBusy] = useState(null); // positionId | 'user:<id>' | 'all' | 'liquidate' — action in flight
  const [note, setNote] = useState(null); // action feedback line
  const [killOpen, setKillOpen] = useState(false); // global kill-switch confirmation modal
  const [killText, setKillText] = useState('');

  const reqSeq = useRef(0); // ignore a slow response that resolves after a newer fetch (rapid sort/page)
  const loadCustomers = useCallback(() => {
    const seq = ++reqSeq.current;
    setLoading(true);
    return api
      .adminGetCustomers({ limit: PAGE, offset, sort }, adminKey)
      .then((r) => {
        if (seq !== reqSeq.current) return;
        setRows(r.customers || []);
        setTotal(r.total || 0);
        setErr(null);
      })
      .catch((e) => seq === reqSeq.current && setErr(e.message))
      .finally(() => seq === reqSeq.current && setLoading(false));
  }, [adminKey, offset, sort]);

  useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

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
      reloadUser(userId);
    }
  };

  const reloadUser = (userId) =>
    api
      .adminGetCustomerPositions(userId, adminKey)
      .then((r) => setPositions((p) => ({ ...p, [userId]: r.positions || [] })))
      .catch(() => setPositions((p) => ({ ...p, [userId]: [] })));

  // One busy/feedback skeleton for every close action; fn returns the note line to show.
  const runAction = async (busyKey, fn) => {
    setBusy(busyKey);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      setNote(`Failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };
  // Summarize a multi-close result, calling out liquidatable failures (the engine routes those through
  // auto-liquidation rather than a voluntary close — they're not a real error).
  const summarize = (r) => {
    if (!r.failed) return `closed ${r.closed}`;
    const liq = (r.errors || []).filter((e) => /liquidat/i.test(e.error)).length;
    const liqHint = liq ? `, ${liq} liquidatable (will auto-liquidate)` : '';
    return `closed ${r.closed}, failed ${r.failed}${liqHint}`;
  };

  // Close one position (full). Recorded server-side as a platform close.
  const closeOne = (userId, p) => {
    if (!window.confirm(`Close ${p.displayName || p.symbol} — ${p.side} ${p.leverage}x — for this customer?\nThis is recorded as a manual close by the platform.`)) return;
    runAction(p.id, async () => {
      await api.adminClosePosition(userId, p.id, adminKey);
      await reloadUser(userId);
      loadCustomers();
      return `Closed ${p.displayName || p.symbol}.`;
    });
  };

  // Close ALL of one customer's positions.
  const closeUser = (userId, n) => {
    if (!window.confirm(`Close ALL ${n} open position(s) for this customer?\nRecorded as manual closes by the platform.`)) return;
    runAction('user:' + userId, async () => {
      const r = await api.adminCloseUserPositions(userId, adminKey);
      await reloadUser(userId);
      loadCustomers();
      return `Customer close-all: ${summarize(r)}.`;
    });
  };

  // EMERGENCY: liquidate every underwater position now (what the auto-sweep would do, on demand).
  // Complements close-all, which skips liquidatable positions. Confirm-gated (less catastrophic than
  // the kill switch — these positions are already underwater and would auto-liquidate anyway).
  const liquidateNow = () => {
    if (!window.confirm('Liquidate ALL underwater positions across every market NOW?\nThese are positions already past their liquidation price — this just does it immediately instead of waiting for the auto-sweep (loss-capped + penalized exactly the same).')) return;
    return runAction('liquidate', async () => {
      const r = await api.adminLiquidateAll(adminKey);
      setExpanded(null);
      setPositions({});
      loadCustomers();
      return `Liquidated ${r.liquidated} underwater position(s) across ${r.markets} markets.`;
    });
  };

  // EMERGENCY: close every open position across all customers (gated by the typed-phrase modal).
  const closeAllGlobal = () =>
    runAction('all', async () => {
      const r = await api.adminCloseAllPositions(adminKey);
      setKillOpen(false);
      setKillText('');
      setExpanded(null);
      setPositions({}); // drop cached expansions; they're stale now
      loadCustomers();
      return `Kill switch: ${summarize(r)}.`;
    });

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginTop: '1rem' }}>
        <h3 style={{ margin: 0 }}>Customers ({total})</h3>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <button
            className="btn-ghost sm"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
            disabled={busy != null}
            onClick={liquidateNow}
          >
            {busy === 'liquidate' ? 'liquidating…' : '⚠ Liquidate underwater now'}
          </button>
          <button
            className="btn-ghost sm"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
            disabled={busy != null}
            onClick={() => { setKillText(''); setKillOpen(true); }}
          >
            ⚠ Close ALL positions (all customers)
          </button>
        </div>
      </div>
      <p className="ref-blurb">
        One row per user. Sort with the buttons; click a wallet/deposit address to copy it; click the ▸ to
        expand a customer's open positions per market — from there you can jump to a market, close a single
        position, or close all of that customer's positions. <strong>P/L</strong> is realized; <strong>uP/L</strong> is unrealized.
      </p>
      {err && <div className="order-error">{err}</div>}
      {note && <div className="ref-blurb" style={{ color: 'var(--text)' }}>{note}</div>}

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
              <th>LP Pool</th>
              <th>In trades</th>
              <th>Volume</th>
              <th>Fees paid</th>
              <th>Funding paid</th>
              <th>P/L (realized)</th>
              <th>uP/L (unreal.)</th>
              <th>Deposits</th>
              <th>Tips</th>
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
                    <td className="num">{usd(c.lpE6)}</td>
                    <td className="num">{usd(c.lockedE6)}</td>
                    <td className="num">{usd(c.volumeE6)}</td>
                    <td className="num">{usd(c.feesE6)}</td>
                    <td className="num">{usd(c.fundingPaidE6)}</td>
                    <td className="num" style={signed(c.pnlE6)}>{formatSignedUsd(c.pnlE6)}</td>
                    <td className="num" style={signed(c.upnlE6)}>{formatSignedUsd(c.upnlE6)}</td>
                    <td className="num">{usd(c.depositsE6)}</td>
                    <td className="num">{usd(c.tippedE6)}</td>
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
                          <>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.35rem' }}>
                              <button
                                className="btn-ghost sm"
                                style={{ color: 'var(--danger)' }}
                                disabled={busy != null}
                                onClick={() => closeUser(c.userId, pos.length)}
                              >
                                {busy === 'user:' + c.userId ? 'closing…' : `Close all ${pos.length} positions`}
                              </button>
                            </div>
                            <table className="cust-subtable">
                              <thead>
                                <tr>
                                  <th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th>
                                  <th>uP/L</th><th>Margin</th><th>Liq</th><th />
                                </tr>
                              </thead>
                              <tbody>
                                {pos.map((p) => (
                                  <tr key={p.id}>
                                    <td>
                                      <button
                                        className="link-btn"
                                        title={`Go to ${p.displayName || p.symbol}`}
                                        onClick={() => onGoToMarket?.(p.marketId)}
                                      >
                                        {p.displayName || p.symbol}
                                      </button>
                                    </td>
                                    <td className={p.side === 'long' ? 'up' : 'down'}>{p.side.toUpperCase()} {p.leverage}x</td>
                                    <td className="num">{(Number(p.qtyE6) / 1e6).toFixed(2)}</td>
                                    <td className="num">{usd(p.avgEntryE6)}</td>
                                    <td className="num">{usd(p.markE6)}</td>
                                    <td className="num" style={signed(p.unrealizedPnlUusdc)}>{formatSignedUsd(p.unrealizedPnlUusdc)}</td>
                                    <td className="num">{usd(p.marginUusdc)}</td>
                                    <td className="num down">{usd(p.liqPriceE6)}</td>
                                    <td>
                                      <button className="btn-ghost sm" disabled={busy != null} onClick={() => closeOne(c.userId, p)}>
                                        {busy === p.id ? '…' : 'Close'}
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </>
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

      {killOpen && (
        <div className="modal-backdrop" onClick={() => busy !== 'all' && setKillOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, color: 'var(--danger)' }}>⚠ Emergency: close ALL positions</h3>
            <p className="ref-blurb">
              This force-closes <strong>every open position across ALL customers</strong> at the current mark,
              recorded as platform closes. This cannot be undone. Use only in a genuine emergency. Positions
              already underwater are flattened by the auto-liquidation sweep, not this button (they'll show as
              "liquidatable" in the result).
            </p>
            <p className="ref-blurb">
              Type <strong>{KILL_PHRASE}</strong> to confirm:
            </p>
            <input
              className="wallet-input"
              value={killText}
              onChange={(e) => setKillText(e.target.value)}
              placeholder={KILL_PHRASE}
              style={{ width: '100%', marginBottom: '0.6rem' }}
            />
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button className="btn-ghost sm" disabled={busy === 'all'} onClick={() => setKillOpen(false)}>
                Cancel
              </button>
              <button
                className="btn-primary sm"
                style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
                disabled={killText.trim() !== KILL_PHRASE || busy === 'all'}
                onClick={closeAllGlobal}
              >
                {busy === 'all' ? 'closing…' : 'Close ALL positions'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
