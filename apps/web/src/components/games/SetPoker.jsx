import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../../auth/AuthContext';
import { thumbSrc } from '../../lib/thumb.js';
import * as api from '../../lib/api.js';
import { GamesFairnessModal } from '../GamesFairnessModal.jsx';

const cardThumb = (c) => thumbSrc({ imageSmall: c?.imageSmall, kind: 'card' });

// One card in a hand: thumb + value, with an optional Swap action on the player's row.
function HandCard({ card, swappable, onSwap, busy }) {
  return (
    <div className="sp-card">
      {cardThumb(card) ? <img src={cardThumb(card)} alt="" className="sp-card-img" /> : <span className="sp-card-img idx-thumb">🎴</span>}
      <span className="sp-card-val">{formatUsd(BigInt(card.valueE6))}</span>
      {swappable && <button className="btn-ghost sp-swap" disabled={busy} onClick={onSwap}>Swap</button>}
    </div>
  );
}

export function SetPoker({ config, onTradeMarket }) {
  const { user } = useAuth();
  const [hand, setHand] = useState(null); // SetPokerView | null
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [showFair, setShowFair] = useState(false);

  const load = useCallback(() => {
    if (user) api.getSetPokerHand().then((r) => setHand(r.hand)).catch(() => {});
  }, [user]);
  useEffect(() => { load(); }, [load]);

  // Run a deal/swap/settle call, replacing the hand with the returned view.
  const act = async (fn) => {
    setErr(null); setMsg(null); setBusy(true);
    try { setHand(await fn()); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const deal = () => act(() => api.setPokerDeal(crypto.randomUUID()));
  const swap = (slot) => act(() => api.setPokerSwap(slot, crypto.randomUUID()));
  const settle = () => act(() => api.setPokerSettle(hand?.playId));
  const sell = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api.sellGamePrize(hand.prize.prizeId);
      setMsg(`Sold for ${formatUsd(BigInt(r.payoutE6))} — added to your balance.`);
      setHand(null);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const newHand = () => { setHand(null); setMsg(null); setErr(null); };

  if (!user) return <div className="empty-state">Connect &amp; sign in to play.</div>;

  const open = hand && hand.status === 'open';
  const settled = hand && hand.status === 'settled';
  const swapsLeft = hand ? hand.maxSwaps - hand.swaps : 0;
  const ahead = hand && BigInt(hand.playerTotalE6) > BigInt(hand.houseTotalE6);

  return (
    <div className="sp">
      <div className="rip-head">
        <h2>🃏 Set Poker</h2>
        <div className="rip-head-right">
          <span className="muted">Balance: {hand?.balanceE6 != null ? formatUsd(BigInt(hand.balanceE6)) : '—'}</span>
          <button className="link" onClick={() => setShowFair(true)}>Provably fair</button>
        </div>
      </div>
      <p className="muted">
        Beat the house: your five cards’ combined value must top the house’s (ties go to the house).
        Pay ${config?.anteUsd ?? '—'} to deal, ${config?.swapFeeUsd ?? '—'} per swap. Win → take your highest card and sell it for USDC.
      </p>

      {!hand && (
        <button className="btn-primary rip-go" disabled={busy} onClick={deal}>{busy ? 'Dealing…' : `Deal — $${config?.anteUsd ?? ''}`}</button>
      )}

      {hand && (
        <div className="sp-table">
          <div className="sp-side">
            <div className="sp-side-head"><span>House</span><b className="sp-total">{formatUsd(BigInt(hand.houseTotalE6))}</b></div>
            <div className="sp-hand">{hand.house.map((c, i) => <HandCard key={i} card={c} />)}</div>
          </div>
          <div className="sp-side">
            <div className="sp-side-head">
              <span>You{open && ` · ${swapsLeft} swap${swapsLeft === 1 ? '' : 's'} left`}</span>
              <b className={`sp-total ${ahead ? 'up' : ''}`}>{formatUsd(BigInt(hand.playerTotalE6))}</b>
            </div>
            <div className="sp-hand">
              {hand.player.map((c, i) => <HandCard key={i} card={c} swappable={open && swapsLeft > 0} onSwap={() => swap(i)} busy={busy} />)}
            </div>
          </div>

          {open && <button className="btn-primary sp-settle" disabled={busy} onClick={settle}>{busy ? '…' : 'Stand & settle'}</button>}

          {settled && (
            <div className={`sp-result ${hand.won ? 'up' : 'down'}`}>
              {hand.won ? (
                <>
                  <p><b>You win!</b> You took {hand.prize?.displayName} — worth {formatUsd(BigInt(hand.prize?.valueE6 || '0'))}.</p>
                  <div className="rip-actions">
                    <button className="btn-primary" disabled={busy} onClick={sell}>Sell back · {formatUsd(BigInt(hand.prize?.valueE6 || '0'))}</button>
                    {onTradeMarket && hand.prize?.marketId && <button className="btn-ghost" onClick={() => onTradeMarket({ id: hand.prize.marketId })}>Trade</button>}
                    <button className="btn-ghost" disabled={busy} onClick={newHand}>New hand</button>
                  </div>
                </>
              ) : (
                <>
                  <p><b>House wins.</b> Your {formatUsd(BigInt(hand.playerTotalE6))} didn’t top {formatUsd(BigInt(hand.houseTotalE6))}.</p>
                  <button className="btn-primary" disabled={busy} onClick={newHand}>New hand</button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}
      {showFair && <GamesFairnessModal onClose={() => setShowFair(false)} />}
    </div>
  );
}
