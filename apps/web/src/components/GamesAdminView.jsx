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
  // Set Poker drafts
  const [spEnabled, setSpEnabled] = useState(false);
  const [spAnte, setSpAnte] = useState('');
  const [spSwapFee, setSpSwapFee] = useState('');
  const [spMaxSwaps, setSpMaxSwaps] = useState('');
  const [spSpread, setSpSpread] = useState('');
  const [spMaxPrize, setSpMaxPrize] = useState('');
  const [spBigWin, setSpBigWin] = useState('');
  const [spBandsJson, setSpBandsJson] = useState('');
  // Grade Gamble drafts
  const [ggEnabled, setGgEnabled] = useState(false);
  const [ggSpread, setGgSpread] = useState('');
  const [ggMaxPrize, setGgMaxPrize] = useState('');
  const [ggBigWin, setGgBigWin] = useState('');
  const [ggTiersJson, setGgTiersJson] = useState('');
  const [ggGradesJson, setGgGradesJson] = useState('');
  // The Break drafts
  const [tbEnabled, setTbEnabled] = useState(false);
  const [tbSpots, setTbSpots] = useState('');
  const [tbEntry, setTbEntry] = useState('');
  const [tbSpread, setTbSpread] = useState('');
  const [tbMaxPrize, setTbMaxPrize] = useState('');
  const [tbBigWin, setTbBigWin] = useState('');
  const [tbBandsJson, setTbBandsJson] = useState('');
  const [tbCancelId, setTbCancelId] = useState('');
  // Price Duel drafts
  const [pdEnabled, setPdEnabled] = useState(false);
  const [pdAnte, setPdAnte] = useState('');
  const [pdWindow, setPdWindow] = useState('');
  const [pdRake, setPdRake] = useState('');
  const [pdBigWin, setPdBigWin] = useState('');
  // Card Fantasy drafts
  const [cfEnabled, setCfEnabled] = useState(false);
  const [cfEntry, setCfEntry] = useState('');
  const [cfCap, setCfCap] = useState('');
  const [cfRoster, setCfRoster] = useState('');
  const [cfWindow, setCfWindow] = useState('');
  const [cfRake, setCfRake] = useState('');
  const [cfMin, setCfMin] = useState('');
  const [cfBigWin, setCfBigWin] = useState('');

  const load = useCallback(() => {
    return api.adminGetGamesConfig(adminKey).then((v) => {
      setView(v);
      const pr = v.packRip;
      setEnabled(pr.enabled);
      setSpread((pr.buybackSpreadBps / 100).toString());
      setMaxPrize(String(pr.maxPrizeUsd));
      setBigWin(String(pr.bigWinUsd));
      setTiersJson(JSON.stringify(pr.tiers, null, 2));
      const sp = v.setPoker;
      setSpEnabled(sp.enabled);
      setSpAnte(String(sp.anteUsd));
      setSpSwapFee(String(sp.swapFeeUsd));
      setSpMaxSwaps(String(sp.maxSwaps));
      setSpSpread((sp.buybackSpreadBps / 100).toString());
      setSpMaxPrize(String(sp.maxPrizeUsd));
      setSpBigWin(String(sp.bigWinUsd));
      setSpBandsJson(JSON.stringify(sp.bands, null, 2));
      const gg = v.gradeGamble;
      setGgEnabled(gg.enabled);
      setGgSpread((gg.buybackSpreadBps / 100).toString());
      setGgMaxPrize(String(gg.maxPrizeUsd));
      setGgBigWin(String(gg.bigWinUsd));
      setGgTiersJson(JSON.stringify(gg.tiers, null, 2));
      setGgGradesJson(JSON.stringify(gg.grades, null, 2));
      const tb = v.theBreak;
      setTbEnabled(tb.enabled);
      setTbSpots(String(tb.spots));
      setTbEntry(String(tb.entryUsd));
      setTbSpread((tb.buybackSpreadBps / 100).toString());
      setTbMaxPrize(String(tb.maxPrizeUsd));
      setTbBigWin(String(tb.bigWinUsd));
      setTbBandsJson(JSON.stringify(tb.bands, null, 2));
      const pd = v.priceDuel;
      setPdEnabled(pd.enabled);
      setPdAnte(String(pd.anteUsd));
      setPdWindow(String(pd.windowHours));
      setPdRake((pd.rakeBps / 100).toString());
      setPdBigWin(String(pd.bigWinUsd));
      const cf = v.cardFantasy;
      setCfEnabled(cf.enabled);
      setCfEntry(String(cf.entryUsd));
      setCfCap(String(cf.capUsd));
      setCfRoster(String(cf.rosterSize));
      setCfWindow(String(cf.windowHours));
      setCfRake((cf.rakeBps / 100).toString());
      setCfMin(String(cf.minEntries));
      setCfBigWin(String(cf.bigWinUsd));
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

  const saveSetPoker = () => {
    let bands;
    try {
      bands = JSON.parse(spBandsJson);
    } catch {
      setErr('Set Poker bands must be valid JSON');
      return;
    }
    const patch = {
      enabled: spEnabled,
      anteUsd: parseInt(spAnte, 10),
      swapFeeUsd: parseInt(spSwapFee, 10),
      maxSwaps: parseInt(spMaxSwaps, 10),
      buybackSpreadBps: Math.round(parseFloat(spSpread) * 100),
      maxPrizeUsd: parseInt(spMaxPrize, 10),
      bigWinUsd: parseInt(spBigWin, 10),
      bands,
    };
    act(() => api.adminSetGamesConfig({ setPoker: patch }, adminKey), 'Saved. (Restart the API if a value doesn’t apply within ~30s.)');
  };

  const saveGradeGamble = () => {
    let tiers, grades;
    try {
      tiers = JSON.parse(ggTiersJson);
      grades = JSON.parse(ggGradesJson);
    } catch {
      setErr('Grade Gamble tiers + grades must be valid JSON');
      return;
    }
    const patch = {
      enabled: ggEnabled,
      buybackSpreadBps: Math.round(parseFloat(ggSpread) * 100),
      maxPrizeUsd: parseInt(ggMaxPrize, 10),
      bigWinUsd: parseInt(ggBigWin, 10),
      tiers,
      grades,
    };
    act(() => api.adminSetGamesConfig({ gradeGamble: patch }, adminKey), 'Saved. (Restart the API if a value doesn’t apply within ~30s.)');
  };

  const saveTheBreak = () => {
    let bands;
    try {
      bands = JSON.parse(tbBandsJson);
    } catch {
      setErr('The Break bands must be valid JSON');
      return;
    }
    const patch = {
      enabled: tbEnabled,
      spots: parseInt(tbSpots, 10),
      entryUsd: parseInt(tbEntry, 10),
      buybackSpreadBps: Math.round(parseFloat(tbSpread) * 100),
      maxPrizeUsd: parseInt(tbMaxPrize, 10),
      bigWinUsd: parseInt(tbBigWin, 10),
      bands,
    };
    act(() => api.adminSetGamesConfig({ theBreak: patch }, adminKey), 'Saved. (Restart the API if a value doesn’t apply within ~30s.)');
  };
  const cancelBreak = () => act(
    async () => { const r = await api.adminCancelBreak(tbCancelId.trim(), adminKey); setTbCancelId(''); return r; },
    (r) => `Case cancelled — ${r.refunded} entrant(s) refunded.`,
  );

  const savePriceDuel = () => {
    const patch = {
      enabled: pdEnabled,
      anteUsd: parseInt(pdAnte, 10),
      windowHours: parseInt(pdWindow, 10),
      rakeBps: Math.round(parseFloat(pdRake) * 100),
      bigWinUsd: parseInt(pdBigWin, 10),
    };
    act(() => api.adminSetGamesConfig({ priceDuel: patch }, adminKey), 'Saved. (Restart the API if a value doesn’t apply within ~30s.)');
  };

  const saveCardFantasy = () => {
    const patch = {
      enabled: cfEnabled,
      entryUsd: parseInt(cfEntry, 10),
      capUsd: parseInt(cfCap, 10),
      rosterSize: parseInt(cfRoster, 10),
      windowHours: parseInt(cfWindow, 10),
      rakeBps: Math.round(parseFloat(cfRake) * 100),
      minEntries: parseInt(cfMin, 10),
      bigWinUsd: parseInt(cfBigWin, 10),
    };
    act(() => api.adminSetGamesConfig({ cardFantasy: patch }, adminKey), 'Saved. (Restart the API if a value doesn’t apply within ~30s.)');
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

      <h3 style={{ marginTop: '1.5rem' }}>Set Poker</h3>
      {view.setPokerEv && (
        <div className="games-admin-ev">
          <span className="sc-label">House edge vs the live pool (stand-pat estimate — check before enabling)</span>
          <table className="games-ev-table">
            <thead><tr><th>Win rate</th><th>Avg prize / hand</th><th>House edge</th><th>Bands</th></tr></thead>
            <tbody>
              <tr className={view.setPokerEv.houseEdgeBps < 0 ? 'ev-negative' : ''}>
                <td>{view.setPokerEv.winRatePct}%</td>
                <td>{formatUsd(BigInt(view.setPokerEv.avgPrizePaidE6))}</td>
                <td>{(view.setPokerEv.houseEdgeBps / 100).toFixed(1)}%</td>
                <td>{view.setPokerEv.eligibleBands === 0 ? '⚠ none in pool' : view.setPokerEv.eligibleBands}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted">Monte-Carlo over {view.setPokerEv.samples} stand-pat hands vs {view.setPokerEv.poolSize} cards (real play adds swap-fee revenue + lifts the win rate). Negative edge (red) loses money — retune the ante or bands.</p>
        </div>
      )}
      <label className="games-admin-row">
        <input type="checkbox" checked={spEnabled} onChange={(e) => setSpEnabled(e.target.checked)} /> Enabled
      </label>
      <div className="games-admin-fields">
        <label className="field-label"><span>Ante (USD)</span><input type="number" value={spAnte} onChange={(e) => setSpAnte(e.target.value)} /></label>
        <label className="field-label"><span>Swap fee (USD)</span><input type="number" value={spSwapFee} onChange={(e) => setSpSwapFee(e.target.value)} /></label>
        <label className="field-label"><span>Max swaps</span><input type="number" value={spMaxSwaps} onChange={(e) => setSpMaxSwaps(e.target.value)} /></label>
        <label className="field-label"><span>Buyback spread (%)</span><input type="number" step="0.1" value={spSpread} onChange={(e) => setSpSpread(e.target.value)} /></label>
        <label className="field-label"><span>Max prize (USD)</span><input type="number" value={spMaxPrize} onChange={(e) => setSpMaxPrize(e.target.value)} /></label>
        <label className="field-label"><span>Big-win threshold (USD)</span><input type="number" value={spBigWin} onChange={(e) => setSpBigWin(e.target.value)} /></label>
      </div>
      <label className="field-label"><span>Deal value bands (JSON)</span></label>
      <textarea className="games-admin-json" rows={8} value={spBandsJson} onChange={(e) => setSpBandsJson(e.target.value)} />
      <button className="btn-primary" disabled={busy} onClick={saveSetPoker}>Save Set Poker config</button>

      <h3 style={{ marginTop: '1.5rem' }}>Grade Gamble</h3>
      {view.gradeGambleEv && (
        <div className="games-admin-ev">
          <span className="sc-label">House edge vs the live pool — E[grade] {(view.gradeGambleEv.expGradeMultBps / 10000).toFixed(2)}× (check before enabling)</span>
          <table className="games-ev-table">
            <thead><tr><th>Tier</th><th>Exp. payout</th><th>House edge</th><th>Bands</th></tr></thead>
            <tbody>
              {view.gradeGambleEv.tiers.map((e) => (
                <tr key={e.tier} className={e.houseEdgeBps < 0 ? 'ev-negative' : ''}>
                  <td>${e.tier}</td>
                  <td>{formatUsd(BigInt(e.expectedPayoutE6))}</td>
                  <td>{(e.houseEdgeBps / 100).toFixed(1)}%</td>
                  <td>{e.eligibleBands === 0 ? '⚠ none in pool' : e.eligibleBands}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Edge = ante − E[base card] × E[grade] × (1 − spread). Negative (red) loses money — retune the ante, bands, or grade table.</p>
        </div>
      )}
      <label className="games-admin-row">
        <input type="checkbox" checked={ggEnabled} onChange={(e) => setGgEnabled(e.target.checked)} /> Enabled
      </label>
      <div className="games-admin-fields">
        <label className="field-label"><span>Buyback spread (%)</span><input type="number" step="0.1" value={ggSpread} onChange={(e) => setGgSpread(e.target.value)} /></label>
        <label className="field-label"><span>Max prize (USD)</span><input type="number" value={ggMaxPrize} onChange={(e) => setGgMaxPrize(e.target.value)} /></label>
        <label className="field-label"><span>Big-win threshold (USD)</span><input type="number" value={ggBigWin} onChange={(e) => setGgBigWin(e.target.value)} /></label>
      </div>
      <label className="field-label"><span>Tiers + base-card bands (JSON)</span></label>
      <textarea className="games-admin-json" rows={8} value={ggTiersJson} onChange={(e) => setGgTiersJson(e.target.value)} />
      <label className="field-label"><span>Grade table (JSON)</span></label>
      <textarea className="games-admin-json" rows={8} value={ggGradesJson} onChange={(e) => setGgGradesJson(e.target.value)} />
      <button className="btn-primary" disabled={busy} onClick={saveGradeGamble}>Save Grade Gamble config</button>

      <h3 style={{ marginTop: '1.5rem' }}>The Break</h3>
      {view.breakEv && (
        <div className="games-admin-ev">
          <span className="sc-label">Per-spot house edge vs the live pool (check before enabling)</span>
          <table className="games-ev-table">
            <thead><tr><th>Spots</th><th>Entry</th><th>Exp. card payout</th><th>House edge</th><th>Bands</th></tr></thead>
            <tbody>
              <tr className={view.breakEv.houseEdgeBps < 0 ? 'ev-negative' : ''}>
                <td>{view.breakEv.spots}</td>
                <td>${view.breakEv.entryUsd}</td>
                <td>{formatUsd(BigInt(view.breakEv.expCardPayoutE6))}</td>
                <td>{(view.breakEv.houseEdgeBps / 100).toFixed(1)}%</td>
                <td>{view.breakEv.eligibleBands === 0 ? '⚠ none in pool' : view.breakEv.eligibleBands}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted">Each spot wins one band-drawn card; edge = entry − E[card] × (1 − spread). Negative (red) loses money — retune the entry or bands.</p>
        </div>
      )}
      <label className="games-admin-row">
        <input type="checkbox" checked={tbEnabled} onChange={(e) => setTbEnabled(e.target.checked)} /> Enabled
      </label>
      <div className="games-admin-fields">
        <label className="field-label"><span>Spots / cards per case</span><input type="number" value={tbSpots} onChange={(e) => setTbSpots(e.target.value)} /></label>
        <label className="field-label"><span>Entry (USD)</span><input type="number" value={tbEntry} onChange={(e) => setTbEntry(e.target.value)} /></label>
        <label className="field-label"><span>Buyback spread (%)</span><input type="number" step="0.1" value={tbSpread} onChange={(e) => setTbSpread(e.target.value)} /></label>
        <label className="field-label"><span>Max prize (USD)</span><input type="number" value={tbMaxPrize} onChange={(e) => setTbMaxPrize(e.target.value)} /></label>
        <label className="field-label"><span>Big-win threshold (USD)</span><input type="number" value={tbBigWin} onChange={(e) => setTbBigWin(e.target.value)} /></label>
      </div>
      <label className="field-label"><span>Case card bands (JSON)</span></label>
      <textarea className="games-admin-json" rows={8} value={tbBandsJson} onChange={(e) => setTbBandsJson(e.target.value)} />
      <button className="btn-primary" disabled={busy} onClick={saveTheBreak}>Save The Break config</button>
      <div className="games-admin-fields" style={{ marginTop: '0.8rem' }}>
        <label className="field-label" style={{ flex: 2 }}><span>Cancel + refund an open case (round id)</span>
          <input value={tbCancelId} onChange={(e) => setTbCancelId(e.target.value)} placeholder="round id" />
        </label>
        <button className="btn-ghost" disabled={busy || !tbCancelId.trim()} onClick={cancelBreak} style={{ alignSelf: 'flex-end' }}>Cancel case</button>
      </div>

      <h3 style={{ marginTop: '1.5rem' }}>Price Duel</h3>
      <p className="muted">Skill PvP — the house edge is the rake on each decisive pot (a tie refunds both, no rake).</p>
      <label className="games-admin-row">
        <input type="checkbox" checked={pdEnabled} onChange={(e) => setPdEnabled(e.target.checked)} /> Enabled
      </label>
      <div className="games-admin-fields">
        <label className="field-label"><span>Ante (USD)</span><input type="number" value={pdAnte} onChange={(e) => setPdAnte(e.target.value)} /></label>
        <label className="field-label"><span>Window (hours)</span><input type="number" value={pdWindow} onChange={(e) => setPdWindow(e.target.value)} /></label>
        <label className="field-label"><span>Rake (%) — the edge</span><input type="number" step="0.1" value={pdRake} onChange={(e) => setPdRake(e.target.value)} /></label>
        <label className="field-label"><span>Big-win threshold (USD)</span><input type="number" value={pdBigWin} onChange={(e) => setPdBigWin(e.target.value)} /></label>
      </div>
      <button className="btn-primary" disabled={busy} onClick={savePriceDuel}>Save Price Duel config</button>

      <h3 style={{ marginTop: '1.5rem' }}>Card Fantasy</h3>
      <p className="muted">DFS-style skill — the house edge is the rake on the prize pool. A league below min entries refunds everyone.</p>
      <label className="games-admin-row">
        <input type="checkbox" checked={cfEnabled} onChange={(e) => setCfEnabled(e.target.checked)} /> Enabled
      </label>
      <div className="games-admin-fields">
        <label className="field-label"><span>Entry (USD)</span><input type="number" value={cfEntry} onChange={(e) => setCfEntry(e.target.value)} /></label>
        <label className="field-label"><span>Salary cap (USD)</span><input type="number" value={cfCap} onChange={(e) => setCfCap(e.target.value)} /></label>
        <label className="field-label"><span>Roster size</span><input type="number" value={cfRoster} onChange={(e) => setCfRoster(e.target.value)} /></label>
        <label className="field-label"><span>Window (hours)</span><input type="number" value={cfWindow} onChange={(e) => setCfWindow(e.target.value)} /></label>
        <label className="field-label"><span>Rake (%) — the edge</span><input type="number" step="0.1" value={cfRake} onChange={(e) => setCfRake(e.target.value)} /></label>
        <label className="field-label"><span>Min entries</span><input type="number" value={cfMin} onChange={(e) => setCfMin(e.target.value)} /></label>
        <label className="field-label"><span>Big-win threshold (USD)</span><input type="number" value={cfBigWin} onChange={(e) => setCfBigWin(e.target.value)} /></label>
      </div>
      <button className="btn-primary" disabled={busy} onClick={saveCardFantasy}>Save Card Fantasy config</button>

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}
    </div>
  );
}
