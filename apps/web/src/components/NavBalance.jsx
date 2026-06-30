import { useState, useEffect, useRef } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../auth/AuthContext';
import { GoldBar } from './games/GoldBar.jsx';
import * as api from '../lib/api.js';

const MASK_KEY = 'gachadex_balance_masked';

// Compact display number via Intl (same mechanism formatUsd uses for its compact mode): 12000→"12K",
// 12140→"12.1K", 1.2e6→"1.2M". Built once, not per render.
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const abbrevNum = (n) => COMPACT.format(n);

/**
 * Option B — the unified balance chip for the navbar: one compact chip showing available USDC + (when Gold
 * is on) the abbreviated Gold balance, opening a popover with the exact values, a hide-balances toggle, and
 * Deposit / Withdraw (→ the Portfolio wallet via `onManageFunds`). Self-contained: renders nothing until
 * signed in with a balance. `onManageFunds` navigates to where the real deposit/withdraw flow lives.
 */
export function NavBalance({ onManageFunds }) {
  const { user } = useAuth();
  const [bal, setBal] = useState(null);        // { availableUusdc, … }
  const [gold, setGold] = useState(null);      // { balance, … }
  const [goldOn, setGoldOn] = useState(false);
  const [open, setOpen] = useState(false);
  const [masked, setMasked] = useState(() => { try { return localStorage.getItem(MASK_KEY) === '1'; } catch { return false; } });
  const chipRef = useRef(null);
  const popRef = useRef(null);

  // Fetch on sign-in + poll (balance moves on every trade; Gold moves on every pack open). `alive` drops
  // late responses after the user changed/unmounted; Gold only loads when the operator has it enabled.
  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    let withGold = false;
    const load = () => {
      api.getBalance().then((b) => { if (alive) setBal(b); }).catch(() => {});
      if (withGold) api.getGoldBalance().then((g) => { if (alive) setGold(g); }).catch(() => {});
    };
    api.getHealth().then((h) => {
      if (!alive) return;
      withGold = !!h.goldEnabled;
      setGoldOn(withGold);
      if (withGold) api.getGoldBalance().then((g) => { if (alive) setGold(g); }).catch(() => {});
    }).catch(() => {});
    load();
    const t = setInterval(load, 12000);
    return () => { alive = false; clearInterval(t); };
  }, [user]);

  // Popover dismissal — outside-tap + Esc.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!popRef.current?.contains(e.target) && !chipRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); chipRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggleMask = () => setMasked((m) => {
    const next = !m;
    try { localStorage.setItem(MASK_KEY, next ? '1' : '0'); } catch { /* private mode */ }
    return next;
  });

  if (!user || !bal || bal.availableUusdc == null) return null;

  const showGold = goldOn && gold && gold.balance != null;
  const manage = () => { setOpen(false); onManageFunds?.(); };

  return (
    <div className="navbal">
      <button
        type="button"
        ref={chipRef}
        className={`navbal-chip ${open ? 'open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Your balance"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="navbal-leg">
          <span className="navbal-glyph usdc" aria-hidden="true">$</span>
          <span className="navbal-val mono">{masked ? '••••' : abbrevNum(Number(bal.availableUusdc) / 1e6)}</span>
        </span>
        {showGold && (
          <>
            <span className="navbal-dot" aria-hidden="true">·</span>
            <span className="navbal-leg">
              <GoldBar size={15} className="navbal-ingot" />
              <span className="navbal-val mono gold">{masked ? '••••' : abbrevNum(Number(gold.balance))}</span>
            </span>
          </>
        )}
        <span className="navbal-caret" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
        </span>
      </button>

      {open && (
        <div className="navbal-pop" ref={popRef} role="dialog" aria-label="Your balances">
          <div className="navbal-pop-head">
            <span className="navbal-pop-title">YOUR MONEY</span>
            <button type="button" className="navbal-eye" onClick={toggleMask} aria-pressed={masked} aria-label={masked ? 'Show balances' : 'Hide balances'}>
              {masked ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
              )}
            </button>
          </div>

          <div className="navbal-row">
            <span className="navbal-ricon usdc" aria-hidden="true">$</span>
            <div className="navbal-meta">
              <div className="navbal-nm">USDC <span className="navbal-tag tradeable">Available</span></div>
              <div className="navbal-subtle">Trade &amp; withdraw</div>
            </div>
            <span className="navbal-big mono">{masked ? '••••••' : formatUsd(BigInt(bal.availableUusdc))}</span>
          </div>

          {showGold && (
            <div className="navbal-row">
              <span className="navbal-ricon gold" aria-hidden="true"><GoldBar size={20} /></span>
              <div className="navbal-meta">
                <div className="navbal-nm">Gold <span className="navbal-tag loyalty">Loyalty</span></div>
                <div className="navbal-subtle">Non-withdrawable · 1,000 ≈ $1</div>
              </div>
              <span className="navbal-big mono gold">{masked ? '••••••' : Number(gold.balance).toLocaleString()}</span>
            </div>
          )}

          {onManageFunds && (
            <div className="navbal-actions">
              <button type="button" className="btn-primary navbal-act" onClick={manage}>Deposit</button>
              <button type="button" className="btn-ghost navbal-act" onClick={manage}>Withdraw</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
