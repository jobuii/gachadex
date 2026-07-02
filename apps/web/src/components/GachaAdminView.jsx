import { useState, useEffect, useCallback, useRef } from 'react';
import { formatUsd } from '@pokex/pricing';
import * as api from '../lib/api.js';
import { Stat, PnlStat } from './adminStats.jsx';
import { RARITY_TIERS, RARITY_COLORS } from './games/gacha-util.js';

// realized odds: the % of pulls in each tier (C/U/R/E) for a count map + total.
const oddsStr = (counts, total) => RARITY_TIERS.map((r) => `${r[0].toUpperCase()} ${total ? Math.round(((counts[r] ?? 0) / total) * 100) : 0}%`).join(' · ');
// tier → swatch (local 1-liner like the lobby's; gacha-util notes each component keeps its own wrapper).
const tierColor = (label, i = 0) => RARITY_COLORS[(label ?? '').toLowerCase()] ?? Object.values(RARITY_COLORS)[i] ?? '#ef4444';
const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const rangeStr = (t) => (t.minE6 ? formatUsd(BigInt(t.minE6)) : '—') + (t.maxE6 ? `–${formatUsd(BigInt(t.maxE6))}` : '+');
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/**
 * Operator Classic Gacha view (docs/classic-gacha-cc-packs-spec.md §12). The economics readout (cut revenue vs
 * Gold-rebate cost + the live sell-back rate, so the operator can watch the §6 net — break-even ≈ 57%) plus the
 * live knobs (free-pack threshold, sell-back cut %s, optional purchase markup) and per-machine enable. Mirrors
 * GamesAdminView: accepts the adminKey, polls config + monitoring, posts partial knob patches.
 */
