import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../auth/AuthContext';
import * as api from '../lib/api.js';

export function PoolView() {
  const { user } = useAuth();
  const [pool, setPool] = useState(null);
  const [lp, setLp] = useState(null);
  const [amt, setAmt] = useState('');
  const [shares, setShares] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const refresh = useCallback(() => {
    api.getPool().then(setPool).catch(() => {});
    if (user) api.getLpPosition().then(setLp).catch(() => {});
  }, [user]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  const sharePrice = pool ? Number(pool.sharePriceE6) / 1e6 : 1;
  const d = pool?.display; // operator-published display snapshot (fee shares, NAV gain, APY)
  const act = async (fn) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      setAmt('');
      setShares('');
      refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page pool">
      <h2>Liquidity Pool</h2>
      <p className="muted">LPs are the counterparty to every trade — you earn fees + funding and bear net trader PnL.</p>
      <div className="stat-cards">
        <div className="stat-card"><span className="sc-label">Pool TVL</span><span className="sc-val">{pool ? formatUsd(BigInt(pool.navUusdc)) : '—'}</span></div>
        <div className="stat-card"><span className="sc-label">Share Price</span><span className="sc-val">${sharePrice.toFixed(4)}</span></div>
        <div className="stat-card"><span className="sc-label">Reserved (open OI)</span><span className="sc-val">{pool ? formatUsd(BigInt(pool.reservedUusdc)) : '—'}</span></div>
        <div className="stat-card"><span className="sc-label">Your Stake</span><span className="sc-val">{lp ? formatUsd(BigInt(lp.valueUusdc)) : '—'}</span></div>
      </div>
      <div className="stat-cards">
        <div className="stat-card"><span className="sc-label">Total Fees Earned</span><span className="sc-val">{d ? formatUsd(BigInt(d.totalFeesEarnedE6)) : '—'}</span></div>
        <div className="stat-card"><span className="sc-label">APY (7d)</span><span className="sc-val">{d ? `${d.apyPct.toLocaleString()}%` : '—'}</span></div>
      </div>

      {!user ? (
        <div className="empty-state">Connect &amp; sign in to provide liquidity.</div>
      ) : (
        <div className="lp-forms">
          <div className="lp-form glass-card">
            <label className="field-label"><span>PROVIDE (USDC)</span></label>
            <div className="field-input-wrap">
              <input type="number" min="0" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0" />
              <span className="field-unit">USDC</span>
            </div>
            <button className="btn-primary" disabled={busy || !amt} onClick={() => act(() => api.lpDeposit(parseFloat(amt)))}>
              Provide
            </button>
          </div>
          <div className="lp-form glass-card">
            <label className="field-label">
              <span>WITHDRAW (shares)</span>
              <button className="link" type="button" onClick={() => lp && setShares(lp.shares)}>max {lp ? Number(lp.shares).toLocaleString() : 0}</button>
            </label>
            <div className="field-input-wrap">
              <input type="text" value={shares} onChange={(e) => setShares(e.target.value.replace(/[^\d]/g, ''))} placeholder="0" />
              <span className="field-unit">shares</span>
            </div>
            <button className="btn-ghost" disabled={busy || !shares} onClick={() => act(() => api.lpWithdraw(shares))}>
              Withdraw
            </button>
          </div>
        </div>
      )}

      {d && (
        <div className="lp-fee-sources">
          <h3 className="lp-fee-sources-title">LP Fee Sources</h3>
          <p className="muted lp-fee-sources-sub">The share of each revenue stream that flows to liquidity providers.</p>
          <div className="stat-cards">
            <div className="stat-card"><span className="sc-label">Trading Fees</span><span className="sc-val">{d.lpTradingPct}%</span><span className="sc-sub">of Trading Fees</span></div>
            <div className="stat-card"><span className="sc-label">Funding Fees</span><span className="sc-val">{d.lpFundingPct}%</span><span className="sc-sub">of current Funding Fees</span></div>
            <div className="stat-card"><span className="sc-label">Liquidations</span><span className="sc-val">{d.lpLiquidationPct}%</span><span className="sc-sub">of Liquidation Fees</span></div>
          </div>
        </div>
      )}
      {err && <div className="order-error">{err}</div>}
    </div>
  );
}
