import { useState } from 'react';
import { formatUsd } from '@pokex/pricing';

// Multi-open summary (docs/classic-gacha-cc-packs-spec.md). After opening more than one pack: a net line
// (spent vs value) + a grid of every pull. Mirrors rare.win's PackOpen summary — keep all (Done), sell some
// (per-card Sell), or sell all. Kept slabs stay in "Your pulls". `onSell(mint)` resolves the held row + sells
// it instantly (−10%); returns true on success.

const usd = (e6) => formatUsd(BigInt(e6 || 0));
const TIER = { common: '#ef4444', uncommon: '#22c55e', rare: '#a855f7', epic: '#f59e0b' };
const tierColor = (r) => TIER[(r || '').toLowerCase()] ?? '#9aa0aa';

export function GachaSummary({ results, spentE6, onSell, onClose }) {
  const [sold, setSold] = useState({}); // mint → true
  const [busy, setBusy] = useState(false);

  const sellable = results.filter((r) => r.card?.mint && Number(r.card.valueE6) > 0 && !sold[r.card.mint]);
  const value = results.reduce((s, r) => s + Number(r.card?.valueE6 || 0) + Number(r.turboRefundE6 || 0), 0);
  const spent = Number(spentE6 || 0) * results.length;
  const net = value - spent;

  const sellOne = async (mint) => {
    if (!mint || sold[mint] || busy) return false;
    setBusy(true);
    const ok = await onSell(mint);
    if (ok) setSold((s) => ({ ...s, [mint]: true }));
    setBusy(false);
    return ok;
  };
  const sellAll = async () => {
    if (busy) return;
    setBusy(true);
    for (const r of sellable) {
      const ok = await onSell(r.card.mint); // eslint-disable-line no-await-in-loop
      if (ok) setSold((s) => ({ ...s, [r.card.mint]: true }));
    }
    setBusy(false);
  };

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
                  {sold[r.card.mint]
                    ? <span className="gacha-summary-sold">Sold ✓</span>
                    : Number(r.card.valueE6) > 0 && <button className="btn-ghost sm" disabled={busy} onClick={() => sellOne(r.card.mint)}>Sell −10%</button>}
                </>
              ) : r.status === 'turbo_sold' ? (
                <div className="gacha-summary-msg"><span>⚡ Auto-sold</span><strong className="up">+{usd(r.turboRefundE6)}</strong></div>
              ) : (
                <div className="gacha-summary-msg muted">Refunded</div>
              )}
            </div>
          ))}
        </div>
        <div className="gacha-summary-actions">
          <button className="btn-ghost" disabled={busy || sellable.length === 0} onClick={sellAll}>
            {busy ? 'Selling…' : `Sell All${sellable.length ? ` (${sellable.length})` : ''}`}
          </button>
          <button className="btn-primary" onClick={onClose}>Keep / Done</button>
        </div>
      </div>
    </div>
  );
}