export function GachaAdminView({ adminKey }) {
  const [cfg, setCfg] = useState(null);
  const [mon, setMon] = useState(null);
  const [machines, setMachines] = useState([]);
  const [freePack, setFreePack] = useState(''); // whole USD
  const [buyback, setBuyback] = useState(''); // percent
  const [turbo, setTurbo] = useState(''); // percent
  const [markup, setMarkup] = useState(''); // percent
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [restocks, setRestocks] = useState({}); // { [code]: { [tier]: delta } } — stock increases since the last poll
  const prevStockRef = useRef({}); // { [code]: { [tier]: count } } from the previous poll (in-memory baseline)
  const [onlyVisible, setOnlyVisible] = useState(false); // Live-machines filter: only machines shown in the lobby
  const [refreshSecs, setRefreshSecs] = useState(''); // the global refresh-interval input (seconds)
  const refreshFocusedRef = useRef(false); // while the admin is editing the interval, don't let a poll overwrite it
  const [fundAmt, setFundAmt] = useState(''); // USD to sweep FEE_REVENUE → rewards budget
  const [leftovers, setLeftovers] = useState(null); // on-demand custody-leftover scan result

  const load = useCallback((force = false) => {
    return Promise.all([api.adminGetGachaConfig(adminKey, force), api.adminGetGachaMonitoring(adminKey)])
      .then(([c, m]) => {
        const list = c.machines ?? [];
        // Restock diff: flag any tier whose CC stock went UP vs the previous poll (no baseline on the first load).
        const nextStock = {};
        const nextRestocks = {};
        for (const mm of list) {
          nextStock[mm.code] = mm.stock ?? {};
          const prev = prevStockRef.current[mm.code];
          if (prev) for (const [tier, n] of Object.entries(mm.stock ?? {})) {
            const d = (n ?? 0) - (prev[tier] ?? 0);
            if (d > 0) (nextRestocks[mm.code] ??= {})[tier] = d;
          }
        }
        prevStockRef.current = nextStock;
        setRestocks(nextRestocks);
        setCfg(c.config); setMachines(list); setMon(m);
        setFreePack(String(c.config.freePackThresholdUsd));
        setBuyback((c.config.buybackCutBps / 100).toString());
        setTurbo((c.config.turboCutBps / 100).toString());
        setMarkup((c.config.markupBps / 100).toString());
        if (!refreshFocusedRef.current) setRefreshSecs(String(c.config.stockRefreshSecs)); // keep the field if mid-edit
      })
      .catch((e) => setErr(e.message));
  }, [adminKey]);

  useEffect(() => { load(); }, [load]); // initial load
  useEffect(() => {
    if (cfg?.stockPaused) return; // global pause → no auto-refresh (the server stops re-querying CC too)
    const id = setInterval(load, Math.max(15, cfg?.stockRefreshSecs ?? 30) * 1000);
    return () => clearInterval(id);
  }, [load, cfg?.stockPaused, cfg?.stockRefreshSecs]);

  const act = async (fn, okMsg) => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveKnobs = () => {
    const patch = {
      freePackThresholdUsd: parseInt(freePack, 10),
      buybackCutBps: Math.round(parseFloat(buyback) * 100),
      turboCutBps: Math.round(parseFloat(turbo) * 100),
      markupBps: Math.round(parseFloat(markup) * 100),
    };
    if (Object.values(patch).some((v) => !Number.isFinite(v))) { setErr('Every knob needs a number.'); return; }
    act(() => api.adminSetGachaConfig(patch, adminKey), 'Saved. (Applies within ~30s; restart the API if a value doesn’t take.)');
  };

  const toggleMachine = (code, enable) => {
    const disabled = new Set(cfg?.disabledMachines ?? []);
    if (enable) disabled.delete(code); else disabled.add(code);
    act(() => api.adminSetGachaConfig({ disabledMachines: [...disabled] }, adminKey));
  };

  // Global live-machines refresh controls (shared across admins + the lobby; last change wins).
  const saveRefreshSecs = () => {
    const secs = Math.max(15, parseInt(refreshSecs, 10) || 30);
    if (secs === cfg?.stockRefreshSecs) { setRefreshSecs(String(secs)); return; } // no-op if unchanged
    act(() => api.adminSetGachaConfig({ stockRefreshSecs: secs }, adminKey));
  };
  const togglePause = (paused) => act(() => api.adminSetGachaConfig({ stockPaused: paused }, adminKey));

  const setGold = (patch) => act(() => api.adminSetGachaConfig(patch, adminKey));
  const resetGold = () => {
    if (window.prompt('Type RESET to zero EVERY customer’s Gold balance. This cannot be undone.') !== 'RESET') return;
    act(async () => { const r = await api.adminResetGold(adminKey); setMsg(`Reset ${r.usersReset} Gold balance(s) to zero.`); });
  };
  // Sweep earned platform fees into the Gold rewards budget (capped server-side at the FEE_REVENUE balance).
  const fundBudget = () => {
    const usd = parseFloat(fundAmt);
    if (!Number.isFinite(usd) || usd <= 0) { setErr('Enter a positive amount to sweep.'); return; }
    act(async () => { const r = await api.adminFundGachaRewardsBudget(usd, adminKey); setFundAmt(''); setMsg(`Swept ${formatUsd(BigInt(r.movedE6))} into the rewards budget.`); });
  };

  const reconcileStuck = () => act(async () => {
    const r = await api.adminReconcileStuckGacha(adminKey);
    setMsg(`Reconciled — ${r.revertedToHeld} released to held · ${r.markedWithdrawn} marked withdrawn · ${r.settledSelling ?? 0} auto-settled · ${r.flaggedSelling} flagged for manual credit · ${r.skipped} skipped (DAS).`);
  });

  const scanCustodies = () => act(async () => {
    const r = await api.adminScanGachaCustodyLeftovers(adminKey);
    setLeftovers(r);
    setMsg(`Custody scan — ${formatUsd(BigInt(r.totalE6))} stranded across ${r.custodies.length} wallet(s).`);
  });

  if (!cfg) return <p className="ref-blurb">{err || 'Loading gacha config…'}</p>;

  // resolve a stat's machine code to "Name ($price)" so the operator can tell machines apart at a glance
  const nameOf = (code) => {
    const m = machines.find((mm) => mm.code === code);
    return m ? `${m.name} (${formatUsd(BigInt(m.priceE6)).replace(/\.00$/, '')})` : code;
  };

  return (
    <div className="games-admin gacha-admin">
      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}

      <h3 style={{ marginTop: '1rem' }}>Classic Gacha — economics</h3>
      {mon && (
        <>
          <div className="admin-stats">
            <Stat label="Sell-back cut revenue" value={mon.sellBackCutE6} />
            <Stat label="Markup revenue" value={mon.markupE6} />
            <Stat label="Rebate cost (Gold)" value={mon.rebateCostE6} />
            <Stat label="Referral cost (paid to referrers)" value={mon.referralCostE6} />
            <PnlStat label="Net" value={mon.netE6} />
          </div>
          <div className="admin-stats">
            <div className="stat-card"><span className="sc-label">Sell-back rate</span><span className="sc-val">{mon.sellBackRatePct}%</span></div>
            <div className="stat-card"><span className="sc-label">Delivered / sold / kept</span><span className="sc-val">{mon.deliveredCards} / {mon.soldBack} / {mon.kept}</span></div>
            <Stat label="Rewards budget" value={mon.rewardsBudgetE6} />
          </div>
          <p className="muted">Break-even ≈ 57% sell-back at the default 5% cut. If the rate drifts toward it, raise the cut or turn on the purchase markup below. Pre-fund the rewards budget before enabling Gold.</p>

          <h4 style={{ margin: '1.2rem 0 0.4rem' }}>Activity</h4>
          <div className="admin-stats">
            <div className="stat-card"><span className="sc-label">Packs opened (24h)</span><span className="sc-val">{mon.packsOpened} ({mon.packsOpened24h})</span></div>
            <Stat label="Volume (USDC)" value={mon.volumeUsdcE6} />
            <Stat label="Prize value delivered" value={mon.prizeValueE6} />
            <Stat label="Biggest pull" value={mon.biggestPullE6} />
          </div>
          <div className="admin-stats">
            <div className="stat-card"><span className="sc-label">Players</span><span className="sc-val">{mon.players}</span></div>
            <div className="stat-card"><span className="sc-label">Gold packs</span><span className="sc-val">{mon.goldPacks}</span></div>
            <div className="stat-card"><span className="sc-label">Withdraws</span><span className="sc-val">{mon.withdraws}</span></div>
            <div className="stat-card"><span className="sc-label">Realized odds — all-time (24h)</span><span className="sc-val" style={{ fontSize: '0.78rem' }}>{oddsStr(mon.rarity, mon.packsOpened)} <span className="muted">({oddsStr(mon.rarity24h, mon.packsOpened24h)})</span></span></div>
          </div>

          <h4 style={{ margin: '1.2rem 0 0.4rem' }}>Stuck rows &amp; stranded funds</h4>
          <div className="admin-stats">
            <div className="stat-card"><span className="sc-label">Selling / withdrawing</span><span className={`sc-val ${(mon.stuckSelling + mon.stuckWithdrawing) > 0 ? 'down' : ''}`}>{mon.stuckSelling} / {mon.stuckWithdrawing}</span></div>
            <div className="stat-card"><span className="sc-label">Paid but undelivered</span><span className={`sc-val ${mon.stuckPaidOpens > 0 ? 'down' : ''}`}>{mon.stuckPaidOpens}{mon.stuckPaidOpens > 0 ? ` · ${formatUsd(BigInt(mon.stuckPaidE6))} · ${mon.oldestStuckPaidMins}m old` : ''}</span></div>
            <div className="stat-card" style={{ alignItems: 'flex-start', justifyContent: 'center' }}><button className="btn-ghost" disabled={busy} onClick={reconcileStuck}>Reconcile stuck rows</button></div>
          </div>
          <p className="muted" style={{ fontSize: '0.76rem' }}>A crash mid sell-back/withdraw can strand a row; “paid but undelivered” = a buy charged before the NFT arrived. The reconciler (on boot + every 2 min, or this button) releases held NFTs, marks withdrawals, auto-settles sold-but-unsettled, and refunds undelivered buys.</p>

          <div className="admin-stats">
            <div className="stat-card" style={{ alignItems: 'flex-start', justifyContent: 'center' }}><button className="btn-ghost" disabled={busy} onClick={scanCustodies}>Scan custody wallets</button></div>
            {leftovers && <div className="stat-card"><span className="sc-label">Custody leftovers (uncounted)</span><span className={`sc-val ${BigInt(leftovers.totalE6) > 0n ? 'down' : ''}`}>{formatUsd(BigInt(leftovers.totalE6))} · {leftovers.custodies.length} wallet{leftovers.custodies.length === 1 ? '' : 's'}</span></div>}
          </div>
          <p className="muted" style={{ fontSize: '0.76rem' }}>Stranded USDC parked in custody wallets (a crash between charge and CC payment) — NOT counted in reserves. The scan reads each on-chain (so it’s a button). The auto-reconciler refunds the customer; the sweep returns the funds to hot (scripts/sweep-custody-leftovers.ts, or set GACHA_AUTO_SWEEP_ENABLED to sweep automatically). Skips any wallet whose user has a live open.</p>

          {mon.machines?.length > 0 && (
            <>
              <h4 style={{ margin: '1.2rem 0 0.4rem' }}>Per machine</h4>
              <table className="hist-table">
                <thead><tr><th>Machine</th><th>Opens (24h)</th><th>Referral</th><th>Net</th><th>Prize value</th><th>Realized odds — all-time (24h)</th></tr></thead>
                <tbody>
                  {mon.machines.map((m) => (
                    <tr key={m.code}>
                      <td>{nameOf(m.code)}</td>
                      <td>{m.opens} ({m.opens24h})</td>
                      <td>{formatUsd(BigInt(m.referralE6 ?? '0'))}</td>
                      <td>{formatUsd(BigInt(m.netE6))}</td>
                      <td>{formatUsd(BigInt(m.prizeValueE6))}</td>
                      <td className="muted" style={{ fontSize: '0.74rem' }}>{oddsStr(m.rarity, m.opens)} <span style={{ opacity: 0.65 }}>({oddsStr(m.rarity24h, m.opens24h)})</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <h3 style={{ marginTop: '1.5rem' }}>Knobs</h3>
      <div className="games-admin-fields">
        <label className="field-label"><span>Free-pack threshold (USD)</span><input type="number" min="1" value={freePack} onChange={(e) => setFreePack(e.target.value)} /></label>
        <label className="field-label"><span>Buyback cut (%)</span><input type="number" step="0.1" min="0" value={buyback} onChange={(e) => setBuyback(e.target.value)} /></label>
        <label className="field-label"><span>Turbo / instant cut (%)</span><input type="number" step="0.1" min="0" value={turbo} onChange={(e) => setTurbo(e.target.value)} /></label>
        <label className="field-label"><span>Purchase markup (%)</span><input type="number" step="0.1" min="0" value={markup} onChange={(e) => setMarkup(e.target.value)} /></label>
      </div>
      <button className="btn-primary" disabled={busy} onClick={saveKnobs}>Save knobs</button>

      <h3 style={{ marginTop: '1.5rem' }}>Gold (loyalty)</h3>
      <div className="gacha-admin-machines">
        <label className="games-admin-row">
          <input type="checkbox" checked={!!cfg.goldEnabled} disabled={busy} onChange={(e) => setGold({ goldEnabled: e.target.checked })} />
          <span>Gold system <span className="muted">· on = customers see + can claim Gold; off = hidden in the UI (earn still accrues silently)</span></span>
        </label>
        <label className="games-admin-row">
          <input type="checkbox" checked={!!cfg.payWithGoldEnabled} disabled={busy || !cfg.goldEnabled} onChange={(e) => setGold({ payWithGoldEnabled: e.target.checked })} />
          <span>Pay with Gold on machines <span className="muted">· off = USDC only (free-pack claim still works); needs the system on</span></span>
        </label>
      </div>

      <div style={{ marginTop: '0.8rem' }}>
        <div className="admin-stats">
          <div className="stat-card"><span className="sc-label">Rewards budget</span><span className="sc-val">{formatUsd(BigInt(mon?.rewardsBudgetE6 ?? '0'))}</span></div>
          <div className="stat-card"><span className="sc-label">Earned fees available</span><span className="sc-val">{formatUsd(BigInt(mon?.feeRevenueE6 ?? '0'))}</span></div>
        </div>
        <div className="games-admin-row" style={{ gap: '0.5rem', alignItems: 'center', marginTop: '0.45rem', flexWrap: 'wrap' }}>
          <label className="field-label" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
            <span>Sweep $</span>
            <input type="number" min="0" step="1" value={fundAmt} disabled={busy} style={{ width: 100 }} onChange={(e) => setFundAmt(e.target.value)} />
          </label>
          <button className="btn-primary" disabled={busy} onClick={fundBudget}>Sweep fees → rewards budget</button>
        </div>
        <p className="muted" style={{ fontSize: '0.74rem', margin: '0.3rem 0 0' }}>
          Moves earned platform fees into the Gold rewards budget (which pays Collector Crypt for Gold-bought packs) — a ledger move, no on-chain transfer. Pre-fund this before turning on “Pay with Gold”; you can only sweep up to the earned fees shown.
        </p>
      </div>

      <button className="btn-ghost" disabled={busy} onClick={resetGold} style={{ marginTop: '0.8rem', color: 'var(--down, #ef4444)' }}>Reset all Gold balances…</button>
      <p className="muted" style={{ fontSize: '0.76rem' }}>Destructive: zeroes every customer’s Gold (writes an ADMIN_RESET ledger entry per user). Type-to-confirm.</p>

      <h3 style={{ marginTop: '1.5rem' }}>Machines ({machines.length})</h3>
      <p className="muted">Untick a machine to hide it from the lobby (live, no deploy).</p>
      <div className="gacha-admin-machines">
        {machines.map((m) => (
          <label key={m.code} className="games-admin-row">
            <input type="checkbox" checked={!m.disabled} disabled={busy} onChange={(e) => toggleMachine(m.code, e.target.checked)} />
            <span>{m.name} <span className="muted">· {formatUsd(BigInt(m.priceE6))} · {m.code}</span></span>
          </label>
        ))}
        {machines.length === 0 && <p className="muted">No machines loaded (Collector Crypt unreachable?).</p>}
      </div>

      <h3 style={{ marginTop: '1.5rem' }}>Live machines — stock &amp; odds{' '}
        <span className="muted" style={{ fontSize: '0.7rem', fontWeight: 400 }}>· live from Collector Crypt · ▲ = restocked since the last refresh</span>
      </h3>
      <div className="games-admin-row" style={{ gap: '0.9rem', flexWrap: 'wrap', alignItems: 'center', margin: '0.3rem 0 0.3rem' }}>
        <label className="field-label" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
          <span>Refresh every</span>
          <input type="number" min="15" step="5" value={refreshSecs} disabled={busy} style={{ width: 70 }}
            onFocus={() => { refreshFocusedRef.current = true; }}
            onChange={(e) => setRefreshSecs(e.target.value)}
            onBlur={() => { refreshFocusedRef.current = false; saveRefreshSecs(); }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
          <span>s</span>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          <input type="checkbox" checked={!!cfg.stockPaused} disabled={busy} onChange={(e) => togglePause(e.target.checked)} /> Pause auto-refresh
        </label>
        <button className="btn-ghost" disabled={busy} onClick={() => load(true)}>Refresh now</button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', marginLeft: 'auto' }}>
          <input type="checkbox" checked={onlyVisible} onChange={(e) => setOnlyVisible(e.target.checked)} /> Only visible
        </label>
      </div>
      <p className="muted" style={{ fontSize: '0.74rem', margin: '0 0 0.6rem' }}>
        Global — applies to every admin tab and the customer lobby (last change wins). The server re-queries Collector Crypt once per interval for everyone; <strong>below ~15s risks rate-limit errors</strong>.
      </p>

      {mon?.recentRestocks?.length > 0 && (
        <div style={{ margin: '0.2rem 0 0.8rem' }}>
          <p className="muted" style={{ fontSize: '0.76rem', margin: '0 0 0.35rem' }}>Recent restocks — recorded server-side every few minutes, so they show even if this tab was closed:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {mon.recentRestocks.slice(0, 24).map((e, i) => (
              <span key={i} className="stat-card" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.35rem', padding: '0.25rem 0.55rem', fontSize: '0.76rem' }}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: tierColor(e.tier) }} />
                <strong>{nameOf(e.machineCode)}</strong> {titleCase(e.tier)}
                <span style={{ color: 'var(--up, #22c55e)', fontWeight: 600 }}>▲ +{e.delta}</span>
                <span className="muted">· {ago(e.detectedAt)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="gacha-live-machines">
        {machines
          .filter((m) => (m.tiers?.length ?? 0) > 0 || Object.keys(m.stock ?? {}).length > 0)
          .filter((m) => !onlyVisible || !m.disabled)
          .slice().sort((a, b) => Number(a.priceE6) - Number(b.priceE6)) // ascending pack cost
          .map((m) => (
          <div key={m.code} style={{ margin: '0.7rem 0' }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>{m.name}</strong>
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                {formatUsd(BigInt(m.priceE6))}{Number(m.evE6) > 0 ? ` · EV ${formatUsd(BigInt(m.evE6))}` : ''}{m.buybackPct ? ` · buyback ${m.buybackPct}%` : ''}{m.disabled ? ' · hidden' : ''}
              </span>
            </div>
            <table className="hist-table" style={{ marginTop: '0.25rem' }}>
              <thead><tr><th>Tier</th><th>Odds</th><th>Value range</th><th>Stock</th></tr></thead>
              <tbody>
                {(m.tiers ?? []).map((t, i) => {
                  const stock = (m.stock ?? {})[t.label] ?? 0;
                  const up = restocks[m.code]?.[t.label] ?? 0;
                  return (
                    <tr key={t.label}>
                      <td><span className="gacha-dot" style={{ background: tierColor(t.label, i), display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 6 }} />{titleCase(t.label)}</td>
                      <td>{t.pct}%</td>
                      <td>{rangeStr(t)}</td>
                      <td>{stock}{up > 0 ? <span style={{ color: 'var(--up, #22c55e)', fontWeight: 600 }}> ▲ +{up}</span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        {machines.length === 0 && <p className="muted">No machines loaded (Collector Crypt unreachable?).</p>}
      </div>
    </div>
  );
}
