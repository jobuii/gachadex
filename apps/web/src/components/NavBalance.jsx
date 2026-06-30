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

const EyeOn = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
const EyeOff = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
);

/**
 * Option B — the unified balance chip for the navbar. Desktop: a full chip (available USDC + Gold legs, a
 * hide-balances eye + caret) opening an anchored "YOUR MONEY" popover. Mobile: collapses to a single tap
 * target showing only the $ balance + a Gold ingot dot, opening a bottom sheet (Option D style) that expands
 * to both balances. Self-contained — renders nothing until signed in with a balance. `onManageFunds`
 * navigates to where the real deposit/withdraw flow lives (the Portfolio wallet).
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

  // Popover/sheet dismissal — outside-tap + Esc.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!popRef.current?.contains(e.target) && !chipRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); chipRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggleMask = (e) => {
    e?.stopPropagation();
    setMasked((m) => {
      const next = !m;
      try { localStorage.setItem(MASK_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  };
  // Only toggle on keys aimed at the chip itself — ignore Enter/Space bubbling up from the in-chip eye button.
  const onChipKey = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); }
  };

  if (!user || !bal || bal.availableUusdc == null) return null;

  const usdc = masked ? '••••' : abbrevNum(Number(bal.availableUusdc) / 1e6);
  const showGold = goldOn && gold && gold.balance != null;
  const goldShort = showGold ? (masked ? '••••' : abbrevNum(Number(gold.balance))) : null;
  const manage = () => { setOpen(false); onManageFunds?.(); };

  return (
    <div className="navbal">
      {/* div[role=button] so the in-chip eye can be a real <button> (no nested interactive content) */}
      <div
        className={`navbal-chip ${open ? 'open' : ''} ${masked ? 'masked' : ''}`}
        ref={chipRef}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Your balance"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onChipKey}
      >
        <span className="navbal-leg usdc">
          <span className="navbal-glyph" aria-hidden="true">$</span>
          <span className="navbal-val">{usdc}</span>
          <span className="navbal-pulse" aria-hidden="true" />
        </span>
        {showGold && (
          <>
            <span className="navbal-div" aria-hidden="true">·</span>
            <span className="navbal-leg gold">
              <GoldBar size={18} className="navbal-ingot" />
              <span className="navbal-val gold">{goldShort}</span>
            </span>
          </>
        )}
        <span className="navbal-tools">
          <button type="button" className="navbal-eye" onClick={toggleMask} aria-pressed={masked} aria-label={masked ? 'Show balances' : 'Hide balances'}>
            {masked ? <EyeOff /> : <EyeOn />}
          </button>
          <span className="navbal-caret" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
          </span>
        </span>
      </div>

      {open && (
        <div className="navbal-pop" ref={popRef} role="dialog" aria-label="Your balances">
          <div className="navbal-pop-head">
            <span className="navbal-pop-title">YOUR MONEY</span>
            <button type="button" className="navbal-mask" onClick={toggleMask} aria-pressed={masked}>
              {masked ? <EyeOff /> : <EyeOn />}<span>{masked ? 'Show' : 'Hide'}</span>
            </button>
          </div>

          <div className="navbal-row usdc">
            <span className="navbal-ricon usdc" aria-hidden="true">$</span>
            <div className="navbal-meta">
              <div className="navbal-nm"><b>USDC</b><span className="navbal-tag tradeable">Available</span></div>
              <div className="navbal-sub">Trade &amp; withdraw</div>
            </div>
            <div className="navbal-amt">
              <span className="navbal-big">{masked ? '••••••' : formatUsd(BigInt(bal.availableUusdc))}</span>
              <div className="navbal-unit">USDC</div>
            </div>
          </div>

          {showGold && (
            <div className="navbal-row gold">
              <span className="navbal-ricon gold" aria-hidden="true"><GoldBar size={22} /></span>
              <div className="navbal-meta">
                <div className="navbal-nm"><b>Gold</b><span className="navbal-tag loyalty">Loyalty</span></div>
                <div className="navbal-sub">Non-withdrawable · 1,000 ≈ $1</div>
              </div>
              <div className="navbal-amt">
                <span className="navbal-big gold">{masked ? '••••••' : Number(gold.balance).toLocaleString()}</span>
                <div className="navbal-unit">GOLD</div>
              </div>
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
