import { useState, useEffect, useCallback } from 'react';
import { formatUsd, toE6 } from '@pokex/pricing';
import * as api from '../lib/api.js';

/**
 * Operator manual-pricing panel (ROADMAP §2). Reached at #admin — not in the public nav.
 * Authenticates with the ADMIN_API_KEY (held locally), sets a market's price by hand (e.g. from
 * eBay sold listings), and pins it so the automated feed won't overwrite it until unpinned.
 */
const KEY_STORE = 'gachadex_admin_key';

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
    <div className="ins-stat" style={{ minWidth: 130 }}>
      <div className="muted" style={{ fontSize: '0.72rem' }}>{label}</div>
      <div style={{ fontWeight: 600 }}>{value != null ? formatUsd(BigInt(value)) : '—'}</div>
    </div>
  );
}

export function AdminPanel() {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(KEY_STORE) || '');
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

  const load = useCallback(async () => {
    try {
      const { markets: m } = await api.getMarkets();
      setMarkets(m);
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  // Operator endpoints (treasury + insurance). Only fire once the key looks complete (>=32 chars),
  // so we don't 401 on every keystroke. /admin/treasury is real-funds-only — fall back to the bare
  // insurance balance in play-money mode.
  const loadOps = useCallback(async () => {
    if (adminKey.trim().length < 32) return;
    try {
      const t = await api.adminGetTreasury(adminKey.trim());
      setTreasury(t);
      setInsuranceE6(t.insuranceE6);
    } catch {
      setTreasury(null);
      try {
        setInsuranceE6((await api.adminGetInsurance(adminKey.trim())).insuranceUusdc);
      } catch {
        /* key not valid yet */
      }
    }
    // Custody limits are real-funds-only (same gate as treasury); null in play-money.
    try {
      setCustodyLimits(await api.adminGetCustodyLimits(adminKey.trim()));
    } catch {
      setCustodyLimits(null);
    }
  }, [adminKey]);
  useEffect(() => {
    loadOps();
  }, [loadOps]);

  const saveKey = () => {
    localStorage.setItem(KEY_STORE, adminKey.trim());
    setMsg('Admin key saved on this device.');
    setErr(null);
    loadOps();
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

  return (
    <div className="page admin-panel">
      <h2>Operator</h2>
      <p className="ref-blurb">
        Operator-only tools. Authenticated with your <code>ADMIN_API_KEY</code>; it never leaves this device.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', margin: '0.5rem 0', maxWidth: 520 }}>
        <input
          className="wallet-input"
          type="password"
          placeholder="ADMIN_API_KEY"
          value={adminKey}
          onChange={(e) => setAdminKey(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="btn-secondary" onClick={saveKey}>Save key</button>
      </div>

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}

      <h3 style={{ marginTop: '1.25rem' }}>Treasury &amp; insurance</h3>
      <p className="ref-blurb">
        The insurance fund absorbs liquidation bad-debt before it reaches LPs. Top it up from house
        money — accumulated platform fees, or surplus you've sent to the treasury wallet. (It also
        auto-fills from the 1% liquidation fee.)
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', margin: '0.5rem 0' }}>
        <Stat label="Insurance fund" value={insuranceE6} />
        {treasury && (
          <>
            <Stat label="Treasury surplus (allocatable)" value={treasury.surplusE6} />
            <Stat label="On-chain reserves" value={treasury.onchainE6} />
            <Stat label="Liabilities" value={treasury.liabilityE6} />
            <Stat label="Hot wallet" value={treasury.hotE6} />
            <Stat label="Cold treasury" value={treasury.coldE6} />
          </>
        )}
      </div>
      {!treasury && (
        <div className="muted" style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
          Enter your admin key to load balances. Treasury balances + the “from treasury” allocation appear in
          real-funds mode; fee allocation works in either mode.
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.35rem 0', flexWrap: 'wrap' }}>
        <input
          className="wallet-input"
          type="number"
          min="0"
          step="0.01"
          placeholder="USD"
          value={feesDraft}
          onChange={(e) => setFeesDraft(e.target.value)}
          style={{ width: 120 }}
        />
        <button
          className="btn-primary sm"
          disabled={busy === 'ins' || !adminKey}
          onClick={() => allocate(api.adminInsuranceFromFees, feesDraft, setFeesDraft, 'From fees → insurance')}
        >
          {busy === 'ins' ? '…' : 'Allocate from fees'}
        </button>
        <button
          className="btn-ghost sm"
          disabled={busy === 'ins' || !adminKey}
          onClick={() => allocate(api.adminInsuranceToFees, feesDraft, setFeesDraft, 'Insurance → fees')}
        >
          Return to fees
        </button>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.35rem 0', flexWrap: 'wrap' }}>
        <input
          className="wallet-input"
          type="number"
          min="0"
          step="0.01"
          placeholder="USD"
          value={treasDraft}
          onChange={(e) => setTreasDraft(e.target.value)}
          style={{ width: 120 }}
          disabled={!treasury}
        />
        <button
          className="btn-primary sm"
          disabled={busy === 'ins' || !adminKey || !treasury}
          onClick={() => allocate(api.adminInsuranceFromTreasury, treasDraft, setTreasDraft, 'From treasury → insurance')}
        >
          {busy === 'ins' ? '…' : 'Allocate from treasury surplus'}
        </button>
        <span className="muted" style={{ fontSize: '0.8rem' }}>send USDC to the treasury wallet first</span>
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
