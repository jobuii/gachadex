import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import * as api from '../lib/api.js';
import { Stat, PnlStat } from './adminStats.jsx';

const RTIERS = ['common', 'uncommon', 'rare', 'epic'];
// realized odds: the % of pulls in each tier (C/U/R/E) for a count map + total.
const oddsStr = (counts, total) => RTIERS.map((r) => `${r[0].toUpperCase()} ${total ? Math.round(((counts[r] ?? 0) / total) * 100) : 0}%`).join(' · ');

/**
 * Operator Classic Gacha view (docs/classic-gacha-cc-packs-spec.md §12). The economics readout (cut revenue vs
 * Token-rebate cost + the live sell-back rate, so the operator can watch the §6 net — break-even ≈ 57%) plus the
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

  const load = useCallback(() => {
    return Promise.all([api.adminGetGachaConfig(adminKey), api.adminGetGachaMonitoring(adminKey)])
      .then(([c, m]) => {
        setCfg(c.config); setMachines(c.machines ?? []); setMon(m);
        setFreePack(String(c.config.freePackThresholdUsd));
        setBuyback((c.config.buybackCutBps / 100).toString());
        setTurbo((c.config.turboCutBps / 100).toString());
        setMarkup((c.config.markupBps / 100).toString());
      })
      .catch((e) => setErr(e.message));
  }, [adminKey]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

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

  if (!cfg) return <p className="ref-blurb">{err || 'Loading gacha config…'}</p>;

  const nameOf = (code) => machines.find((m) => m.code === code)?.name ?? code; // resolve a stat's machine code to its name

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
            <Stat label="Rebate cost (Tokens)" value={mon.rebateCostE6} />
            <PnlStat label="Net" value={mon.netE6} />
          </div>
          <div className="admin-stats">
            <div className="stat-card"><span className="sc-label">Sell-back rate</span><span className="sc-val">{mon.sellBackRatePct}%</span></div>
            <div className="stat-card"><span className="sc-label">Delivered / sold / kept</span><span className="sc-val">{mon.deliveredCards} / {mon.soldBack} / {mon.kept}</span></div>
            <Stat label="Rewards budget" value={mon.rewardsBudgetE6} />
          </div>
          <p className="muted">Break-even ≈ 57% sell-back at the default 5% cut. If the rate drifts toward it, raise the cut or turn on the purchase markup below. Pre-fund the rewards budget before enabling Tokens.</p>

          <h4 style={{ margin: '1.2rem 0 0.4rem' }}>Activity</h4>
          <div className="admin-stats">
            <div className="stat-card"><span className="sc-label">Packs opened (24h)</span><span className="sc-val">{mon.packsOpened} ({mon.packsOpened24h})</span></div>
            <Stat label="Volume (USDC)" value={mon.volumeUsdcE6} />
            <Stat label="Prize value delivered" value={mon.prizeValueE6} />
            <Stat label="Biggest pull" value={mon.biggestPullE6} />
          </div>
          <div className="admin-stats">
            <div className="stat-card"><span className="sc-label">Players</span><span className="sc-val">{mon.players}</span></div>
            <div className="stat-card"><span className="sc-label">Token packs</span><span className="sc-val">{mon.tokenPacks}</span></div>
            <div className="stat-card"><span className="sc-label">Withdraws</span><span className="sc-val">{mon.withdraws}</span></div>
            <div className="stat-card"><span className="sc-label">Realized odds — all-time (24h)</span><span className="sc-val" style={{ fontSize: '0.78rem' }}>{oddsStr(mon.rarity, mon.packsOpened)} <span className="muted">({oddsStr(mon.rarity24h, mon.packsOpened24h)})</span></span></div>
          </div>

          {mon.machines?.length > 0 && (
            <>
              <h4 style={{ margin: '1.2rem 0 0.4rem' }}>Per machine</h4>
              <table className="hist-table">
                <thead><tr><th>Machine</th><th>Opens (24h)</th><th>Net</th><th>Prize value</th><th>Realized odds — all-time (24h)</th></tr></thead>
                <tbody>
                  {mon.machines.map((m) => (
                    <tr key={m.code}>
                      <td>{nameOf(m.code)}</td>
                      <td>{m.opens} ({m.opens24h})</td>
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
    </div>
  );
}
