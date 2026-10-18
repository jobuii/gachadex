import { useState, useEffect, useMemo, useRef } from 'react';
import { formatUsd } from '@pokex/pricing';
import { shortDate, useIndexBasket } from '../lib/indexBasket.js';
import { useFixedPopover } from '../lib/popover.js';

// Index members (rules v3, R9) — chosen mockup "B + C" (mockups/index-members-options.html):
//   IndexBasketDrawer: Members · Upcoming · Change log for one index (opened from the Markets Indices table or the
//   trade-view chip); IndexChangeChip: a small chip in the trade header, glowing during the 3-day notice, with a
//   popover of the announced change. Both read GET /markets/index-basket.

const REASONS = {
  rank: 'ranked out', printing: 'other printing', hand: 'removed by hand', delisted: 'delisted', stale: 'no price 14 days',
  'no-psa10': 'no PSA 10 for 14 days', ineligible: 'no longer eligible', 'rules-off': 'rules switched off',
};
const reasonLabel = (r) => REASONS[r] ?? r;
const fullTime = (iso) => `${new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;

function ChangeLists({ adds, removes }) {
  return (
    <div className="ib-chg">
      <div>
        <div className="ib-chg-h up">In ({adds.length})</div>
        {adds.length ? adds.map((a) => <div key={a.marketId}>{a.name}</div>) : <div className="muted">—</div>}
      </div>
      <div>
        <div className="ib-chg-h down">Out ({removes.length})</div>
        {removes.length
          ? removes.map((r) => <div key={r.marketId}>{r.name} <span className="ib-reason">{reasonLabel(r.reason)}</span></div>)
          : <div className="muted">—</div>}
      </div>
    </div>
  );
}

export function IndexBasketDrawer({ market, initialTab = 'members', onClose }) {
  const { view, error } = useIndexBasket(market?.symbol);
  const [tab, setTab] = useState(initialTab); // the drawer mounts per open, so the opener's tab is its start state
  const [q, setQ] = useState('');
  const closeRef = useRef(null);
  useEffect(() => closeRef.current?.focus(), []); // once on open — the parents re-render on every live tick
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const members = useMemo(() => {
    const list = view?.members ?? [];
    const needle = q.trim().toLowerCase();
    return (needle ? list.filter((m) => m.name.toLowerCase().includes(needle)) : list)
      .slice()
      .sort((a, b) => (b.weightBps ?? -1) - (a.weightBps ?? -1) || a.name.localeCompare(b.name));
  }, [view, q]);

  return (
    <div className="ib-overlay" onClick={onClose}>
      <aside className="ib-drawer" role="dialog" aria-modal="true" aria-label={`${market.displayName} members`} onClick={(e) => e.stopPropagation()}>
        <header className="ib-head">
          <div>
            <div className="ib-title">{market.displayName}</div>
            <div className="ib-sub">{view?.governed ? `${view.members.length} members` : 'Members'}</div>
          </div>
          <button ref={closeRef} className="ib-close" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="ib-tabs" role="tablist">
          {[['members', 'Members'], ['upcoming', 'Upcoming'], ['log', 'Change log']].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {label}{k === 'upcoming' && view?.upcoming ? <span className="ib-dot" aria-hidden /> : null}
            </button>
          ))}
        </div>
        <div className="ib-body">
          {error && <p className="ib-note">Couldn’t load this index’s members ({error}).</p>}
          {!view && !error && <p className="ib-note">Loading…</p>}
          {view && !view.governed && tab === 'members' && (
            <p className="ib-note">This index re-ranks its top cards at every price update; it has no fixed member list.</p>
          )}
          {view && tab === 'members' && view.governed && (
            <>
              <input className="ib-search" type="search" placeholder="Search members" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search members" />
              <table className="ib-table">
                <thead><tr><th>Card</th><th className="num">Price</th><th className="num">Weight</th><th className="num">Joined</th></tr></thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.marketId}>
                      <td className="ib-card">{m.name}</td>
                      <td className="num">{m.priceE6 ? formatUsd(BigInt(m.priceE6)) : '—'}</td>
                      <td className="num">{m.weightBps != null ? `${(m.weightBps / 100).toFixed(2)}%` : '—'}</td>
                      <td className="num muted">{shortDate(m.joinedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {view && tab === 'upcoming' && (view.upcoming ? (
            <div className="ib-up">
              <p><b>Change on {fullTime(view.upcoming.effectiveAt)}.</b> Ranked on prices at 00:00 UTC on {shortDate(view.upcoming.changeDate)}. The index level doesn’t jump at a change.</p>
              <ChangeLists adds={view.upcoming.adds} removes={view.upcoming.removes} />
            </div>
          ) : <p className="ib-note">No change announced.</p>)}
          {view && tab === 'log' && (view.log.length ? (
            <div className="ib-log">
              {view.log.map((c, i) => (
                <details key={c.changeDate} open={i === 0}>
                  <summary><span className="ib-date">{shortDate(c.changeDate)}</span> <span className="ib-pill">+{c.adds.length} / −{c.removes.length}</span> <span className="muted">applied {fullTime(c.appliedAt)}</span></summary>
                  <ChangeLists adds={c.adds} removes={c.removes} />
                </details>
              ))}
            </div>
          ) : <p className="ib-note">No changes yet.</p>)}
        </div>
        {view?.governed && <footer className="ib-foot">Members change once a month with 3 days’ notice; a buffer keeps cards near the cut-off from flipping in and out. <a href="/docs#indices">How index members change</a></footer>}
      </aside>
    </div>
  );
}

/** Trade-header chip for an index market: muted "Members", glowing cyan during an announced change (option C). */
export function IndexChangeChip({ market, onOpen }) {
  const { view } = useIndexBasket(market?.kind === 'index' ? market.symbol : null);
  const { open, setOpen, box, wrapRef, triggerRef, toggle } = useFixedPopover();
  if (market?.kind !== 'index' || !view?.governed) return null;
  const up = view.upcoming;
  if (!up) return <button className="ib-chip" onClick={() => onOpen('members')}>Members</button>;
  return (
    <div className="ib-chip-wrap" ref={wrapRef}>
      <button ref={triggerRef} className="ib-chip live" aria-expanded={open} onClick={toggle}>
        <span className="ib-chip-dot" aria-hidden />Change {shortDate(up.effectiveAt)} · +{up.adds.length} / −{up.removes.length}
      </button>
      {open && (
        <div className="ib-pop" style={box} role="dialog" aria-label="Announced index change">
          <div className="ib-pop-h">Index change · {fullTime(up.effectiveAt)}</div>
          <ChangeLists adds={up.adds} removes={up.removes} />
          <p className="ib-pop-note">Ranked on prices at 00:00 UTC on {shortDate(up.changeDate)}. The level doesn’t jump at a change: each series is chain-linked.</p>
          <div className="ib-pop-actions">
            <button className="btn-primary sm" onClick={() => { setOpen(false); onOpen('members'); }}>All members</button>
            <button className="btn-ghost sm" onClick={() => { setOpen(false); onOpen('log'); }}>Change log</button>
          </div>
        </div>
      )}
    </div>
  );
}
