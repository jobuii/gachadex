import { formatUsd } from '@pokex/pricing';

// Multi-open summary (docs/classic-gacha-cc-packs-spec.md). Shown after opening more than one pack: a net line
// (spent vs total value) + a grid of every pull (kept slab, or a ⚡ YOLO auto-sell, or a refund). Display-only —
// the kept cards land in "Your pulls" where they can be sold/withdrawn.

const usd = (e6) => formatUsd(BigInt(e6 || 0));
const TIER = { common: '#ef4444', uncommon: '#22c55e', rare: '#a855f7', epic: '#f59e0b' };
const tierColor = (r) => TIER[(r || '').toLowerCase()] ?? '#9aa0aa';

export function GachaSummary({ results, spentE6, onClose }) {
  const cardValue = results.reduce((s, r) => s + Number(r.card?.valueE6 || 0), 0);
  const turboValue = results.reduce((s, r) => s + Number(r.turboRefundE6 || 0), 0);
  const value = cardValue + turboValue;
  const spent = Number(spentE6 || 0) * results.length;
  const net = value - spent;

  return (
    <div className="gacha-reveal-overlay" onClick={onClose}>
      <div className="gacha-reveal-bg" aria-hidden />
      <div className="gacha-reveal-stage gacha-summary" onClick={(e) => e.stopPropagation()}>
        <h3>Your {results.length} pulls</h3>
        <div className="gacha-summary-net">
          <strong className={net < 0 ? 'down' : 'up'}>{net < 0 ? '−' : '+'}{usd(String(Math.abs(net)))}</strong>
          <span className="muted">spent {usd(String(spent))} · value {usd(String(value))}</span>
        </div>
        <div className="gacha-summary-grid">
          {results.map((r, i) => (
            <div key={i} className="gacha-summary-card">
              {r.card ? (
                <>
                  {r.card.imageUrl && <img src={r.card.imageUrl} alt={r.card.name ?? ''} referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />}
                  <span className="gacha-summary-name" title={r.card.name ?? ''}>{r.card.name ?? 'card'}</span>
                  <span className="gacha-summary-val" style={{ color: tierColor(r.card.rarity) }}>{usd(r.card.valueE6)}</span>
                </>
              ) : r.status === 'turbo_sold' ? (
                <div className="gacha-summary-msg"><span>⚡ Auto-sold</span><strong className="up">+{usd(r.turboRefundE6)}</strong></div>
              ) : (
                <div className="gacha-summary-msg muted">Refunded</div>
              )}
            </div>
          ))}
        </div>
        <button className="btn-primary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
