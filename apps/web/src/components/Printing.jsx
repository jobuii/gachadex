import { formatUsd, formatPct } from '@pokex/pricing';
import { useRealtime, liveMarkE6 } from '../store/realtime';
import { printingLabel, printingFamily } from '../lib/printing.js';
import { useFixedPopover } from '../lib/popover.js';
import { fmtVol } from '../lib/format.js';

// Printing markets (2026-10-18 plan P5) — mockup board mockups/printing-options.html: option C's chip in the market lists
// and option A's contract switcher on the trade view.

/** The printing chip after a card's name — only for a card listed in 2+ printings (`group` = its product's markets). */
export function PrintingChip({ market, group }) {
  if (!group) return null; // index markets have no tcgplayerId, so never a group
  const label = printingLabel(market);
  if (!label) return null;
  return <span className={`pc pc-${printingFamily(market)}`} title={market.variant ?? undefined}>{label}</span>;
}

/** Option A: "Holo ▾ 3 printings" next to the trade-view title → every printing of the card with its mark, 24h,
 *  volume and premium over the cheapest; a row opens that market. Nothing for a card with one printing. */
export function PrintingSwitcher({ market, group, onGoToMarket }) {
  const marks = useRealtime((s) => s.marks);
  const { open, setOpen, box, wrapRef, triggerRef, toggle } = useFixedPopover(480);
  if (!group || !onGoToMarket) return null;
  const rows = group.map((m) => ({ m, mark: Number(liveMarkE6(marks, m)) || null }));
  const base = Math.min(...rows.map((r) => r.mark ?? Infinity)); // the cheapest live mark — the premium's base
  const pick = (m) => { setOpen(false); if (m.id !== market.id) onGoToMarket(m.id); };
  return (
    <div className="pc-switch" ref={wrapRef}>
      <button ref={triggerRef} className="ib-chip pc-switch-btn" aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
        <PrintingChip market={market} group={group} />
        <span className="pc-switch-n">▾ {group.length} printings</span>
      </button>
      {open && (
        <div className="ib-pop pc-pop" style={box} role="dialog" aria-label="Printings of this card">
          <div className="pc-pop-h">Every printing of this card — premium vs the cheapest</div>
          <table className="pc-table">
            <thead><tr><th>Printing</th><th className="num">Mark</th><th className="num">24h</th><th className="num">Vol 24h</th><th className="num">Premium</th></tr></thead>
            <tbody>
              {rows.map(({ m, mark }) => {
                const prem = mark && Number.isFinite(base) ? Math.round((mark / base - 1) * 100) : null;
                return (
                  <tr key={m.id} className={m.id === market.id ? 'on' : ''} tabIndex={0} aria-current={m.id === market.id || undefined}
                    onClick={() => pick(m)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(m); } }}>
                    <td><PrintingChip market={m} group={group} /> <span className="pc-full">{m.variant}</span></td>
                    <td className="num">{mark ? formatUsd(mark / 1e6) : '—'}</td>
                    <td className={`num ${(m.change24hPct ?? 0) >= 0 ? 'up' : 'down'}`}>{formatPct(m.change24hPct ?? 0)}</td>
                    <td className="num">{fmtVol(m.volume24hUsd)}</td>
                    <td className="num muted">{prem == null ? '—' : mark === base ? 'base' : `+${prem}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
