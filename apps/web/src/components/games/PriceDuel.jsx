import { useState, useEffect, useCallback, useRef } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../../auth/AuthContext';
import { thumbSrc } from '../../lib/thumb.js';
import * as api from '../../lib/api.js';

const cardThumb = (c) => thumbSrc({ imageSmall: c?.imageSmall, kind: 'card' });

// Pick a featured card to champion (searchable). Cards only — they're what moves in a duel.
function CardPicker({ onPick, busy }) {
  const [markets, setMarkets] = useState([]);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.getMarkets().then((r) => setMarkets((r.markets || []).filter((m) => m.kind === 'card' && m.markE6))).catch(() => {});
  }, []);
  const filtered = markets.filter((m) => m.displayName.toLowerCase().includes(q.toLowerCase())).slice(0, 48);
  return (
    <div className="duel-picker">
      <input className="duel-search" placeholder="Search a card to champion…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="duel-cards">
        {filtered.map((m) => (
          <button key={m.id} className="duel-pick" disabled={busy} onClick={() => onPick(m)}>
            {cardThumb(m) ? <img src={cardThumb(m)} alt="" className="duel-pick-img" /> : <span className="duel-pick-img idx-thumb">🎴</span>}
            <span className="duel-pick-name">{m.displayName}</span>
            <span className="duel-pick-val">{formatUsd(BigInt(m.markE6))}</span>
          </button>
        ))}
        {filtered.length === 0 && <span className="muted">No cards match.</span>}
      </div>
    </div>
  );
}

function DuelCard({ label, card, hidden }) {
  const show = card && !hidden;
  return (
    <div className="duel-card">
      <span className="duel-card-label">{label}</span>
      {show
        ? (cardThumb(card) ? <img src={cardThumb(card)} alt="" className="duel-card-img" /> : <span className="duel-card-img idx-thumb">🎴</span>)
        : <span className="duel-card-img idx-thumb">❓</span>}
      <span className="duel-card-name">{show ? card.displayName : 'hidden'}</span>
    </div>
  );
}

export function PriceDuel({ config }) {
  const { user } = useAuth();
  const [duel, setDuel] = useState(undefined); // undefined = loading, null = none, obj = a duel
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const idRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const r = idRef.current ? await api.getDuelById(idRef.current) : await api.getMyDuel();
      setDuel(r.duel ?? null);
      idRef.current = r.duel ? r.duel.duelId : null;
    } catch { setDuel((d) => (d === undefined ? null : d)); }
  }, [user]);
  useEffect(() => { refresh(); }, [refresh]);
  // Poll while waiting for a match (open) or for the window to close (active).
  useEffect(() => {
    if (!duel || (duel.status !== 'open' && duel.status !== 'active')) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [duel, refresh]);

  const pick = async (market) => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const v = await api.duelJoin(market.id, crypto.randomUUID());
      idRef.current = v.duelId;
      setDuel(v);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const cancel = async () => {
    setErr(null); setBusy(true);
    try {
      await api.duelCancel(duel.duelId);
      setMsg('Duel cancelled — your ante was refunded.');
      idRef.current = null; setDuel(null);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const next = () => { idRef.current = null; setDuel(null); setMsg(null); setErr(null); refresh(); };

  if (!user) return <div className="empty-state">Connect &amp; sign in to play.</div>;

  return (
    <div className="duel">
      <div className="rip-head">
        <h2>⚔️ Price Duel</h2>
        <span className="muted">Ante ${config?.anteUsd ?? '—'} · {config?.windowHours ?? '—'}h window · {config ? (config.rakeBps / 100).toFixed(1) : '—'}% rake</span>
      </div>
      <p className="muted">Pick a card you think will pump. We match you 1v1 — over {config?.windowHours ?? ''}h the bigger %-move takes the pot.</p>

      {duel === undefined && <p className="muted">Loading…</p>}
      {duel === null && <CardPicker onPick={pick} busy={busy} />}

      {duel && (
        <div className="duel-arena glass-card">
          <div className="duel-vs">
            <DuelCard label="You" card={duel.yourCard} />
            <span className="duel-vs-x">VS</span>
            <DuelCard label="Opponent" card={duel.oppCard} hidden={!duel.oppCard} />
          </div>

          {duel.status === 'open' && (
            <div className="duel-wait">
              <p className="muted">Finding an opponent…</p>
              <button className="btn-ghost" disabled={busy} onClick={cancel}>Cancel &amp; refund</button>
            </div>
          )}
          {duel.status === 'active' && (
            <p className="muted duel-live">⏳ Live — settles {duel.closeAt ? new Date(duel.closeAt).toLocaleString() : 'soon'}. Bigger %-move wins.</p>
          )}
          {duel.status === 'settled' && duel.result && (
            <div className={`duel-result ${duel.result.youWon ? 'up' : duel.result.winner === 'tie' ? '' : 'down'}`}>
              <h3>{duel.result.winner === 'tie' ? 'Tie — antes refunded.' : duel.result.youWon ? `You won ${formatUsd(BigInt(duel.result.payoutE6))}!` : 'Your card lost this one.'}</h3>
              <button className="btn-primary" onClick={next}>New duel</button>
            </div>
          )}
          {duel.status === 'cancelled' && (
            <div className="duel-result"><p>Cancelled — refunded.</p><button className="btn-primary" onClick={next}>New duel</button></div>
          )}
        </div>
      )}

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}
    </div>
  );
}
