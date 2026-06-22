import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../../auth/AuthContext';
import { thumbSrc } from '../../lib/thumb.js';
import * as api from '../../lib/api.js';
import { GamesFairnessModal } from '../GamesFairnessModal.jsx';

const cardThumb = (c) => thumbSrc({ imageSmall: c?.imageSmall, kind: 'card' });
const mult = (bps) => `${(bps / 10000).toFixed(bps % 10000 === 0 ? 0 : 2)}×`;

export function GradeGamble({ config, onTradeMarket }) {
  const { user } = useAuth();
  const tiers = config?.tiers ?? [];
  const grades = config?.grades ?? [];
  const [pickedTier, setPickedTier] = useState(null);
  const tier = pickedTier ?? tiers[0] ?? null;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // GradeResult
  const [balanceE6, setBalanceE6] = useState(null);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [showFair, setShowFair] = useState(false);

  const refreshBalance = useCallback(() => {
    if (user) api.getBalance().then((b) => setBalanceE6(b.availableUusdc)).catch(() => {});
  }, [user]);
  useEffect(() => { refreshBalance(); }, [refreshBalance]);

  const grade = async () => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const r = await api.gradeOpen(tier, crypto.randomUUID());
      setResult(r);
      setBalanceE6(r.balanceE6);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const sell = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api.sellGamePrize(result.prizeId);
      setBalanceE6(r.balanceE6);
      setMsg(`Sold for ${formatUsd(BigInt(r.payoutE6))} — added to your balance.`);
      setResult(null);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const trade = () => { if (onTradeMarket && result?.card?.marketId) onTradeMarket({ id: result.card.marketId }); };
  const again = () => { setResult(null); setMsg(null); setErr(null); };

  if (!user) return <div className="empty-state">Connect &amp; sign in to play.</div>;

  return (
    <div className="rip gg">
      <div className="rip-head">
        <h2>🔍 Grade Gamble</h2>
        <div className="rip-head-right">
          <span className="muted">Balance: {balanceE6 != null ? formatUsd(BigInt(balanceE6)) : '—'}</span>
          <button className="link" onClick={() => setShowFair(true)}>Provably fair</button>
        </div>
      </div>
      <p className="muted">Submit a card for grading. A provably-fair grade — Damaged to PSA 10 — multiplies its value; sell the graded card back for USDC.</p>

      {!result && (
        <>
          {grades.length > 0 && (
            <div className="gg-odds">
              {grades.map((g) => <span key={g.label} className="gg-odd"><b>{g.label}</b> {mult(g.multBps)}</span>)}
            </div>
          )}
          <div className="rip-tiers">
            {tiers.map((t) => (
              <button key={t} className={`rip-tier ${tier === t ? 'active' : ''}`} onClick={() => setPickedTier(t)} disabled={busy}>${t}</button>
            ))}
          </div>
          <button className="btn-primary rip-go" disabled={busy || tier == null} onClick={grade}>
            {busy ? 'Grading…' : `Grade a card — $${tier ?? ''}`}
          </button>
        </>
      )}

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}

      {result && (
        <div className="rip-reveal glass-card">
          <div className="rip-card">
            {cardThumb(result.card) ? <img src={cardThumb(result.card)} alt="" className="rip-card-img" /> : <span className="rip-card-img idx-thumb">🎴</span>}
            <div className="rip-card-meta">
              <span className="rip-card-name">{result.card.displayName}</span>
              <span className="gg-grade">{result.grade.label} · {mult(result.grade.multBps)}</span>
              <span className="rip-card-val">{formatUsd(BigInt(result.card.gradedValueE6))}</span>
            </div>
          </div>
          <div className="rip-actions">
            <button className="btn-primary" disabled={busy} onClick={sell}>Sell back · {formatUsd(BigInt(result.card.gradedValueE6))}</button>
            {onTradeMarket && <button className="btn-ghost" disabled={busy} onClick={trade}>Trade</button>}
            <button className="btn-ghost" disabled={busy} onClick={again}>Grade another</button>
          </div>
        </div>
      )}

      {showFair && <GamesFairnessModal onClose={() => setShowFair(false)} />}
    </div>
  );
}
