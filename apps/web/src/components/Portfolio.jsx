import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../auth/AuthContext';
import { FaucetButton } from './FaucetButton';
import { WalletPanel } from './WalletPanel';
import { OpenPositions } from './OpenPositions';
import { PositionHistory } from './PositionHistory';
import { ReferralPanel } from './ReferralPanel';
import * as api from '../lib/api.js';

export function Portfolio({ markets, onSelect }) {
  const { user } = useAuth();
  const [balance, setBalance] = useState(null);
  const [positions, setPositions] = useState([]);
  const [lp, setLp] = useState(null);
  const [realFunds, setRealFunds] = useState(false);
  const [posTab, setPosTab] = useState('open'); // 'open' | 'history'
  const [history, setHistory] = useState(null);

  useEffect(() => {
    api.getHealth().then((h) => setRealFunds(Boolean(h.realFunds))).catch(() => {});
  }, []);

  // load closed-position history on demand (when the History tab is opened)
  useEffect(() => {
    if (!user || posTab !== 'history') return;
    let alive = true;
    setHistory(null); // show "Loading…" instead of stale rows while (re)fetching
    api.getPositionHistory().then((r) => alive && setHistory(r.positions)).catch(() => {});
    return () => { alive = false; };
  }, [user, posTab]);

  const refresh = useCallback(() => {
    if (!user) return;
    api.getBalance().then(setBalance).catch(() => {});
    api.getPositions().then((r) => setPositions(r.positions)).catch(() => {});
    api.getLpPosition().then(setLp).catch(() => {});
  }, [user]);

  useEffect(() => {
    refresh();
    if (!user) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, user]);

  if (!user) {
    return (
      <div className="page">
        <div className="empty-state">Connect &amp; sign in to view your portfolio.</div>
      </div>
    );
  }

  const v = balance || {};
  const stat = (e6) => (e6 == null ? '—' : formatUsd(BigInt(e6)));
  const pnlUp = v.unrealizedPnlUusdc && BigInt(v.unrealizedPnlUusdc) >= 0n;

  return (
    <div className="page portfolio">
      <h2>Portfolio</h2>
      <div className="stat-cards">
        <div className="stat-card"><span className="sc-label">Equity</span><span className="sc-val">{stat(v.equityUusdc)}</span></div>
        <div className="stat-card"><span className="sc-label">Available</span><span className="sc-val">{stat(v.availableUusdc)}</span></div>
        <div className="stat-card"><span className="sc-label">Margin Locked</span><span className="sc-val">{stat(v.lockedMarginUusdc)}</span></div>
        <div className="stat-card"><span className="sc-label">LP Pool</span><span className="sc-val">{stat(lp?.valueUusdc)}</span></div>
        <div className="stat-card"><span className="sc-label">Cashback</span><span className={`sc-val ${BigInt(v.cashbackTotalUusdc || 0) > 0n ? 'up' : ''}`}>{stat(v.cashbackTotalUusdc)}</span></div>
        <div className="stat-card"><span className="sc-label">Unrealized PnL</span><span className={`sc-val ${pnlUp ? 'up' : 'down'}`}>{stat(v.unrealizedPnlUusdc)}</span></div>
      </div>
      <div style={{ margin: '1rem 0' }}>
        <FaucetButton onFunded={refresh} className="btn-primary" />
      </div>
      {realFunds && <WalletPanel onChanged={refresh} />}
      <div className="pf-pos-head">
        <h3>Positions</h3>
        <div className="sub-tabs">
          <button className={`sub-tab-btn ${posTab === 'open' ? 'active' : ''}`} onClick={() => setPosTab('open')}>Open</button>
          <button className={`sub-tab-btn ${posTab === 'history' ? 'active' : ''}`} onClick={() => setPosTab('history')}>History</button>
        </div>
      </div>
      {posTab === 'open' ? (
        <OpenPositions
          positions={positions}
          onChanged={refresh}
          onSelect={(mid) => {
            const m = markets.find((x) => x.id === mid);
            if (m) onSelect(m);
          }}
        />
      ) : (
        <PositionHistory
          positions={history}
          onSelect={(mid) => {
            const m = markets.find((x) => x.id === mid);
            if (m) onSelect(m);
          }}
        />
      )}

      <ReferralPanel onRedeemed={refresh} cashbackTotalUusdc={v.cashbackTotalUusdc} />
    </div>
  );
}
