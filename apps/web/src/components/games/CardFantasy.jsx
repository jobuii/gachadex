import { useState, useEffect, useCallback, useRef } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../../auth/AuthContext';
import { thumbSrc } from '../../lib/thumb.js';
import * as api from '../../lib/api.js';

const cardThumb = (c) => thumbSrc({ imageSmall: c?.imageSmall, kind: 'card' });
const fmtMove = (bps) => `${bps >= 0 ? '+' : ''}${(Number(bps) / 100).toFixed(1)}%`;
const moveCls = (bps) => (Number(bps) > 0 ? 'up' : Number(bps) < 0 ? 'down' : '');

// Draft `rosterSize` distinct cards whose combined value stays under the salary cap.
function RosterBuilder({ config, onEnter, busy }) {
  const [markets, setMarkets] = useState([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  useEffect(() => {
    api.getMarkets().then((r) => setMarkets((r.markets || []).filter((m) => m.kind === 'card' && m.markE6))).catch(() => {});
  }, []);
  const size = config?.rosterSize ?? 5;
  const capE6 = BigInt(config?.capUsd ?? 0) * 1_000_000n;
  const total = picked.reduce((s, c) => s + BigInt(c.markE6), 0n);
  const overCap = total > capE6;
  const full = picked.length === size;
  const has = (id) => picked.some((x) => x.id === id);
  const toggle = (m) => setPicked((p) => (has(m.id) ? p.filter((x) => x.id !== m.id) : p.length < size ? [...p, m] : p));
  const filtered = markets.filter((m) => m.displayName.toLowerCase().includes(q.toLowerCase())).slice(0, 48);

  return (
    <div className="fan-builder">
      <div className="fan-capbar">
        <span>Roster <strong>{picked.length}/{size}</strong></span>
        <span className={overCap ? 'down' : ''}>{formatUsd(total)} / {formatUsd(capE6)} cap</span>
      </div>
      {picked.length > 0 && (
        <div className="fan-chips">
          {picked.map((c) => (
            <button key={c.id} className="fan-chip" onClick={() => toggle(c)} title="Remove">
              {cardThumb(c) ? <img src={cardThumb(c)} alt="" /> : <span className="idx-thumb">🎴</span>}
              <span className="fan-chip-name">{c.displayName}</span>
              <span className="fan-chip-x">×</span>
            </button>
          ))}
        </div>
      )}
      <button className="btn-primary fan-enter" disabled={busy || !full || overCap} onClick={() => onEnter(picked.map((c) => c.id))}>
        {overCap ? 'Over the cap' : !full ? `Pick ${size - picked.length} more` : `Enter — $${config?.entryUsd ?? ''}`}
      </button>
      <input className="duel-search" placeholder="Search cards to draft…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="duel-cards">
        {filtered.map((m) => (
          <button key={m.id} className={`duel-pick ${has(m.id) ? 'picked' : ''}`} disabled={busy || (!has(m.id) && full)} onClick={() => toggle(m)}>
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

export function CardFantasy({ config }) {
  const { user } = useAuth();
  const [league, setLeague] = useState(undefined); // undefined=loading, null=none, obj
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const idRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const r = idRef.current ? await api.getFantasyLeagueById(idRef.current) : await api.getFantasyLeague();
      setLeague(r.league ?? null);
      idRef.current = r.league && r.league.yourEntry ? r.league.leagueId : null;
    } catch { setLeague((l) => (l === undefined ? null : l)); }
  }, [user]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!league || league.status !== 'open') return;
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [league, refresh]);

  const enter = async (marketIds) => {
    setErr(null); setBusy(true);
    try {
      const v = await api.fantasyEnter(marketIds, crypto.randomUUID());
      idRef.current = v.leagueId;
      setLeague(v);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const next = () => { idRef.current = null; setLeague(undefined); setErr(null); refresh(); };

  if (!user) return <div className="empty-state">Connect &amp; sign in to play.</div>;

  return (
    <div className="fantasy">
      <div className="rip-head">
        <h2>🏆 Card Fantasy</h2>
        <span className="muted">Entry ${config?.anteUsd ?? config?.entryUsd ?? '—'} · {config?.rosterSize ?? '—'} cards · ${config?.capUsd ?? '—'} cap · {config ? (config.rakeBps / 100).toFixed(0) : '—'}% rake</span>
      </div>
      <p className="muted">Draft a roster under the salary cap. Over the window, the roster with the biggest combined %-move wins the prize pool.</p>

      {league === undefined && <p className="muted">Loading…</p>}
      {league === null && <p className="muted">No league is open right now — check back soon.</p>}

      {league && !league.yourEntry && league.status === 'open' && <RosterBuilder config={config} onEnter={enter} busy={busy} />}

      {league && league.yourEntry && (
        <div className="fan-league glass-card">
          <div className="fan-league-head">
            <div>
              <span className="fan-pool">{formatUsd(BigInt(league.prizePoolE6))}</span>
              <span className="muted"> prize pool · {league.entrantCount} {league.entrantCount === 1 ? 'entry' : 'entries'}</span>
            </div>
            <div className="fan-clock">
              {league.status === 'settled'
                ? <span className="fan-settled">final</span>
                : <>closes in <Countdown closeAt={league.closeAt} /></>}
            </div>
          </div>

          {league.status === 'settled' && (
            <div className={`duel-result ${league.refunded ? '' : Number(league.yourEntry.prizeE6) > 0 ? 'up' : 'down'}`}>
              <h3>
                {league.refunded ? 'League refunded — too few entrants.'
                  : Number(league.yourEntry.prizeE6) > 0 ? `You won ${formatUsd(BigInt(league.yourEntry.prizeE6))}!`
                  : `You scored ${fmtMove(league.yourEntry.scoreBps)} — no prize this round.`}
              </h3>
              <button className="btn-primary" onClick={next}>Next league</button>
            </div>
          )}

          <div className="fan-roster">
            <div className="fan-roster-title">Your roster <span className={`fan-score ${moveCls(league.yourEntry.scoreBps)}`}>{fmtMove(league.yourEntry.scoreBps)}</span></div>
            {league.yourEntry.roster.map((c) => (
              <div key={c.marketId} className="fan-row">
                {cardThumb(c) ? <img src={cardThumb(c)} alt="" className="fan-row-img" /> : <span className="fan-row-img idx-thumb">🎴</span>}
                <span className="fan-row-name">{c.displayName}</span>
                <span className="fan-row-val">{formatUsd(BigInt(c.entryE6))} → {formatUsd(BigInt(c.currentE6))}</span>
                <span className={`fan-row-move ${moveCls(c.moveBps)}`}>{fmtMove(c.moveBps)}</span>
              </div>
            ))}
          </div>

          <div className="fan-board">
            <div className="fan-roster-title">Leaderboard</div>
            {league.leaderboard.map((r, i) => (
              <div key={i} className={`fan-board-row ${r.isYou ? 'you' : ''}`}>
                <span className="fan-rank">#{i + 1}</span>
                <span className="fan-board-handle">{r.handle}{r.isYou ? ' (you)' : ''}</span>
                <span className={`fan-board-score ${moveCls(r.scoreBps)}`}>{fmtMove(r.scoreBps)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {err && <div className="order-error">{err}</div>}
    </div>
  );
}
