import { useState, useEffect } from 'react';
import { formatUsd, formatSignedUsd, shortenPubkey } from '@pokex/pricing';
import { useAuth } from '../auth/AuthContext';
import * as api from '../lib/api.js';

const truncate = (pk) => shortenPubkey(pk) || '—';

function Row({ r, mine }) {
  const up = BigInt(r.realizedPnlUusdc) >= 0n;
  return (
    <div className={`lb-row ${mine ? 'lb-you' : ''}`}>
      <span className="lb-rank">{r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</span>
      <span className="lb-trader">
        {truncate(r.pubkey)}
        {mine && <span className="lb-you-tag">YOU</span>}
      </span>
      <span className={`lb-pnl ${up ? 'up' : 'down'}`}>{formatSignedUsd(r.realizedPnlUusdc)}</span>
      <span className="lb-gold">{Number(r.goldEarned ?? 0).toLocaleString()}</span>
      <span className="lb-volume">{formatUsd(BigInt(r.volumeUusdc), { compact: true })}</span>
    </div>
  );
}

export function Leaderboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.getLeaderboard(100).then((d) => alive && setData(d)).catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const myPubkey = user?.pubkey ?? null;
  const rows = data?.rows ?? [];
  const youOutsideTop = data?.you && !rows.some((r) => r.userId === data.you.userId);

  return (
    <div className="page leaderboard">
      <h2>Leaderboard</h2>
      <p className="lb-sub">Top traders by net realized PnL — booked profit from closed positions (fees &amp; funding included).</p>

      {error && <div className="order-error">{error}</div>}

      <div className="lb-table">
        <div className="lb-row lb-head">
          <span className="lb-rank">#</span>
          <span className="lb-trader">TRADER</span>
          <span className="lb-pnl">REALIZED PnL</span>
          <span className="lb-gold">GOLD EARNED</span>
          <span className="lb-volume">VOLUME</span>
        </div>

        {!data && <div className="loading-pixel" style={{ padding: '2rem' }}><span /><span /><span /></div>}
        {data && rows.length === 0 && <div className="empty-state">No traders yet. Be the first to open a position.</div>}

        {rows.map((r) => (
          <Row key={r.userId} r={r} mine={r.pubkey === myPubkey} />
        ))}

        {youOutsideTop && (
          <>
            <div className="lb-gap">···</div>
            <Row r={data.you} mine />
          </>
        )}
      </div>
    </div>
  );
}
