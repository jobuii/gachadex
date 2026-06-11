import { useState, useEffect, useCallback } from 'react';
import { formatUsd, toE6, shortenPubkey } from '@pokex/pricing';
import * as api from '../lib/api.js';

/**
 * Operator manual-pricing panel (ROADMAP §2). Reached at #admin — not in the public nav.
 * Authenticates with the ADMIN_API_KEY (held locally), sets a market's price by hand (e.g. from
 * eBay sold listings), and pins it so the automated feed won't overwrite it until unpinned.
 */
const KEY_STORE = 'gachadex_admin_key';
const MIN_KEY_LEN = 32; // ADMIN_API_KEY floor — mirrors the server's length requirement (config.ts)

// Live-tunable custody limits surfaced in the panel: [key, label, unit].
const LIMIT_FIELDS = [
  ['hotWalletMaxUsd', 'Hot wallet cap', 'USD'],
  ['hotWalletFloorPct', 'Hot wallet floor (% of cap)', '%'],
  ['withdrawalDailyCapUsd', 'Withdrawal daily cap / user', 'USD'],
  ['withdrawalAutoApproveMaxUsd', 'Auto-approve max', 'USD'],
  ['minWithdrawalUsd', 'Min withdrawal', 'USD'],
  ['minDepositUsd', 'Min deposit', 'USD'],
  ['minSweepUsd', 'Min sweep', 'USD'],
  ['swapSlippageBps', 'Swap slippage', 'bps'],
];

function Stat({ label, value }) {
  return (
    <div className="admin-stat">
      <div className="lbl">{label}</div>
      <div className="val">{value != null ? formatUsd(BigInt(value)) : '—'}</div>
    </div>
  );
}

// Profit/loss stat — green when the house is up, red when down (handles negative bigints explicitly).
function PnlStat({ label, value }) {
  const v = BigInt(value);
  const neg = v < 0n;
  return (
    <div className={`admin-stat ${neg ? 'pnl-down' : 'pnl-up'}`}>
      <div className="lbl">{label}</div>
      <div className="val">{neg ? '-' : ''}{formatUsd(neg ? -v : v)}</div>
    </div>
  );
}

