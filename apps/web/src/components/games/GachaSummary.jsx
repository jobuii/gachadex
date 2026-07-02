import { useState } from 'react';
import { createPortal } from 'react-dom';
import { RARITY_COLORS, usd, netAfterCutE6, hideBrokenImg } from './gacha-util.js';

// Multi-open summary (docs/classic-gacha-cc-packs-spec.md). After opening more than one pack: a net line
// (spent vs value) + a grid of every pull. Mirrors rare.win's PackOpen summary. Tap any pull to select it
// (multi-select) — a "Sell (N)" button plus the exact USDC payout appear above the actions; or "Sell All",
// or "Keep / Done". `onSell(mint)` resolves the held row + sells it instantly (cut applied); true on success.

const tierColor = (r) => RARITY_COLORS[(r || '').toLowerCase()] ?? '#9aa0aa';

export function GachaSummary({ results, spentE6, onSell, onClose, instantCutBps = 1000 }) {
  const [sold, setSold] = useState({}); // mint → true
  const [pending, setPending] = useState({}); // mint → true (sell-back broadcast but unconfirmed — reconciler settles it)
  const [selected, setSelected] = useState({}); // mint → true
  const [busy, setBusy] = useState(false);

  const netE6 = (v) => netAfterCutE6(v, instantCutBps); // USDC the player nets selling this slab back now

  const isSellable = (r) => r.card?.mint && Number(r.card.valueE6) > 0 && !sold[r.card.mint] && !pending[r.card.mint];
  const sellable = results.filter(isSellable);
  const oneSellable = sellable.length === 1; // single-card summary (a YOLO Uncommon) → "Sell"/"Keep", not "…All (1)"
  const anySold = Object.keys(sold).length > 0 || Object.keys(pending).length > 0; // once anything's been sold/selling, "Keep All" no longer applies → "Done"
  const selectedRows = sellable.filter((r) => selected[r.card.mint]);
  const selectedPayout = selectedRows.reduce((s, r) => s + netE6(r.card.valueE6), 0n);

  const value = results.reduce((s, r) => s + Number(r.card?.valueE6 || 0) + Number(r.turboRefundE6 || 0), 0);
  const spent = Number(spentE6 || 0) * results.length;
  const net = value - spent;

  const toggle = (mint) => { if (busy || sold[mint] || pending[mint]) return; setSelected((s) => ({ ...s, [mint]: !s[mint] })); };

  const sellRows = async (rows) => {
    if (busy || rows.length === 0) return;
    setBusy(true);
    for (const r of rows) {
      const ok = await onSell(r.card.mint); // sequential: each sell-back is its own settlement
      // 'pending' = broadcast but unconfirmed → show "Selling…", not "Sold ✓" (the reconciler settles it shortly).
      if (ok === 'pending') setPending((p) => ({ ...p, [r.card.mint]: true }));
      else if (ok) setSold((s) => ({ ...s, [r.card.mint]: true }));
    }
    setSelected({});
    setBusy(false);
  };

  return createPortal(
    <div className="gacha-reveal-overlay" onClick={onClose}>
      <div className="gacha-reveal-bg" aria-hidden />
      <div className="gacha-reveal-stage gacha-summary" onClick={(e) => e.stopPropagation()}>
        <h3>Your {results.length === 1 ? 'pull' : `${results.length} pulls`}</h3>
        <div className="gacha-summary-net">
          <strong className={net < 0 ? 'down' : 'up'}>{net < 0 ? '−' : '+'}{usd(String(Math.abs(net)))}</strong>
          <span className="muted">spent {usd(String(spent))} · value {usd(String(value))}</span>
        </div>
        <div className="gacha-summary-grid">
          {results.map((r, i) => {
            const sellableCard = isSellable(r);
            const isSel = r.card && !!selected[r.card.mint];
            return (
              <div
                key={i}
                className={`gacha-summary-card ${sellableCard ? 'selectable' : ''} ${isSel ? 'selected' : ''}`}
                style={r.card ? { '--rarity': tierColor(r.card.rarity) } : undefined}
                onClick={sellableCard ? () => toggle(r.card.mint) : undefined}
                role={sellableCard ? 'button' : undefined}
                aria-pressed={sellableCard ? isSel : undefined}
              >
                {r.card ? (
                  <>
                    {sellableCard && <span className="gacha-summary-check" aria-hidden>{isSel ? '✓' : ''}</span>}
                    {r.card.imageUrl && <img src={r.card.imageUrl} alt={r.card.name ?? ''} referrerPolicy="no-referrer" onError={hideBrokenImg} />}
                    <span className="gacha-summary-name" title={r.card.name ?? ''}>{r.card.name ?? 'card'}</span>
                    <span className="gacha-summary-val" style={{ color: tierColor(r.card.rarity) }}>{usd(r.card.valueE6)}</span>
                    {sold[r.card.mint] && <span className="gacha-summary-sold">Sold ✓</span>}
                    {pending[r.card.mint] && !sold[r.card.mint] && <span className="gacha-summary-sold" style={{ color: 'var(--gold)' }}>⏳ Selling…</span>}
                  </>
                ) : r.status === 'turbo_sold' ? (
                  <div className="gacha-summary-msg"><span>⚡ Auto-sold</span><strong className="up">+{usd(r.turboRefundE6)}</strong></div>
                ) : (
                  <div className="gacha-summary-msg muted">Refunded</div>
                )}
              </div>
            );
          })}
        </div>
        {(selectedRows.length > 0 || sellable.length > 0) && (
          <div className="gacha-summary-payout">
            {selectedRows.length > 0
              ? <>Sell {selectedRows.length} back to Collector Crypt for <strong className="up">~{usd(selectedPayout)}</strong> USDC</>
              : <span className="muted">{oneSellable ? 'Sell it back to Collector Crypt, or keep it.' : 'Tap any pull to select it, then Sell — or Sell All'}</span>}
          </div>
        )}
        <div className="gacha-summary-actions">
          {selectedRows.length > 0 && (
            <button className="btn-primary" disabled={busy} onClick={() => sellRows(selectedRows)}>
              {busy ? 'Selling…' : `Sell (${selectedRows.length})`}
            </button>
          )}
          <button className="btn-ghost" disabled={busy || sellable.length === 0} onClick={() => sellRows(sellable)}>
            {busy && selectedRows.length === 0 ? 'Selling…' : oneSellable ? 'Sell' : `Sell All${sellable.length ? ` (${sellable.length})` : ''}`}
          </button>
          <button className="btn-ghost" disabled={busy} onClick={onClose}>
            {anySold ? 'Done' : oneSellable ? 'Keep' : `Keep All${sellable.length ? ` (${sellable.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
