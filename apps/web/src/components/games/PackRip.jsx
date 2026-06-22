import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../../auth/AuthContext';
import { thumbSrc } from '../../lib/thumb.js';
import * as api from '../../lib/api.js';
import { useGames } from '../../store/games.js';
import { GamesFairnessModal } from '../GamesFairnessModal.jsx';

const cardThumb = (c) => thumbSrc({ imageSmall: c?.imageSmall, kind: 'card' });

// One revealed card: image + name + live value, with sell/keep/trade actions.
function Reveal({ card, onSell, onKeep, onTrade, busy }) {
  return (
    <div className="rip-reveal glass-card">
      <div className="rip-card">
        {cardThumb(card) ? <img src={cardThumb(card)} alt="" className="rip-card-img" /> : <span className="rip-card-img idx-thumb">🎴</span>}
        <div className="rip-card-meta">
          <span className="rip-card-name">{card.displayName}</span>
          <span className="rip-card-val">{formatUsd(BigInt(card.valueE6))}</span>
        </div>
      </div>
      <div className="rip-actions">
        <button className="btn-primary" disabled={busy} onClick={onSell}>Sell back · {formatUsd(BigInt(card.valueE6))}</button>
        <button className="btn-ghost" disabled={busy} onClick={onKeep}>Keep</button>
        <button className="btn-ghost" disabled={busy} onClick={onTrade}>Trade</button>
      </div>
    </div>
  );
}

export function PackRip({ config, onTradeMarket }) {
  const { user } = useAuth();
  const tiers = config?.tiers ?? [];
  const [pickedTier, setPickedTier] = useState(null);
  const tier = pickedTier ?? tiers[0] ?? null; // default to the cheapest pack until one is picked
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState(null); // the current held reveal
  const [balanceE6, setBalanceE6] = useState(null);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [showFair, setShowFair] = useState(false);
  const feed = useGames((s) => s.feed);

  const refreshBalance = useCallback(() => {
    if (user) api.getBalance().then((b) => setBalanceE6(b.availableUusdc)).catch(() => {});
  }, [user]);
  useEffect(() => { refreshBalance(); }, [refreshBalance]);

  const rip = async () => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const r = await api.packRipOpen(tier, crypto.randomUUID());
      setCard(r.card);
      setBalanceE6(r.balanceE6);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const sell = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api.packRipSellBack(card.prizeId);
      setBalanceE6(r.balanceE6);
      setMsg(`Sold for ${formatUsd(BigInt(r.payoutE6))} — added to your balance.`);
      setCard(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const keep = () => {
    setMsg('Kept! On-chain card minting is coming soon — for now it stays in your pulls.');
    setCard(null);
  };
  const trade = () => {
    if (onTradeMarket && card?.marketId) onTradeMarket({ id: card.marketId });
  };

  if (!user) return <div className="empty-state">Connect &amp; sign in to play.</div>;

  return (
    <div className="rip">
      <div className="rip-head">
        <h2>🎴 Pack Rip</h2>
        <div className="rip-head-right">
          <span className="muted">Balance: {balanceE6 != null ? formatUsd(BigInt(balanceE6)) : '—'}</span>
          <button className="link" onClick={() => setShowFair(true)}>Provably fair</button>
        </div>
      </div>
      <p className="muted">Pick a pack, rip it, and reveal a card. Sell it back instantly for USDC at its live price.</p>

      <div className="rip-tiers">
        {tiers.map((t) => (
          <button key={t} className={`rip-tier ${tier === t ? 'active' : ''}`} onClick={() => setPickedTier(t)} disabled={busy}>
            ${t}
          </button>
        ))}
      </div>
      <button className="btn-primary rip-go" disabled={busy || tier == null} onClick={rip}>
        {busy && !card ? 'Ripping…' : `Rip ${tier != null ? `$${tier}` : ''} pack`}
      </button>

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}

      {card && <Reveal card={card} onSell={sell} onKeep={keep} onTrade={trade} busy={busy} />}

      {feed.length > 0 && (
        <div className="rip-feed">
          <h3>Recent pulls</h3>
          <ul>
            {feed.map((f) => (
              <li key={f.id}>
                <span className="rip-feed-who">{f.handle}</span> pulled{' '}
                <b>{f.displayName}</b> <span className="rip-feed-val">{formatUsd(BigInt(f.valueE6))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showFair && <GamesFairnessModal onClose={() => setShowFair(false)} />}
    </div>
  );
}