export function AdminPanel() {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(KEY_STORE) || '');
  // Access gate: nothing in the panel renders or fetches until the key is verified by the server.
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(() => (localStorage.getItem(KEY_STORE) || '').trim().length >= MIN_KEY_LEN);
  const [verifying, setVerifying] = useState(false);
  const [markets, setMarkets] = useState([]);
  const [drafts, setDrafts] = useState({}); // marketId -> price string (USD)
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(null);
  const [forceId, setForceId] = useState(null); // a row whose last set tripped the fat-finger guard
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [treasury, setTreasury] = useState(null); // full PoR view (real-funds); null in play-money
  const [insuranceE6, setInsuranceE6] = useState(null); // insurance balance (works in both modes)
  const [feesDraft, setFeesDraft] = useState('');
  const [treasDraft, setTreasDraft] = useState('');
  const [custodyLimits, setCustodyLimits] = useState(null); // { current, defaults } | null (real-funds only)
  const [limitDrafts, setLimitDrafts] = useState({}); // limit key -> string
  const [fee, setFeeState] = useState(null); // { bps, default } | null — trading fee (works in both modes)
  const [feeDraft, setFeeDraft] = useState(''); // operator enters a PERCENT (0.01 = 0.01%)
  const [withdrawals, setWithdrawals] = useState([]); // requested withdrawal queue (real-funds)
  const [wbusy, setWbusy] = useState(null); // withdrawal id being approved/reversed

  // Validate the key against a key-gated endpoint (GET /admin/insurance — registered whenever an admin
  // key is set, in either mode; adminGet throws on any non-2xx). A 200 is the only thing that unlocks.
  const verifyKey = useCallback(async (key) => {
    const k = (key ?? '').trim();
    if (k.length < MIN_KEY_LEN) return false;
    try {
      await api.adminGetInsurance(k);
      return true;
    } catch {
      return false;
    }
  }, []);

  // On mount, silently re-check a key already saved on this device (no flash of the unlock form).
  useEffect(() => {
    verifyKey(localStorage.getItem(KEY_STORE) || '')
      .then((ok) => setAuthed(ok))
      .finally(() => setChecking(false));
  }, [verifyKey]);

  const load = useCallback(async () => {
    try {
      const { markets: m } = await api.getMarkets();
      setMarkets(m);
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  // Nothing fetches until unlocked — markets + operator data load only once authed.
  useEffect(() => {
    if (!authed) return;
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [authed, load]);

  // Operator endpoints (treasury + insurance). /admin/treasury is real-funds-only — fall back to the
  // bare insurance balance in play-money mode.
  const loadOps = useCallback(async () => {
    if (!authed) return;
    const key = adminKey.trim();
    // The four groups are independent — fetch them concurrently. Each self-guards, so one failing
    // endpoint (e.g. the real-funds-only ones in play money) never aborts the others.
    await Promise.all([
      // Treasury (real-funds, chain-backed) with a bare-insurance fallback for play money.
      (async () => {
        try {
          const t = await api.adminGetTreasury(key);
          setTreasury(t);
          setInsuranceE6(t.insuranceE6);
        } catch {
          setTreasury(null);
          try {
            setInsuranceE6((await api.adminGetInsurance(key)).insuranceUusdc);
          } catch {
            /* endpoint unavailable in this mode */
          }
        }
      })(),
      (async () => {
        try {
          setCustodyLimits(await api.adminGetCustodyLimits(key)); // real-funds-only; null in play-money
        } catch {
          setCustodyLimits(null);
        }
      })(),
      (async () => {
        try {
          setFeeState(await api.adminGetFee(key)); // works in either mode
        } catch {
          setFeeState(null);
        }
      })(),
      (async () => {
        try {
          setWithdrawals((await api.adminGetWithdrawals('requested', key)).withdrawals || []); // real-funds-only
        } catch {
          setWithdrawals([]);
        }
      })(),
    ]);
  }, [authed, adminKey]);
  // Poll the operator data (treasury, fee, withdrawals queue) while the panel is open, so balances
  // and new withdrawals appear live — not just after an action triggers a reload.
  useEffect(() => {
    if (!authed) return;
    loadOps();
    // 30s (not 15s) — adminGetTreasury reads hot/cold balances from the chain RPC each pass.
    const t = setInterval(loadOps, 30_000);
    return () => clearInterval(t);
  }, [authed, loadOps]);

  // Unlock: verify the entered key against the server; persist + reveal the panel only on success.
  const unlock = async () => {
    setErr(null);
    setMsg(null);
    setVerifying(true);
    try {
      if (await verifyKey(adminKey)) {
        localStorage.setItem(KEY_STORE, adminKey.trim());
        setAuthed(true);
      } else {
        setErr('Invalid admin key — access denied.');
      }
    } finally {
      setVerifying(false);
    }
  };

  // Lock: forget the key on this device and re-gate everything.
  const lock = () => {
    localStorage.removeItem(KEY_STORE);
    setAdminKey('');
    setAuthed(false);
    setMarkets([]);
    setTreasury(null);
    setInsuranceE6(null);
    setCustodyLimits(null);
    setFeeState(null);
    setWithdrawals([]);
    setMsg(null);
    setErr(null);
  };

  // Save any edited custody limits (blank fields are left unchanged).
  const saveLimits = async () => {
    setErr(null);
    setMsg(null);
    const payload = {};
    for (const [key] of LIMIT_FIELDS) {
      const v = limitDrafts[key];
      if (v !== undefined && v !== '') payload[key] = Number(v);
    }
    if (Object.keys(payload).length === 0) {
      setErr('Change at least one limit.');
      return;
    }
    setBusy('limits');
    try {
      const { current } = await api.adminSetCustodyLimits(payload, adminKey.trim());
      setCustodyLimits((cv) => ({ ...cv, current })); // keep defaults, swap in the new current
      setLimitDrafts({});
      setMsg('Custody limits updated.');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  // Allocate house funds to/from the insurance buffer (fn is one of the api.adminInsurance* calls).
  const allocate = async (fn, draft, clearDraft, label) => {
    setErr(null);
    setMsg(null);
    const usd = Number(draft);
    if (!Number.isFinite(usd) || usd <= 0) {
      setErr('Enter a positive amount.');
      return;
    }
    setBusy('ins');
    try {
      const r = await fn(toE6(usd).toString(), adminKey.trim());
      setMsg(`${label}: insurance now ${formatUsd(BigInt(r.insuranceUusdc))}`);
      clearDraft('');
      loadOps();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  // Trading fee: the operator enters a PERCENT; we store bps (pct * 100, so 0.01% = 1 bps).
  const saveFee = async () => {
    setErr(null);
    setMsg(null);
    const pct = Number(feeDraft);
    if (!Number.isFinite(pct) || pct < 0) {
      setErr('Enter a fee percentage (e.g. 0.01 for 0.01%).');
      return;
    }
    setBusy('fee');
    try {
      const r = await api.adminSetFee(Math.round(pct * 100), adminKey.trim());
      setFeeState(r);
      setFeeDraft('');
      setMsg(`Trading fee set to ${(r.bps / 100).toFixed(2)}% (charged on open + close).`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  // Approve = sign + broadcast the payout; reverse = re-credit a row that provably never paid.
  const approveWithdrawal = async (w) => {
    setErr(null);
    setMsg(null);
    setWbusy(w.id);
    try {
      const r = await api.adminApproveWithdrawal(w.id, adminKey.trim());
      setMsg(`Withdrawal ${w.id.slice(0, 8)} → ${r.status}.`);
      loadOps();
    } catch (e) {
      setErr(e.message);
    } finally {
      setWbusy(null);
    }
  };
  const reverseWithdrawal = async (w) => {
    const reason = window.prompt('Reason for reversing this withdrawal (it re-credits the user):');
    if (!reason || !reason.trim()) return;
    setErr(null);
    setMsg(null);
    setWbusy(w.id);
    try {
      await api.adminReverseWithdrawal(w.id, reason.trim(), adminKey.trim());
      setMsg(`Withdrawal ${w.id.slice(0, 8)} reversed — user re-credited.`);
      loadOps();
    } catch (e) {
      setErr(e.message);
    } finally {
      setWbusy(null);
    }
  };

  const setPrice = async (m, force = false) => {
    setErr(null);
    setMsg(null);
    const usd = Number(drafts[m.id]);
    if (!Number.isFinite(usd) || usd <= 0) {
      setErr('Enter a positive price.');
      return;
    }
    setBusy(m.id);
    try {
      const r = await api.adminSetPrice(
        m.id,
        { priceE6: toE6(usd).toString(), note: 'manual (admin panel)', force },
        adminKey.trim(),
      );
      setMsg(`${m.symbol} → ${formatUsd(BigInt(r.markE6))}${r.pinned ? ' (pinned)' : ''}`);
      setDrafts((d) => ({ ...d, [m.id]: '' }));
      setForceId(null);
      load();
    } catch (e) {
      setErr(e.message);
      if (/force/i.test(e.message)) setForceId(m.id); // offer a one-click override
    } finally {
      setBusy(null);
    }
  };

  const unpin = async (m) => {
    setBusy(m.id);
    setErr(null);
    setMsg(null);
    try {
      await api.adminUnpin(m.id, adminKey.trim());
      setMsg(`${m.symbol} unpinned — the automated feed will resume.`);
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const q = filter.trim().toLowerCase();
  const rows = markets.filter(
    (m) => !q || m.symbol.toLowerCase().includes(q) || (m.displayName || '').toLowerCase().includes(q),
  );
  // Dashboard figures derived once (only meaningful when treasury is loaded).
  const customerE6 = treasury ? BigInt(treasury.freeE6) + BigInt(treasury.lockedE6) : 0n;
  // P/L = on-chain treasury minus everything owed to customers. Pending withdrawals were debited from
  // customer collateral and are queued to pay out — still customer money in flight, NOT house profit —
  // so subtract them too (else P/L inflates by the pending amount until the payout lands).
  const pnlE6 = treasury ? BigInt(treasury.onchainE6) - customerE6 - BigInt(treasury.pendingE6) : 0n;

  // Verifying a saved key on mount — render nothing operational until we know it's valid.
  if (checking) {
    return (
      <div className="page admin-panel">
        <h2>Operator</h2>
        <p className="ref-blurb">Verifying access…</p>
      </div>
    );
  }

  // Locked: the ONLY thing rendered until a valid key is entered. No data is fetched behind this.
  if (!authed) {
    return (
      <div className="page admin-panel">
        <h2>Operator</h2>
        <p className="ref-blurb">
          Restricted area. Enter your <code>ADMIN_API_KEY</code> to continue — nothing on this page loads until
          the key is verified by the server. It's stored only on this device.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', margin: '0.75rem 0', maxWidth: 520 }}>
          <input
            className="wallet-input"
            type="password"
            placeholder="ADMIN_API_KEY"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !verifying && unlock()}
            autoFocus
            style={{ flex: 1 }}
          />
          <button className="btn-primary" disabled={verifying} onClick={unlock}>
            {verifying ? 'Verifying…' : 'Unlock'}
          </button>
        </div>
        {err && <div className="order-error">{err}</div>}
      </div>
    );
  }

  return (
    <div className="page admin-panel">
      <h2>Operator</h2>
      <p className="ref-blurb">
        Operator-only tools. Authenticated with your <code>ADMIN_API_KEY</code>; it never leaves this device.
      </p>

      <div className="admin-unlocked">
        <span className="who">🔓 Unlocked on this device</span>
        <button className="admin-lock-btn" onClick={lock}>Lock</button>
      </div>

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}

      {/* ---- Overview dashboard ---- */}
      <h3 style={{ marginTop: '1rem' }}>Overview</h3>
      {treasury ? (
        <div className="admin-stats">
          <Stat label="Total treasury (hot + cold)" value={treasury.onchainE6} />
          <Stat label="Hot balance" value={treasury.hotE6} />
          <Stat label="Cold treasury" value={treasury.coldE6} />
          <Stat label="Total customer balance" value={customerE6.toString()} />
          <Stat label="…free" value={treasury.freeE6} />
          <Stat label="…locked in trades" value={treasury.lockedE6} />
          <Stat label="Pending withdrawals" value={treasury.pendingE6} />
          <Stat label="Insurance fund" value={treasury.insuranceE6} />
          <PnlStat label="P/L (treasury − customer funds − pending payouts)" value={pnlE6.toString()} />
        </div>
      ) : (
        <p className="ref-blurb">Live treasury balances appear in real-funds mode (this deployment is play money).</p>
      )}

      {/* ---- Withdrawals queue ---- */}
      <h3 style={{ marginTop: '1.25rem' }}>Withdrawals queue</h3>
      <p className="ref-blurb">
        Pending withdrawals awaiting approval.{' '}
        <span style={{ color: 'var(--success)' }}>Green</span> rows go to the user's own sign-in wallet (lower risk).
        Approve signs + broadcasts the payout; reverse re-credits a row that never paid out.
      </p>
      {treasury ? (
        <table className="hist-table">
          <thead>
            <tr><th>Owner wallet</th><th>Destination</th><th>Amount</th><th>Requested</th><th /></tr>
          </thead>
          <tbody>
            {withdrawals.length === 0 && (
              <tr><td colSpan={5} className="hist-empty">No withdrawals in the queue.</td></tr>
            )}
            {withdrawals.map((w) => {
              const self = w.dest_address && w.dest_address === w.pubkey;
              return (
                <tr key={w.id} style={self ? { background: 'color-mix(in srgb, var(--success) 14%, transparent)' } : undefined}>
                  <td className="muted" title={w.pubkey}>{shortenPubkey(w.pubkey)}</td>
                  <td title={w.dest_address}>
                    {shortenPubkey(w.dest_address)}
                    {self && <span style={{ color: 'var(--success)', marginLeft: 6, fontSize: '0.72rem' }}>● self</span>}
                  </td>
                  <td>{formatUsd(BigInt(w.amount_e6))}</td>
                  <td className="muted">{w.requested_at ? new Date(w.requested_at).toLocaleString() : '—'}</td>
                  <td>
                    <button className="btn-primary sm" disabled={wbusy === w.id} onClick={() => approveWithdrawal(w)}>
                      {wbusy === w.id ? '…' : 'Approve'}
                    </button>
                    <button className="btn-ghost sm" disabled={wbusy === w.id} onClick={() => reverseWithdrawal(w)}>
                      Reverse
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="ref-blurb">The withdrawal queue appears in real-funds mode.</p>
      )}

      {/* ---- Insurance fund ---- */}
      <h3 style={{ marginTop: '1.25rem' }}>Insurance fund</h3>
      <p className="ref-blurb">
        A buffer that absorbs bad debt from liquidations <strong>before it reaches LP funds</strong>. It auto-fills from
        the liquidation penalty; you can also top it up from house money below. Current balance:{' '}
        <strong>{insuranceE6 != null ? formatUsd(BigInt(insuranceE6)) : '—'}</strong>.
      </p>
      <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
        Move collected trading fees ↔ insurance
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.3rem 0 0.6rem', flexWrap: 'wrap' }}>
          <input
            className="wallet-input" type="number" min="0" step="0.01" placeholder="Amount (USD)"
            value={feesDraft} onChange={(e) => setFeesDraft(e.target.value)} style={{ width: 150 }}
          />
          <button className="btn-primary sm" disabled={busy === 'ins'}
            onClick={() => allocate(api.adminInsuranceFromFees, feesDraft, setFeesDraft, 'Fees → insurance')}>
            {busy === 'ins' ? '…' : 'Fees → insurance'}
          </button>
          <button className="btn-ghost sm" disabled={busy === 'ins'}
            onClick={() => allocate(api.adminInsuranceToFees, feesDraft, setFeesDraft, 'Insurance → fees')}>
            Insurance → fees
          </button>
        </div>
      </label>
      {treasury && (
        <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          Move treasury surplus → insurance  (surplus = on-chain USDC above what you owe; send the extra USDC to the treasury wallet first)
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.3rem 0', flexWrap: 'wrap' }}>
            <input
              className="wallet-input" type="number" min="0" step="0.01" placeholder="Amount (USD)"
              value={treasDraft} onChange={(e) => setTreasDraft(e.target.value)} style={{ width: 150 }}
            />
            <button className="btn-primary sm" disabled={busy === 'ins'}
              onClick={() => allocate(api.adminInsuranceFromTreasury, treasDraft, setTreasDraft, 'Treasury surplus → insurance')}>
              {busy === 'ins' ? '…' : 'Treasury surplus → insurance'}
            </button>
            <span className="muted" style={{ fontSize: '0.78rem' }}>allocatable now: {formatUsd(BigInt(treasury.surplusE6))}</span>
          </div>
        </label>
      )}

      {/* ---- Trading fee ---- */}
      <h3 style={{ marginTop: '1.25rem' }}>Trading fee</h3>
      <p className="ref-blurb">
        Commission on every trade — charged on <strong>both open and close</strong> — as a % of position size.
        Enter a percentage: <code>0.01</code> means 0.01%. Currently{' '}
        <strong>{fee ? `${(fee.bps / 100).toFixed(2)}%` : '—'}</strong>
        {fee ? ` (env default ${(fee.default / 100).toFixed(2)}%)` : ''}.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.35rem 0' }}>
        <input
          className="wallet-input" type="number" min="0" step="0.01" placeholder="0.01"
          value={feeDraft} onChange={(e) => setFeeDraft(e.target.value)} style={{ width: 120 }}
        />
        <span className="muted" style={{ fontSize: '0.85rem' }}>%</span>
        <button className="btn-primary sm" disabled={busy === 'fee'} onClick={saveFee}>
          {busy === 'fee' ? '…' : 'Save fee'}
        </button>
      </div>

      {custodyLimits && (
        <>
          <h3 style={{ marginTop: '1.25rem' }}>Custody limits</h3>
          <p className="ref-blurb">
            Live-tunable — saved to the database and applied without a redeploy. Leave a field blank to keep it;
            the placeholder shows the current value (default in parentheses).
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '0.6rem',
              maxWidth: 720,
              margin: '0.5rem 0',
            }}
          >
            {LIMIT_FIELDS.map(([key, label, unit]) => (
              <label key={key} style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {label} ({unit})
                <input
                  className="wallet-input"
                  type="number"
                  min="0"
                  step={unit === 'bps' ? '1' : '0.01'}
                  placeholder={`${custodyLimits.current[key]} (def ${custodyLimits.defaults[key]})`}
                  value={limitDrafts[key] ?? ''}
                  onChange={(e) => setLimitDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  style={{ width: '100%', marginTop: '0.2rem' }}
                />
              </label>
            ))}
          </div>
          <button className="btn-primary sm" disabled={busy === 'limits' || !adminKey} onClick={saveLimits}>
            {busy === 'limits' ? '…' : 'Save custody limits'}
          </button>
        </>
      )}

      <h3 style={{ marginTop: '1.25rem' }}>Manual pricing</h3>
      <p className="ref-blurb">
        Set a market's price by hand (e.g. from eBay sold listings or other sources without an API).
        Setting a price <strong>pins</strong> the market so the automated feed won't overwrite it until you unpin.
      </p>

      <input
        className="wallet-input"
        placeholder="Filter by symbol or name"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ maxWidth: 320, margin: '0.5rem 0' }}
      />

      <table className="hist-table">
        <thead>
          <tr>
            <th>Symbol</th><th>Name</th><th>Kind</th><th>Mark</th><th>Index</th><th>Pinned</th>
            <th>Set price (USD)</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="hist-empty">No markets.</td></tr>}
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{m.symbol}</td>
              <td>{m.displayName}</td>
              <td className="muted">{m.kind}</td>
              <td>{m.markE6 ? formatUsd(BigInt(m.markE6)) : '—'}</td>
              <td>{m.indexE6 ? formatUsd(BigInt(m.indexE6)) : '—'}</td>
              <td className={m.pricePinned ? 'up' : 'muted'}>{m.pricePinned ? 'PINNED' : '—'}</td>
              <td>
                <input
                  className="wallet-input"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={drafts[m.id] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                  style={{ width: 110 }}
                />
              </td>
              <td>
                <button className="btn-primary sm" disabled={busy === m.id || !adminKey} onClick={() => setPrice(m)}>
                  {busy === m.id ? '…' : 'Set'}
                </button>
                {forceId === m.id && (
                  <button className="btn-ghost sm" disabled={busy === m.id} onClick={() => setPrice(m, true)}>
                    Force
                  </button>
                )}
                {m.pricePinned && (
                  <button className="btn-ghost sm" disabled={busy === m.id} onClick={() => unpin(m)}>
                    Unpin
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
