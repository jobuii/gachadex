import { useState, useEffect, useCallback, useRef } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../../auth/AuthContext';
import { thumbSrc } from '../../lib/thumb.js';
import * as api from '../../lib/api.js';

const cardThumb = (c) => thumbSrc({ imageSmall: c?.imageSmall, kind: 'card' });
const fmtMove = (bps) => `${bps >= 0 ? '+' : ''}${(Number(bps) / 100).toFixed(1)}%`;
const moveCls = (bps) => (Number(bps) > 0 ? 'up' : Number(bps) < 0 ? 'down' : '');

function Countdown({ closeAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(closeAt).getTime() - now;
  if (ms <= 0) return <span>scoring…</span>;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return <span>{h > 0 ? `${h}h ` : ''}{m}m {s}s</span>;
}

// Rank cards from the shared pool; click-order = draft preference. Need >= rosterSize to join.
function WishlistBuilder({ arena, onJoin, busy }) {
  const [wishlist, setWishlist] = useState([]);
  const size = arena.rosterSize;
  const byId = new Map(arena.pool.map((c) => [c.marketId, c]));
  const toggle = (id) => setWishlist((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));
  const enough = wishlist.length >= size;
  return (
    <div className="arena-builder">
      <p className="muted">
        Rank your picks. {arena.spots} players, {size} cards each — on fill the seats are fair-shuffled and a snake draft
        gives each player, in turn, their best still-available pick. A card taken is gone for everyone.
      </p>
      {wishlist.length > 0 && (
        <ol className="arena-wishlist">
          {wishlist.map((id) => (
            <li key={id}>
              <button className="arena-wl-item" onClick={() => toggle(id)} title="Remove">
                {byId.get(id)?.displayName}
                <span className="arena-wl-x">×</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <button className="btn-primary arena-join" disabled={busy || !enough} onClick={() => onJoin(wishlist)}>
        {enough ? `Join — $${arena.entryUsd}` : `Rank ${size - wishlist.length} more`}
      </button>
      <div className="duel-cards arena-pool">
        {arena.pool.map((c) => {
          const r = wishlist.indexOf(c.marketId);
          return (
            <button key={c.marketId} className={`duel-pick ${r >= 0 ? 'picked' : ''}`} disabled={busy} onClick={() => toggle(c.marketId)}>
              {r >= 0 && <span className="arena-rank-badge">{r + 1}</span>}
              {cardThumb(c) ? <img src={cardThumb(c)} alt="" className="duel-pick-img" /> : <span className="duel-pick-img idx-thumb">🎴</span>}
              <span className="duel-pick-name">{c.displayName}</span>
              <span className="duel-pick-val">{formatUsd(BigInt(c.valueE6))}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DraftArena({ config }) {
  const { user } = useAuth();
  const [arena, setArena] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const idRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const r = idRef.current ? await api.getArenaById(idRef.current) : await api.getArena();
      setArena(r.arena ?? null);
    } catch { setArena((a) => (a === undefined ? null : a)); }
  }, [user]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!arena || (arena.status !== 'open' && arena.status !== 'battle')) return;
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [arena, refresh]);

  const join = async (wishlist) => {
    setErr(null); setBusy(true);
    try {
      const v = await api.arenaJoin(wishlist, crypto.randomUUID());
      idRef.current = v.roundId;
      setArena(v);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const next = () => { idRef.current = null; setArena(undefined); setErr(null); refresh(); };

  if (!user) return <div className="empty-state">Connect &amp; sign in to play.</div>;

  const mine = arena?.yourEntry;
  return (
    <div className="arena">
      <div className="rip-head">
        <h2>🎯 Draft Arena</h2>
        <span className="muted">Entry ${config?.entryUsd ?? '—'} · {config?.spots ?? '—'} players · {config?.rosterSize ?? '—'} picks · {config ? (config.rakeBps / 100).toFixed(0) : '—'}% rake</span>
      </div>

      {arena === undefined && <p className="muted">Loading…</p>}
      {arena === null && <p className="muted">Draft Arena isn’t open right now — check back soon.</p>}

      {arena && !mine && arena.status === 'open' && <WishlistBuilder arena={arena} onJoin={join} busy={busy} />}

      {arena && mine && (
        <div className="fan-league glass-card">
          <div className="fan-league-head">
            <div>
              <span className="fan-pool">{formatUsd(BigInt(arena.prizePoolE6))}</span>
              <span className="muted"> prize pool · {arena.filled}/{arena.spots} drafted</span>
            </div>
            <div className="fan-clock">
              {arena.status === 'open' ? 'waiting for the lobby to fill…'
                : arena.status === 'battle' ? <>closes in <Countdown closeAt={arena.closeAt} /></>
                : arena.status === 'settled' ? <span className="fan-settled">final</span>
                : 'cancelled'}
            </div>
          </div>

          {arena.status === 'settled' && (
            <div className={`duel-result ${Number(mine.prizeE6) > 0 ? 'up' : 'down'}`}>
              <h3>{Number(mine.prizeE6) > 0 ? `You won ${formatUsd(BigInt(mine.prizeE6))}!` : `Your roster scored ${fmtMove(mine.scoreBps)} — no prize this round.`}</h3>
              <button className="btn-primary" onClick={next}>New arena</button>
            </div>
          )}
          {arena.status === 'cancelled' && (
            <div className="duel-result"><p>Lobby didn’t fill — your entry was refunded.</p><button className="btn-primary" onClick={next}>New arena</button></div>
          )}

          {mine.roster.length > 0 && (
            <div className="fan-roster">
              <div className="fan-roster-title">Your roster{mine.seat != null ? ` · seat ${mine.seat + 1}` : ''} <span className={`fan-score ${moveCls(mine.scoreBps)}`}>{mine.scoreBps != null ? fmtMove(mine.scoreBps) : ''}</span></div>
              {mine.roster.map((c) => (
                <div key={c.marketId} className="fan-row">
                  {cardThumb(c) ? <img src={cardThumb(c)} alt="" className="fan-row-img" /> : <span className="fan-row-img idx-thumb">🎴</span>}
                  <span className="fan-row-name">{c.displayName}</span>
                  <span className="fan-row-val">{formatUsd(BigInt(c.valueE6))} → {formatUsd(BigInt(c.currentE6))}</span>
                  <span className={`fan-row-move ${moveCls(c.moveBps)}`}>{fmtMove(c.moveBps)}</span>
                </div>
              ))}
            </div>
          )}

          {arena.standings.length > 0 && arena.status !== 'open' && (
            <div className="fan-board">
              <div className="fan-roster-title">Standings</div>
              {arena.standings.map((r, i) => (
                <div key={i} className={`fan-board-row ${r.isYou ? 'you' : ''}`}>
                  <span className="fan-rank">#{i + 1}</span>
                  <span className="fan-board-handle">{r.handle}{r.isYou ? ' (you)' : ''}{r.seat != null ? ` · seat ${r.seat + 1}` : ''}</span>
                  <span className={`fan-board-score ${moveCls(r.scoreBps)}`}>{fmtMove(r.scoreBps)}</span>
                </div>
              ))}
            </div>
          )}

          {arena.status === 'settled' && arena.fairness.serverSeed && (
            <p className="arena-seed muted">Provably fair — seed {arena.fairness.serverSeed.slice(0, 16)}… (hash {arena.fairness.serverSeedHash.slice(0, 12)}…)</p>
          )}
        </div>
      )}

      {err && <div className="order-error">{err}</div>}
    </div>
  );
}
