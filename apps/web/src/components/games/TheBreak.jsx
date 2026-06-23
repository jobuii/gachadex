import { useState, useEffect, useCallback, useRef } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../../auth/AuthContext';
import { thumbSrc } from '../../lib/thumb.js';
import * as api from '../../lib/api.js';

const cardThumb = (c) => thumbSrc({ imageSmall: c?.imageSmall, kind: 'card' });

export function TheBreak({ config, onTradeMarket }) {
  const { user } = useAuth();
  const [round, setRound] = useState(null); // BreakView
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const roundIdRef = useRef(null); // the case we're engaged with (joined or watching)

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const r = roundIdRef.current ? await api.getBreakRound(roundIdRef.current) : await api.getBreak();
      setRound(r.round);
      roundIdRef.current = r.round ? r.round.roundId : null;
    } catch { /* ignore transient poll errors */ }
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);
  // Poll while a case is open so the bar fills + the break resolves live for everyone watching.
  useEffect(() => {
    if (!round || round.status !== 'open') return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [round, refresh]);

  const join = async () => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const r = await api.breakJoin(crypto.randomUUID());
      roundIdRef.current = r.roundId;
      setRound(r);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const sell = async (prizeId) => {
    setErr(null); setBusy(true);
    try {
      const r = await api.sellGamePrize(prizeId);
      setMsg(`Sold for ${formatUsd(BigInt(r.payoutE6))} — added to your balance.`);
      await refresh();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const next = () => { roundIdRef.current = null; setRound(null); setMsg(null); setErr(null); refresh(); };

  if (!user) return <div className="empty-state">Connect &amp; sign in to play.</div>;

  const open = round && round.status === 'open';
  const settled = round && round.status === 'settled';
  const cancelled = round && round.status === 'cancelled';
  // The case's cards, richest first (the chase) — the cards are public; the gamble is which spot wins which.
  const caseCards = round ? round.cards.map((c, i) => ({ ...c, i })).sort((a, b) => (BigInt(b.valueE6) > BigInt(a.valueE6) ? 1 : -1)) : [];
  const yourWins = settled ? round.yourSpots.filter((s) => s.card) : [];

  return (
    <div className="brk">
      <div className="rip-head">
        <h2>📦 The Break</h2>
        <span className="muted">Entry ${config?.entryUsd ?? '—'} · {config?.spots ?? '—'} spots</span>
      </div>
      <p className="muted">A shared case split into spots. Buy a spot; when the case fills, the cards are shuffled to spots and you keep yours — sell it back for USDC.</p>

      {!round && <button className="btn-primary rip-go" disabled={busy} onClick={join}>{busy ? 'Joining…' : `Buy a spot — $${config?.entryUsd ?? ''}`}</button>}

      {round && (
        <div className="brk-case glass-card">
          <div className="brk-progress">
            <div className="brk-bar"><div className="brk-fill" style={{ width: `${Math.round((round.filled / round.spots) * 100)}%` }} /></div>
            <span className="muted">{round.filled} / {round.spots} spots{open ? ' filled' : settled ? ' · broken!' : ' · cancelled'}</span>
          </div>

          <div className="brk-cards">
            {caseCards.map((c) => (
              <div key={c.i} className={`brk-card ${settled ? '' : 'sealed'}`}>
                {cardThumb(c) ? <img src={cardThumb(c)} alt="" className="brk-card-img" /> : <span className="brk-card-img idx-thumb">🎴</span>}
                <span className="brk-card-val">{formatUsd(BigInt(c.valueE6))}</span>
              </div>
            ))}
          </div>

          {open && (
            <div className="brk-actions">
              <span className="muted">You hold {round.yourSpots.length} spot{round.yourSpots.length === 1 ? '' : 's'} · waiting for the case to fill…</span>
              <button className="btn-primary" disabled={busy} onClick={join}>{busy ? '…' : `Buy ${round.yourSpots.length ? 'another' : 'a'} spot — $${round.entryUsd}`}</button>
            </div>
          )}

          {settled && (
            <div className="brk-result up">
              {yourWins.length > 0 ? (
                <>
                  <h3>You pulled {yourWins.length === 1 ? 'a card' : `${yourWins.length} cards`}!</h3>
                  <div className="brk-cards">
                    {yourWins.map((s, i) => (
                      <div key={i} className="brk-card brk-won">
                        {cardThumb(s.card) ? <img src={cardThumb(s.card)} alt="" className="brk-card-img" /> : <span className="brk-card-img idx-thumb">🎴</span>}
                        <span className="brk-card-name">{s.card.displayName}</span>
                        <span className="brk-card-val">{formatUsd(BigInt(s.card.valueE6))}</span>
                        <div className="rip-actions">
                          <button className="btn-primary" disabled={busy} onClick={() => sell(s.prizeId)}>Sell · {formatUsd(BigInt(s.card.valueE6))}</button>
                          {onTradeMarket && <button className="btn-ghost" onClick={() => onTradeMarket({ id: s.card.marketId })}>Trade</button>}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p>This case broke. You weren’t in it — join the next one!</p>
              )}
              <button className="btn-ghost" onClick={next}>Join the next break</button>
              {round.revealedServerSeed && (
                <p className="muted brk-fair">Provably fair — committed <code>{round.serverSeedHash?.slice(0, 12)}…</code>, revealed <code>{round.revealedServerSeed.slice(0, 12)}…</code> shuffles the cards to spots.</p>
              )}
            </div>
          )}
          {cancelled && (
            <div className="brk-result down">
              <p>This case was cancelled — your entry was refunded.</p>
              <button className="btn-primary" onClick={next}>Join a new break</button>
            </div>
          )}
        </div>
      )}

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}
    </div>
  );
}
