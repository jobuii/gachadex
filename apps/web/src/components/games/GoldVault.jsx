import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../../lib/api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { GoldBar } from './GoldBar.jsx';
import { GachaReveal } from './GachaReveal.jsx';
import { pollGachaOpen } from './gacha-util.js';

const FREE_PACK_GOLD = 25000;          // a free $25 pack (1,000 Gold/$)
const FREE_PACK_PRICE_E6 = 25_000_000; // the $25 machine
const fmt = (n) => Number(n || 0).toLocaleString();

/**
 * Option A "gamified vault" — the loyalty Gold balance for the Games-page top-right: a shimmering gold-bar icon,
 * a count-up amount, a ring toward the next free $25 pack, and a "Claim free pack" glow at 100%. Self-contained:
 * fetches the balance + the master flag; renders nothing unless the Gold system is on and there's a session.
 * `refreshKey` lets the Games page force a reload after a pack open changed the balance. Claiming opens the $25
 * pack with Gold (claim=true — allowed even when general pay-with-Gold is off) and plays the reveal.
 */
export function GoldVault({ refreshKey = 0 }) {
  const [gold, setGold] = useState(null);          // { balance, untilFreePackGold }
  const [enabled, setEnabled] = useState(false);   // master Gold switch
  const [machine25, setMachine25] = useState(null);
  const [shown, setShown] = useState(0);           // count-up display
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealResult, setRevealResult] = useState(null);
  const [instantCutBps, setInstantCutBps] = useState(1000);
  const raf = useRef(0);
  const { user } = useAuth(); // re-loads on sign-in, clears on sign-out (no page refresh needed)

  const load = useCallback(() => { if (!user) { setGold(null); return; } api.getGoldBalance().then(setGold).catch(() => {}); }, [user]);
  useEffect(() => { load(); }, [load, refreshKey]); // user change (login/logout) or a pack open → reload
  useEffect(() => {
    api.getHealth().then((h) => { setEnabled(!!h.goldEnabled); if (h.gachaInstantCutBps != null) setInstantCutBps(Number(h.gachaInstantCutBps)); }).catch(() => {});
    api.getCcMachines().then((m) => setMachine25((m.machines ?? []).find((x) => Number(x.priceE6) === FREE_PACK_PRICE_E6) ?? null)).catch(() => {});
  }, []);

  const balance = Number(gold?.balance ?? 0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const from = shown, t0 = performance.now(), dur = 900;
    const step = (now) => { const k = Math.min(1, (now - t0) / dur); setShown(Math.round(from + (balance - from) * (1 - Math.pow(1 - k, 3)))); if (k < 1) raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [balance]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── "How to earn Gold" guidance: a tap "i" toggletip (A) + a one-time intro coachmark (D) ──
  const [howOpen, setHowOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const infoRef = useRef(null);
  const popRef = useRef(null);

  // Popover dismissal — outside-tap + Esc (WCAG 1.4.13: dismissible + keyboard-reachable). Tap-triggered,
  // not hover, so it works on touch where the games page mostly lives.
  useEffect(() => {
    if (!howOpen) return undefined;
    const onDown = (e) => { if (!popRef.current?.contains(e.target) && !infoRef.current?.contains(e.target)) setHowOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setHowOpen(false); infoRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [howOpen]);

  // One-time intro coachmark — shows once (next visit after this ships), then never again. Marked seen the
  // moment it shows (persisted), so a reload mid-view won't re-trigger it. Only fires when the vault renders.
  useEffect(() => {
    if (!enabled || !gold) return undefined;
    let seen = true;
    try { seen = localStorage.getItem('gachadex_gold_coach_seen') === '1'; } catch { /* private mode → treat as seen, never nag */ }
    if (seen) return undefined;
    const t = setTimeout(() => {
      setCoachOpen(true);
      try { localStorage.setItem('gachadex_gold_coach_seen', '1'); } catch { /* ignore */ }
    }, 900);
    return () => clearTimeout(t);
  }, [enabled, gold]);

  if (!enabled || !gold) return null;

  const pct = Math.min(100, Math.round((balance / FREE_PACK_GOLD) * 100));
  const ready = balance >= FREE_PACK_GOLD && !!machine25;
  const C = 2 * Math.PI * 19;

  const claim = async () => {
    if (!ready || busy) return;
    setErr(null); setBusy(true);
    try {
      const key = crypto.randomUUID();
      const r = await api.openGachaPack(machine25.code, key, machine25.priceE6, 'gold', false, true);
      setRevealResult(null); setRevealOpen(true); // the charge succeeded → open the reveal (charging covers the poll); a sync 403 above never flashes it
      setRevealResult(await pollGachaOpen(r));
    } catch (e) { setRevealOpen(false); setErr(e?.status === 401 ? 'Sign in to claim.' : e.message); }
    finally { setBusy(false); load(); }
  };

  return (
    <>
      <div className={`gold-vault ${ready ? 'ready' : ''} ${coachOpen ? 'gv-coach-on' : ''}`}>
        <div className="gv-top">
          <span className="gv-label">GOLD</span>
          <button
            type="button"
            ref={infoRef}
            className="gv-info"
            aria-label="How to earn Gold"
            aria-expanded={howOpen}
            onClick={() => setHowOpen((o) => !o)}
          >i</button>
        </div>
        <div className="gv-mid"><GoldBar size={22} className="gv-bar" /><span className="gv-amt">{fmt(shown)}</span></div>
        {ready ? (
          <button className="gv-claim" disabled={busy} onClick={claim}>✦ Claim free pack</button>
        ) : (
          <div className="gv-prog">
            <svg className="gv-ring" viewBox="0 0 46 46" aria-hidden="true">
              <circle className="gv-ring-bg" cx="23" cy="23" r="19" />
              <circle className="gv-ring-fg" cx="23" cy="23" r="19" style={{ strokeDasharray: `${(C * pct) / 100} ${C}` }} />
            </svg>
            <span className="gv-goal"><b>{fmt(gold.untilFreePackGold)}</b> to your<br />next free $25 pack</span>
          </div>
        )}
        {err && <div className="gv-err">{err}</div>}

        {/* A — "How to earn Gold" toggletip: tap-triggered popover, details on demand (not a hover tooltip) */}
        {howOpen && (
          <div className="gv-howpop" ref={popRef} role="dialog" aria-label="How to earn Gold">
            <div className="gv-howpop-title">How to earn Gold</div>
            <div className="gv-earn"><span className="gv-earn-e" aria-hidden="true">🎴</span><span>Open a pack with <b>USDC</b> → earn <b>Gold</b> back (~2.5%)</span></div>
            <div className="gv-earn"><span className="gv-earn-e" aria-hidden="true">🏆</span><span><b>25,000 Gold</b> = a free <b>$25 pack</b></span></div>
            <div className="gv-earn"><span className="gv-earn-e" aria-hidden="true">💡</span><span><b>1,000 Gold ≈ $1</b> of pack value</span></div>
            <div className="gv-howpop-fine">Gold pulls earn none · not withdrawable — it pays you back in free packs.</div>
            <a className="gv-howpop-more" href="/docs#gold-rewards">Learn more →</a>
          </div>
        )}

        {/* D — one-time intro coachmark (shown once per browser, then never again) */}
        {coachOpen && (
          <div className="gv-coach" role="dialog" aria-label="Gold vault tip">
            <strong className="gv-coach-h">Meet your Gold vault</strong>
            <span className="gv-coach-p">Earn Gold on every USDC pull — fill the ring for a free $25 pack.</span>
            <button type="button" className="gv-coach-got" onClick={() => setCoachOpen(false)}>Got it</button>
          </div>
        )}
      </div>
      {revealOpen && (
        <GachaReveal
          result={revealResult} spentE6="0" canSell={false} canTrade={false}
          onSellNow={() => {}} onTrade={() => {}}
          onClose={() => { setRevealOpen(false); setRevealResult(null); }} instantCutBps={instantCutBps}
        />
      )}
    </>
  );
}
