import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import * as api from '../lib/api.js';

/**
 * Operator Games view (docs/games-spec.md). Per-game live knobs + the GAME_POOL bankroll. Mirrors
 * ChatAdminView: accepts the adminKey, polls config, posts partial updates. Pack Rip tiers (the nested
 * band table) are edited as raw JSON for now; the scalars have dedicated fields.
 */
export function GamesAdminView({ adminKey }) {
  const [view, setView] = useState(null); // { packRip, defaults, poolE6 }
  const [enabled, setEnabled] = useState(false);
  const [spread, setSpread] = useState(''); // percent (12 = 12%)
  const [maxPrize, setMaxPrize] = useState('');
  const [bigWin, setBigWin] = useState('');
  const [tiersJson, setTiersJson] = useState('');
  const [seedAmt, setSeedAmt] = useState('');
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return api.adminGetGamesConfig(adminKey).then((v) => {
      setView(v);
      const pr = v.packRip;
      setEnabled(pr.enabled);
      setSpread((pr.buybackSpreadBps / 100).toString());
      setMaxPrize(String(pr.maxPrizeUsd));
      setBigWin(String(pr.bigWinUsd));
      setTiersJson(JSON.stringify(pr.tiers, null, 2));
    }).catch((e) => setErr(e.message));
  }, [adminKey]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // Run an admin call with shared busy/error/message handling, then reload (PoolView's act pattern).
  const act = async (fn, okMsg) => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const r = await fn();
      if (okMsg) setMsg(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveScalars = () => {
    let tiers;
    try {
      tiers = JSON.parse(tiersJson);
    } catch {
      setErr('Tiers must be valid JSON');
      return;
    }
    const patch = {
      enabled,
      buybackSpreadBps: Math.round(parseFloat(spread) * 100),
      maxPrizeUsd: parseInt(maxPrize, 10),
      bigWinUsd: parseInt(bigWin, 10),
      tiers,
    };
    act(() => api.adminSetGamesConfig({ packRip: patch }, adminKey), 'Saved. (Restart the API if a value doesn’t apply within ~30s.)');
  };

  const seed = () => act(
    async () => { const r = await api.adminSeedGamePool(parseFloat(seedAmt), adminKey); setSeedAmt(''); return r; },
    (r) => `GAME_POOL seeded — balance ${formatUsd(BigInt(r.poolE6))}.`,
  );

  if (!view) return <p className="ref-blurb">{err || 'Loading games config…'}</p>;

  return (
    <div className="games-admin">
      <h3 style={{ marginTop: '1rem' }}>Games — bankroll</h3>
      <div className="admin-stats">
        <div className="stat-card"><span className="sc-label">GAME_POOL balance</span><span className="sc-val">{formatUsd(BigInt(view.poolE6))}</span></div>
      </div>
      <div className="lp-form glass-card" style={{ maxWidth: 420 }}>
        <label className="field-label"><span>SEED GAME_POOL (play-money, USD)</span></label>
        <div className="field-input-wrap">
          <input type="number" min="0" value={seedAmt} onChange={(e) => setSeedAmt(e.target.value)} placeholder="0" />
          <span className="field-unit">USD</span>
        </div>
        <button className="btn-primary" disabled={busy || !seedAmt} onClick={seed}>Seed pool</button>
      </div>

      <h3 style={{ marginTop: '1.5rem' }}>Pack Rip</h3>
      {Array.isArray(view.packRipEv) && view.packRipEv.length > 0 && (
        <div className="games-admin-ev">
          <span className="sc-label">House edge vs the live pool (check before enabling)</span>
          <table className="games-ev-table">
            <thead><tr><th>Tier</th><th>Exp. payout</th><th>House edge</th><th>Bands</th></tr></thead>
            <tbody>
              {view.packRipEv.map((e) => (
                <tr key={e.tier} className={e.houseEdgeBps < 0 ? 'ev-negative' : ''}>
                  <td>${e.tier}</td>
                  <td>{formatUsd(BigInt(e.expectedPayoutE6))}</td>
                  <td>{(e.houseEdgeBps / 100).toFixed(1)}%</td>
                  <td>{e.eligibleBands === 0 ? '⚠ none in pool' : e.eligibleBands}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Negative edge (red) or “none in pool” means the tier would lose money against the {view.packRipEv[0]?.poolSize ?? 0} featured cards — retune the bands or pause the tier.</p>
        </div>
      )}
      <label className="games-admin-row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
      </label>
      <div className="games-admin-fields">
        <label className="field-label"><span>Buyback spread (%)</span>
          <input type="number" step="0.1" value={spread} onChange={(e) => setSpread(e.target.value)} />
        </label>
        <label className="field-label"><span>Max prize (USD)</span>
          <input type="number" value={maxPrize} onChange={(e) => setMaxPrize(e.target.value)} />
        </label>
        <label className="field-label"><span>Big-win threshold (USD)</span>
          <input type="number" value={bigWin} onChange={(e) => setBigWin(e.target.value)} />
        </label>
      </div>
      <label className="field-label"><span>Tiers + bands (JSON)</span></label>
      <textarea className="games-admin-json" rows={12} value={tiersJson} onChange={(e) => setTiersJson(e.target.value)} />
      <button className="btn-primary" disabled={busy} onClick={saveScalars}>Save Pack Rip config</button>

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}
    </div>
  );
}
