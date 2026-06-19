import { useState, useEffect, useCallback } from 'react';
import { formatUsd, formatSignedUsd, toE6, shortenPubkey } from '@pokex/pricing';
import * as api from '../lib/api.js';
import { CustomersView } from './CustomersView.jsx';
import { ChatAdminView } from './ChatAdminView.jsx';
import { Stat, PnlStat } from './adminStats.jsx';

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


export function AdminPanel({ onGoToMarket } = {}) {
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
  const [economics, setEconomics] = useState(null); // ledger-derived house economics (both fund modes)
  const [insuranceE6, setInsuranceE6] = useState(null); // insurance balance (works in both modes)
  const [feesDraft, setFeesDraft] = useState('');
  const [treasDraft, setTreasDraft] = useState('');
  const [custodyLimits, setCustodyLimits] = useState(null); // { current, defaults } | null (real-funds only)
  const [limitDrafts, setLimitDrafts] = useState({}); // limit key -> string
  const [fee, setFeeState] = useState(null); // { bps, default } | null — trading fee (works in both modes)
  const [feeDraft, setFeeDraft] = useState(''); // operator enters a PERCENT (0.01 = 0.01%)
  const [liqFee, setLiqFeeState] = useState(null); // { bps, default } | null — liquidation penalty
  const [liqFeeDraft, setLiqFeeDraft] = useState('');
  const [fundingFactor, setFundingFactorState] = useState(null); // { bps, default } | null — max hourly funding rate
  const [fundingDraft, setFundingDraft] = useState(''); // operator enters a PERCENT (0.30 = 0.30%/hour)
  const [markClamp, setMarkClampState] = useState(null); // { bps, default } | null — §6a mark-guard clamp
  const [markClampDraft, setMarkClampDraft] = useState(''); // operator enters a PERCENT (25 = 25%/update)
  const [withdrawalAuto, setWithdrawalAuto] = useState(null); // { enabled, default } | null — auto-withdrawal toggle
  const [stats, setStats] = useState(null); // { markets: [...], totals } | null — per-asset trading stats
  const [restrictions, setRestrictions] = useState(null); // { restricted:[...], flippedToday:[...] } | null — price-confidence gate
  const [markGuards, setMarkGuards] = useState(null); // { clamped:[...], flippedToday:[...] } | null — §6a mark guard
  const [tab, setTab] = useState('main'); // 'main' (the operator tools) | 'customers' | 'chat'
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
      // House economics (ledger-derived) — works in BOTH modes; drives the Overview boxes + insurance balance.
      (async () => {
        try {
          const e = await api.adminGetEconomics(key);
          setEconomics(e);
          setInsuranceE6(e.insuranceE6);
        } catch {
          setEconomics(null);
        }
      })(),
      // Treasury / proof-of-reserves (real-funds only) — layers the on-chain custody boxes on top.
      (async () => {
        try {
          setTreasury(await api.adminGetTreasury(key));
        } catch {
          setTreasury(null);
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
          setLiqFeeState(await api.adminGetLiqFee(key));
        } catch {
          setLiqFeeState(null);
        }
      })(),
      (async () => {
        try {
          setFundingFactorState(await api.adminGetFundingFactor(key)); // works in either mode
        } catch {
          setFundingFactorState(null);
        }
      })(),
      (async () => {
        try {
          setMarkClampState(await api.adminGetMarkClamp(key)); // §6a mark-guard clamp
        } catch {
          setMarkClampState(null);
        }
      })(),
      (async () => {
        try {
          setWithdrawalAuto(await api.adminGetWithdrawalAutoProcess(key)); // auto-withdrawal toggle
        } catch {
          setWithdrawalAuto(null);
        }
      })(),
      (async () => {
        try {
          setStats(await api.adminGetMarketStats(key)); // per-asset stats + net exposure
        } catch {
          setStats(null);
        }
      })(),
      (async () => {
        try {
          setRestrictions(await api.adminGetRestrictions(key)); // price-confidence gate: restricted now + flipped today
        } catch {
          setRestrictions(null);
        }
      })(),
      (async () => {
        try {
          setMarkGuards(await api.adminGetMarkGuards(key)); // mark guard (§6a): clamped now + flips today
        } catch {
          setMarkGuards(null);
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
    setEconomics(null);
    setInsuranceE6(null);
    setCustodyLimits(null);
    setFeeState(null);
    setLiqFeeState(null);
    setFundingFactorState(null);
    setMarkClampState(null);
    setWithdrawalAuto(null);
    setStats(null);
    setRestrictions(null);
    setMarkGuards(null);
    setTab('main');
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

  // Liquidation penalty: same percent->bps convention as the trading fee.
  const saveLiqFee = async () => {
    setErr(null);
    setMsg(null);
    const pct = Number(liqFeeDraft);
    if (!Number.isFinite(pct) || pct < 0) {
      setErr('Enter a liquidation penalty percentage (e.g. 1 for 1%).');
      return;
    }
    setBusy('liqFee');
    try {
      const r = await api.adminSetLiqFee(Math.round(pct * 100), adminKey.trim());
      setLiqFeeState(r);
      setLiqFeeDraft('');
      setMsg(`Liquidation penalty set to ${(r.bps / 100).toFixed(2)}% (taken into the insurance fund).`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  // Funding factor: the operator enters a PERCENT (max hourly rate at full skew); we store bps (pct*100).
  const saveFunding = async () => {
    setErr(null);
    setMsg(null);
    const pct = Number(fundingDraft);
    if (!Number.isFinite(pct) || pct < 0) {
      setErr('Enter a funding factor percentage (e.g. 0.30 for 0.30%/hour at full skew).');
      return;
    }
    setBusy('funding');
    try {
      const r = await api.adminSetFundingFactor(Math.round(pct * 100), adminKey.trim());
      setFundingFactorState(r);
      setFundingDraft('');
      setMsg(`Funding factor set to ${(r.bps / 100).toFixed(2)}%/hour (max, scaled by the book's skew).`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  // Mark-guard clamp (§6a): the operator enters a PERCENT (per-update cap on an uncorroborated mark
  // move); we store bps (pct*100). Bounds 1-90% — lower = more user protection, higher = more pool.
  const saveMarkClamp = async () => {
    setErr(null);
    setMsg(null);
    const pct = Number(markClampDraft);
    if (!Number.isFinite(pct) || pct < 1 || pct > 90) {
      setErr('Enter a clamp percentage between 1 and 90 (e.g. 25 for a 25%/update cap).');
      return;
    }
    setBusy('markClamp');
    try {
      const r = await api.adminSetMarkClamp(Math.round(pct * 100), adminKey.trim());
      setMarkClampState(r);
      setMarkClampDraft('');
      setMsg(`Mark-guard clamp set to ${(r.bps / 100).toFixed(2)}%/update (uncorroborated moves).`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  // Auto-withdrawal toggle: ON = the worker auto-approves under-cap withdrawals; OFF = all need manual approval.
  const toggleWithdrawalAuto = async () => {
    setErr(null);
    setMsg(null);
    const next = !withdrawalAuto?.enabled;
    if (
      !window.confirm(
        next
          ? 'Turn ON automatic withdrawal approval?\nEligible withdrawals (under the auto-approve cap) will process without manual review.'
          : 'Turn OFF automatic withdrawal approval?\nEvery withdrawal will then require manual operator approval.',
      )
    )
      return;
    setBusy('withdrawalAuto');
    try {
      const r = await api.adminSetWithdrawalAutoProcess(next, adminKey.trim());
      setWithdrawalAuto(r);
      setMsg(`Withdrawal auto-approval is now ${r.enabled ? 'ON' : 'OFF'}.`);
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
  const statsById = new Map((stats?.markets ?? []).map((s) => [s.marketId, s]));
  // Long/short as a ratio (long$ ÷ short$) + the % split, e.g. 1.26 then 56%/44%.
  const lsRatio = (s) => {
    const long = Number(s?.longNotionalE6 ?? 0);
    const short = Number(s?.shortNotionalE6 ?? 0);
    if (long + short === 0) return null;
    return {
      ratio: short > 0 ? (long / short).toFixed(2) : '∞',
      pct: `${Math.round((long / (long + short)) * 100)}%/${Math.round((short / (long + short)) * 100)}%`,
    };
  };
  // Overview figures. Economics (ledger-derived) render in BOTH fund modes; the custody P/L needs the
  // on-chain treasury, so it's only computed when the real-funds treasury view is present.
  const customerE6 = economics ? BigInt(economics.freeE6) + BigInt(economics.lockedE6) : 0n;
  const bd = economics?.pnlBreakdown ?? null; // house P/L breakdown (string-e6 fields)
  // Net trader P/L from the CUSTOMER's perspective (+ = customers up vs the house) = −(house's realized trader P/L).
  const traderCustomerPnlE6 = bd ? (-BigInt(bd.traderPnlE6)).toString() : null;
  // Custody P/L = on-chain treasury − customer funds − pending payouts (real-funds only; null otherwise).
  // Pending withdrawals were already debited from collateral but the cash hasn't left, so subtract them.
  const pnlE6 = treasury ? BigInt(treasury.onchainE6) - customerE6 - BigInt(treasury.pendingE6) : null;

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

      <div className="admin-tabs">
        <button className={`admin-tab ${tab === 'main' ? 'active' : ''}`} onClick={() => setTab('main')}>Main</button>
        <button className={`admin-tab ${tab === 'customers' ? 'active' : ''}`} onClick={() => setTab('customers')}>Customers</button>
        <button className={`admin-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>Chat</button>
      </div>

      {tab === 'customers' && <CustomersView adminKey={adminKey} onGoToMarket={onGoToMarket} />}

      {tab === 'chat' && <ChatAdminView adminKey={adminKey} />}

      {tab === 'main' && (
        <>
      {/* ---- Overview dashboard ---- */}
      <h3 style={{ marginTop: '1rem' }}>Overview</h3>
      {economics ? (
        <div className="admin-stats">
          {/* on-chain custody — real-funds only (needs the chain RPC) */}
          {treasury && <Stat label="Total treasury (hot + cold)" value={treasury.onchainE6} />}
          {treasury && <Stat label="Hot balance" value={treasury.hotE6} />}
          {treasury && <Stat label="Cold treasury" value={treasury.coldE6} />}
          {/* house economics — ledger-derived, shown in both fund modes */}
          <Stat label="Total customer balance" value={customerE6.toString()} />
          <div className="admin-stat">
            <div className="lbl">Net trader P/L (+ = customers up)</div>
            <div className="val">{traderCustomerPnlE6 != null ? formatSignedUsd(traderCustomerPnlE6) : '—'}</div>
          </div>
          <Stat label="…free" value={economics.freeE6} />
          <Stat label="…locked in trades" value={economics.lockedE6} />
          <Stat label="Insurance fund" value={economics.insuranceE6} />
          <Stat label="Fees earned (house cut)" value={economics.feeRevenueE6} />
          <Stat label="LP's share of fees" value={bd?.feesLpE6} />
          <Stat label="Funding collected (customers paid in)" value={economics.fundingCollectedE6} />
          <Stat label="Funding earned (house net kept)" value={economics.fundingRevenueE6} />
          <Stat label="Customer LP in pool" value={economics.customerLpE6} />
          {/* custody cash-flow group: deposits, withdrawals, then pending (flashing red when >0) immediately left of P/L */}
          {treasury && <Stat label="Total deposits" value={economics.totalDepositsE6} />}
          {treasury && <Stat label="Total withdrawals" value={economics.totalWithdrawalsE6} />}
          {treasury && (
            <Stat
              label="Pending withdrawals"
              value={treasury.pendingE6}
              className={BigInt(treasury.pendingE6) > 0n ? 'pending-alert' : ''}
            />
          )}
          {treasury && <PnlStat label="P/L (treasury − customer funds − pending payouts)" value={pnlE6.toString()} />}
        </div>
      ) : (
        <p className="ref-blurb">Operator metrics load once your admin key is verified.</p>
      )}
      {economics && !treasury && (
        <p className="ref-blurb">On-chain custody (hot / cold balances, proof-of-reserves) appears in real-funds mode.</p>
      )}

      {bd && (
        <div className="pnl-breakdown">
          <div className="pnl-breakdown-title">House P/L breakdown — where the P/L comes from</div>
          <table className="pnl-breakdown-table">
            <tbody>
              <tr><td>Trading fees — house cut</td><td className="num">{formatSignedUsd(bd.feesHouseE6)}</td></tr>
              <tr><td>Trading fees — LP share</td><td className="num">{formatSignedUsd(bd.feesLpE6)}</td></tr>
              <tr><td>Funding — net kept</td><td className="num">{formatSignedUsd(bd.fundingNetE6)}</td></tr>
              <tr>
                <td>Net trader P/L <span className="muted">(house side; +ve = house gained)</span></td>
                <td className="num">{formatSignedUsd(bd.traderPnlE6)}</td>
              </tr>
              <tr>
                <td>Insurance fund <span className="muted">(incl. liq penalties {formatSignedUsd(bd.liqPenaltiesE6)})</span></td>
                <td className="num">{formatSignedUsd(bd.insuranceE6)}</td>
              </tr>
              {BigInt(bd.lpOtherE6) !== 0n && (
                <tr><td>LP pool — other <span className="muted">(LP capital / insurance draws)</span></td><td className="num">{formatSignedUsd(bd.lpOtherE6)}</td></tr>
              )}
              <tr className="pnl-breakdown-total"><td>Total (house equity)</td><td className="num">{formatSignedUsd(bd.totalE6)}</td></tr>
            </tbody>
          </table>
          {treasury && pnlE6 != null && bd.totalE6 !== pnlE6.toString() && (
            <p className="ref-blurb" style={{ marginTop: '0.4rem' }}>
              Custody P/L (treasury − customer − pending) is {formatSignedUsd(pnlE6.toString())} — an unreconciled
              difference of {formatSignedUsd((pnlE6 - BigInt(bd.totalE6)).toString())} (settles as deposits sweep).
            </p>
          )}
        </div>
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

      {/* ---- Liquidation penalty ---- */}
      <h3 style={{ marginTop: '1.25rem' }}>Liquidation penalty</h3>
      <p className="ref-blurb">
        Charged on a <strong>liquidated</strong> position's size and routed to the <strong>insurance fund</strong>.
        Enter a percentage: <code>1</code> means 1%. Currently{' '}
        <strong>{liqFee ? `${(liqFee.bps / 100).toFixed(2)}%` : '—'}</strong>
        {liqFee ? ` (env default ${(liqFee.default / 100).toFixed(2)}%)` : ''}.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.35rem 0' }}>
        <input
          className="wallet-input" type="number" min="0" step="0.01" placeholder="1"
          value={liqFeeDraft} onChange={(e) => setLiqFeeDraft(e.target.value)} style={{ width: 120 }}
        />
        <span className="muted" style={{ fontSize: '0.85rem' }}>%</span>
        <button className="btn-primary sm" disabled={busy === 'liqFee'} onClick={saveLiqFee}>
          {busy === 'liqFee' ? '…' : 'Save penalty'}
        </button>
      </div>

      {/* ---- Funding factor ---- */}
      <h3 style={{ marginTop: '1.25rem' }}>Funding factor</h3>
      <p className="ref-blurb">
        The <strong>max hourly funding rate</strong>, charged each hour and scaled by the book's long/short
        skew (the heavy side pays the lighter side via the LP pool). Enter a percentage: <code>0.30</code>{' '}
        means up to 0.30%/hour at full skew. Currently{' '}
        <strong>{fundingFactor ? `${(fundingFactor.bps / 100).toFixed(2)}%/hour` : '—'}</strong>
        {fundingFactor ? ` (env default ${(fundingFactor.default / 100).toFixed(2)}%/hour)` : ''}.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.35rem 0' }}>
        <input
          className="wallet-input" type="number" min="0" step="0.01" placeholder="0.30"
          value={fundingDraft} onChange={(e) => setFundingDraft(e.target.value)} style={{ width: 120 }}
        />
        <span className="muted" style={{ fontSize: '0.85rem' }}>%/hour</span>
        <button className="btn-primary sm" disabled={busy === 'funding'} onClick={saveFunding}>
          {busy === 'funding' ? '…' : 'Save funding'}
        </button>
      </div>

      <h3 style={{ marginTop: '1.25rem' }}>Mark-guard clamp</h3>
      <p className="ref-blurb">
        Caps how far the mark can move on a single <strong>uncorroborated</strong> price jump (one eBay
        doesn&apos;t confirm) — the price creeps toward a real move over a few updates so a bad print can&apos;t
        wrongfully liquidate open positions. Active under <code>ORACLE_PRIMARY=scrydex</code>. Enter a
        percentage: <code>25</code> caps each update at 25% of the last mark. Lower = more trader
        protection; higher = adopts real moves faster. Currently{' '}
        <strong>{markClamp ? `${(markClamp.bps / 100).toFixed(2)}%/update` : '—'}</strong>
        {markClamp ? ` (default ${(markClamp.default / 100).toFixed(2)}%)` : ''}.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.35rem 0' }}>
        <input
          className="wallet-input" type="number" min="1" max="90" step="0.01" placeholder="25"
          value={markClampDraft} onChange={(e) => setMarkClampDraft(e.target.value)} style={{ width: 120 }}
        />
        <span className="muted" style={{ fontSize: '0.85rem' }}>%/update</span>
        <button className="btn-primary sm" disabled={busy === 'markClamp'} onClick={saveMarkClamp}>
          {busy === 'markClamp' ? '…' : 'Save clamp'}
        </button>
      </div>

      {withdrawalAuto && (
        <>
          <h3 style={{ marginTop: '1.25rem' }}>Withdrawal auto-approval</h3>
          <p className="ref-blurb">
            When <strong>ON</strong>, withdrawals under the auto-approve cap are processed automatically by the
            worker. When <strong>OFF</strong>, <strong>every</strong> withdrawal waits for manual operator
            approval. Currently{' '}
            <strong style={{ color: withdrawalAuto.enabled ? 'var(--success)' : 'var(--danger)' }}>
              {withdrawalAuto.enabled ? 'ON' : 'OFF'}
            </strong>
            {` (default ${withdrawalAuto.default ? 'ON' : 'OFF'})`}.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.35rem 0' }}>
            <button
              className={`${withdrawalAuto.enabled ? 'btn-ghost' : 'btn-primary'} sm`}
              disabled={busy === 'withdrawalAuto'}
              onClick={toggleWithdrawalAuto}
            >
              {busy === 'withdrawalAuto' ? '…' : withdrawalAuto.enabled ? 'Turn OFF auto-approval' : 'Turn ON auto-approval'}
            </button>
          </div>
        </>
      )}

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

      <h3 style={{ marginTop: '1.25rem' }}>Per-asset trading + manual pricing</h3>
      {stats && (
        <div className="admin-stats" style={{ marginBottom: '0.6rem' }}>
          <PnlStat
            label="NET player P/L — your payout exposure (collectable at settlement)"
            value={stats.totals.netCappedE6}
          />
          <div className="admin-stat">
            <div className="lbl">raw mark-to-market (uncapped)</div>
            <div className="val">{formatSignedUsd(stats.totals.netRawE6)}</div>
          </div>
        </div>
      )}
      <p className="ref-blurb">
        Per asset: 24h volume, margin locked, net player P/L (capped = what you'd net at settlement),
        and the long/short ratio. <strong>Set a price</strong> by hand to <strong>pin</strong> a market so
        the automated feed won't overwrite it until you unpin.
      </p>

      {restrictions && (
        <div
          className="admin-restrictions"
          style={{ margin: '0.6rem 0', padding: '0.6rem 0.8rem', border: '1px solid var(--border)', borderRadius: 8 }}
        >
          <div>
            <strong>Price-confidence gate</strong>{' '}
            <span className="muted">— restricted markets are reduce-only (no new positions) until the oracle trusts their price again.</span>
          </div>
          <div style={{ marginTop: '0.35rem' }}>
            <span className="muted">Restricted now: </span>
            <strong>{restrictions.restricted.length}</strong>
            <span className="muted"> · Flipped to restricted today: </span>
            <strong style={{ color: restrictions.flippedToday.length ? 'var(--danger)' : undefined }}>
              {restrictions.flippedToday.length}
            </strong>
          </div>
          {restrictions.flippedToday.length > 0 && (
            <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem', maxHeight: 160, overflowY: 'auto' }}>
              {restrictions.flippedToday.map((r) => (
                <li key={`${r.marketId}-${r.at}`}>
                  <span style={{ color: 'var(--danger)' }}>{r.displayName}</span>{' '}
                  <span className="muted">
                    ({r.game}) — {new Date(r.at).toLocaleTimeString()} · {r.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {markGuards && (
        <div
          className="admin-mark-guards"
          style={{ margin: '0.6rem 0', padding: '0.6rem 0.8rem', border: '1px solid var(--border)', borderRadius: 8 }}
        >
          <div>
            <strong>Mark guards</strong>{' '}
            <span className="muted">
              — a clamped market shows a price that creeps toward an uncorroborated jump rather than jumping, so a bad print can&apos;t wrongfully liquidate. The shown mark is the one that liquidates.
            </span>
          </div>
          <div style={{ marginTop: '0.35rem' }}>
            <span className="muted">Clamped now: </span>
            <strong style={{ color: markGuards.clamped.length ? 'var(--warning, #c80)' : undefined }}>{markGuards.clamped.length}</strong>
            <span className="muted"> · Guard flips today: </span>
            <strong>{markGuards.flippedToday.length}</strong>
          </div>
          {markGuards.clamped.length > 0 && (
            <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem', maxHeight: 160, overflowY: 'auto' }}>
              {markGuards.clamped.map((g) => (
                <li key={g.marketId}>
                  <span style={{ color: 'var(--warning, #c80)' }}>{g.displayName}</span>{' '}
                  <span className="muted">
                    ({g.game}) — showing ${(Number(g.adoptedE6) / 1e6).toFixed(2)} vs candidate ${(Number(g.candidateE6) / 1e6).toFixed(2)}
                    {g.gapPct != null && <> · gap {g.gapPct.toFixed(0)}%</>}
                    {g.since && <> · since {new Date(g.since).toLocaleTimeString()}</>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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
            <th>Symbol</th><th>Name</th><th>Mark</th>
            <th>Vol 24h</th><th>Locked</th><th>Net P/L</th><th>L/S</th>
            <th>Status</th><th>Pinned</th><th>Set price (USD)</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={11} className="hist-empty">No markets.</td></tr>}
          {rows.map((m) => {
            const s = statsById.get(m.id);
            const ls = lsRatio(s);
            return (
            <tr key={m.id}>
              <td>{m.symbol}</td>
              <td className="mkt-name" title={m.displayName}>{m.displayName}</td>
              <td>{m.markE6 ? formatUsd(BigInt(m.markE6)) : '—'}</td>
              <td className="num">{s ? formatUsd(BigInt(s.volume24hE6)) : '—'}</td>
              <td className="num">{s ? formatUsd(BigInt(s.lockedE6)) : '—'}</td>
              <td className="num" style={{ color: s && BigInt(s.netCappedE6) < 0n ? 'var(--danger)' : 'var(--success)' }}>
                {s ? formatSignedUsd(s.netCappedE6) : '—'}
              </td>
              <td className="num">
                {ls ? <>{ls.ratio}<br /><span className="muted" style={{ fontSize: '0.8em' }}>{ls.pct}</span></> : '—'}
              </td>
              <td style={{ color: m.restricted ? 'var(--danger)' : undefined }} className={m.restricted ? '' : 'muted'}>
                {m.restricted ? 'RESTRICTED' : 'active'}
              </td>
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
          );
          })}
        </tbody>
      </table>
        </>
      )}
    </div>
  );
}
