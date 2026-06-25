import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { playSound, stopSound, isMuted, toggleMuted } from '../../lib/sound.js';
import { RevealFX } from './RevealFX.jsx';
import { RARITY_COLORS, usd, netAfterCutE6 } from './gacha-util.js';

// The Classic Gacha reveal "moment" (docs/classic-gacha-cc-packs-spec.md). A full-screen overlay that opens in
// a charging/suspense state (covering the open+poll latency), then runs a rarity-escalating beat sequence
// — Certified grade → Tier → 3D flip → revealed card — with tiered payoff: commons land softly; rares get a
// confetti puff + win sting; EPIC/legendary get the jackpot (confetti + coin/card rain + value count-up +
// slot-machine cash jingle + screen shake). CSS-only visuals; particles via RevealFX; sounds via lib/sound
// (on by default, mute toggle). Beats/effects auto-skip under prefers-reduced-motion via the FX layer + CSS.

const RARITY = {
  common: { color: RARITY_COLORS.common, label: 'Common', fx: null, sound: 'winCommon' }, // red
  uncommon: { color: RARITY_COLORS.uncommon, label: 'Uncommon', fx: null, sound: 'winCommon' }, // green
  rare: { color: RARITY_COLORS.rare, label: 'Rare', fx: 'rare', sound: 'winRare' }, // violet — lighter celebration
  epic: { color: RARITY_COLORS.epic, label: 'Epic', fx: 'epic', sound: 'winEpic' }, // gold — the full jackpot
};
const tierOf = (r) => RARITY[(r || '').toLowerCase()] ?? RARITY.common;

// The reveal as RELATIVE gaps (ms): Year → (gradeGap) Grade → (typeGap) Type → (flipGap) flip → (hold) done.
// SAME pacing for every rarity (common through epic). The beats don't start until the RIP sound has finished AND
// the card has animated in (RIP_AUDIBLE_MS below): Year + Grade tick by quickly (~1.2s each), then the Type beat
// and the flipped card each DWELL ~2.5s so the player reads the rarity and sees the card before the info/actions
// appear. Multi-opens skip all of this (straight to the summary) so a slow single reveal never gets tedious.
const BEATS = { gradeGap: 1200, typeGap: 1200, flipGap: 2500, hold: 2500 };
// rip.mp3's tear ends ~2.28s (then ~0.8s of trailing silence) — hold the year beat until then so the rip finishes
// and the card-in animation plays first. If the open+poll already outlasted the rip, just give a short settle.
const RIP_AUDIBLE_MS = 2300;
const MIN_SETTLE_MS = 350;

export function GachaReveal({ result, spentE6, canSell, canTrade, onSellNow, onTrade, onClose, instantCutBps = 1000 }) {
  const card = result?.card ?? null;
  const tier = card ? tierOf(card.rarity) : null;
  const big = tier?.fx ?? null; // 'rare' | 'epic' | null
  const [phase, setPhase] = useState('charging'); // charging | year | grade | tier | flip | done | turbo | pending | failed
  const [muted, setMutedState] = useState(isMuted());
  const [shownE6, setShownE6] = useState(null); // EPIC value count-up
  const coinLoop = useRef(null);
  const timers = useRef([]);
  const started = useRef(false);
  const mountAt = useRef(0); // when the rip started → so the year beat can wait out the rip
  const raf = useRef(0); // the EPIC value count-up frame → cancelled on unmount

  useEffect(() => {
    mountAt.current = performance.now();
    playSound('rip', { debounceMs: 500 }); // once, as the charging screen opens (debounce drops StrictMode's echo)
    const t = timers;
    const loop = coinLoop;
    const rf = raf;
    // Re-arm `started` on cleanup so React 18 StrictMode's dev mount→unmount→mount double-invoke reschedules
    // the beats instead of clearing them and freezing on the card-back (rare.win's CardReveal hits the same).
    return () => { t.current.forEach(clearTimeout); t.current = []; cancelAnimationFrame(rf.current); stopSound(loop.current); started.current = false; };
  }, []);

  // Once the open result lands, run the beat sequence exactly once.
  useEffect(() => {
    if (!result || started.current) return;
    started.current = true;
    if (!card) {
      if (result.status === 'turbo_sold') { setPhase('turbo'); playSound('winRare'); playSound('confetti', { volume: 0.5 }); }
      // Honesty boundary (handoff invariant #3): a still-'paid' result means the reveal poll timed out, NOT a
      // refund — the payment went through and the reconciler will finish it. Never tell the user "refunded" here.
      else if (result.status === 'paid' || result.status === 'pending') setPhase('pending');
      else setPhase('failed'); // refunded / failed → the money was genuinely returned
      return;
    }
    // Start the beats only once the rip has finished (and the card-in animation has played). If the open+poll
    // already ran past the rip, fall back to a short settle. Then space the rest by their relative gaps.
    const yearAt = Math.max(RIP_AUDIBLE_MS - (performance.now() - mountAt.current), MIN_SETTLE_MS);
    const gradeAt = yearAt + BEATS.gradeGap;
    const typeAt = gradeAt + BEATS.typeGap;
    const flipAt = typeAt + BEATS.flipGap;
    const doneAt = flipAt + BEATS.hold;
    const at = (ms, fn) => timers.current.push(setTimeout(fn, ms));
    at(yearAt, () => { setPhase('year'); playSound('beat', { volume: 0.7 }); });
    at(gradeAt, () => { setPhase('grade'); playSound('beat'); });
    // The Type reveal: a plain beat — except EPIC, which lands with a heavy thud (the stamp + screen shake ride the CSS).
    at(typeAt, () => { setPhase('tier'); playSound(big === 'epic' ? 'thud' : 'beat', { volume: big === 'epic' ? 1 : 0.9 }); });
    at(flipAt, () => { setPhase('flip'); playSound('flip'); });
    at(doneAt, () => {
      setPhase('done');
      playSound(tier.sound);
      if (big === 'epic') {
        coinLoop.current = playSound('coins', { loop: true, volume: 0.5 });
        playSound('confetti', { volume: 0.6 });
        const target = Number(card.valueE6 || 0);
        const start = performance.now();
        const dur = 1200;
        const step = (now) => {
          const k = Math.min(1, (now - start) / dur);
          setShownE6(Math.round(target * k));
          raf.current = k < 1 ? requestAnimationFrame(step) : 0;
        };
        raf.current = requestAnimationFrame(step);
      } else if (big === 'rare') {
        playSound('confetti', { volume: 0.5 });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const flipped = phase === 'flip' || phase === 'done';
  const done = phase === 'done';
  const valE6 = shownE6 != null ? String(shownE6) : (card?.valueE6 ?? '0');
  // What the player nets selling this slab straight back to CC now (instant cut, e.g. 10%). Shown on the button.
  const sellNetE6 = card?.valueE6 ? netAfterCutE6(card.valueE6, instantCutBps) : 0n;
  // P&L of this pull: the slab's value vs what the pack cost. Negative = paid more than it's worth.
  const pnlE6 = (card?.valueE6 ? BigInt(card.valueE6) : 0n) - BigInt(spentE6 || 0);

  const close = () => { stopSound(coinLoop.current); onClose(); };

  return createPortal(
    <div className={`gacha-reveal-overlay ${big && done ? `gr-pop-${big}` : ''} ${phase === 'tier' && big === 'epic' ? 'gr-epic-quake' : ''}`} onClick={close}>
      <div className="gacha-reveal-bg" aria-hidden />
      {done && big && <RevealFX kind={big} color={tier.color} />}

      <button
        className="gacha-reveal-mute"
        title={muted ? 'Unmute' : 'Mute'}
        aria-label={muted ? 'Unmute reveal sounds' : 'Mute reveal sounds'}
        onClick={(e) => { e.stopPropagation(); setMutedState(toggleMuted()); }}
      >
        {muted ? '🔇' : '🔊'}
      </button>

      <div className="gacha-reveal-stage" onClick={(e) => e.stopPropagation()}>
        {phase === 'failed' ? (
          <div className="gacha-reveal-failed">
            <h3>The pack didn’t open</h3>
            <p className="muted">Your payment was refunded. Try again in a moment.</p>
            <button className="btn-primary" onClick={close}>Done</button>
          </div>
        ) : phase === 'pending' ? (
          <div className="gacha-reveal-failed">
            <h3>Still opening…</h3>
            <p className="muted">Your payment went through — the reveal is taking a moment. We’ll finish it automatically; your card will appear in your inventory shortly. You were <strong>not</strong> charged twice.</p>
            <button className="btn-primary" onClick={close}>Done</button>
          </div>
        ) : phase === 'turbo' ? (
          <div className="gacha-reveal-failed">
            <div className="gacha-reveal-banner" style={{ color: '#f59e0b' }}>⚡ YOLO</div>
            <div className="gacha-reveal-val" style={{ color: '#22c55e' }}>+{usd(result.turboRefundE6)}</div>
            <p className="muted">Your common was instantly auto-sold for USDC.</p>
            <button className="btn-primary" onClick={close}>Done</button>
          </div>
        ) : (
          <>
            {done && big === 'epic' && <div className="gacha-reveal-banner">{tier.label.toUpperCase()} PULL!</div>}

            <div className="gacha-card3d-wrap gacha-card-enter" style={{ '--rarity': tier?.color ?? '#8b5cf6' }}>
              <div className={`gacha-card3d ${flipped ? 'flipped' : ''} ${done ? `done done-${big || 'base'}` : ''}`}>
                {/* back face — charging + suspense beats */}
                <div className={`gacha-card3d-back ${['year', 'grade', 'tier'].includes(phase) ? 'beat-on' : ''}`}>
                  <div className="gacha-card3d-conic" aria-hidden />
                  {/* dark vignette behind the beat text → high contrast (deepens while a beat shows) */}
                  <div className="gacha-card3d-scrim" aria-hidden />
                  <div className="gacha-card3d-logo" aria-hidden>G</div>
                  <div className="gacha-beat">
                    {phase === 'year' && card?.year && (
                      <div className="gacha-beat-in"><span className="gacha-beat-label">Issued</span><span className="gacha-beat-val">{card.year}</span></div>
                    )}
                    {phase === 'grade' && card?.grade && (
                      <div className="gacha-beat-in"><span className="gacha-beat-label">Certified</span><span className="gacha-beat-val">{card.grade}</span></div>
                    )}
                    {phase === 'tier' && tier && (
                      <div className="gacha-beat-in"><span className="gacha-beat-label">Tier</span><span className={`gacha-beat-val gacha-beat-tier gacha-beat-tier-${(card.rarity || '').toLowerCase()}`}>{tier.label}</span></div>
                    )}
                  </div>
                </div>
                {/* front face — the revealed card */}
                <div className="gacha-card3d-front">
                  {card?.imageUrl
                    ? <img src={card.imageUrl} alt={card.name ?? ''} referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                    : <div className="gacha-card3d-noimg" aria-hidden>🃏</div>}
                </div>
              </div>
            </div>

            {done && (
              <div className="gacha-reveal-info">
                <div className="gacha-reveal-infobox" style={{ '--rarity': tier.color }}>
                  <div className="gacha-reveal-name">{card?.name ?? 'a card'}{card?.grade ? ` · ${card.grade}` : ''}</div>
                  <div className="gacha-reveal-val" style={{ color: tier.color }}>{usd(valE6)}</div>
                  <span className="gacha-reveal-tier-chip">{tier.label}</span>
                </div>
                <div className={`gacha-reveal-pnl ${pnlE6 < 0n ? 'down' : 'up'}`}>
                  <span className="gacha-reveal-pnl-label">{pnlE6 < 0n ? 'Loss' : 'Profit'}</span>
                  <strong>{pnlE6 < 0n ? '−' : '+'}{usd(pnlE6 < 0n ? -pnlE6 : pnlE6)}</strong>
                  <span className="gacha-reveal-pnl-sub muted">paid {usd(spentE6)} · worth {usd(card?.valueE6)}</span>
                </div>
                <div className="gacha-reveal-actions">
                  {canSell && <button className="btn-primary" onClick={onSellNow}>Sell back {usd(sellNetE6)}</button>}
                  {canTrade && <button className="btn-ghost" onClick={onTrade}>Trade</button>}
                  <button className="btn-ghost" onClick={close}>Keep</button>
                </div>
                {result?.verifyUrl && <a className="gacha-verify" href={result.verifyUrl} target="_blank" rel="noreferrer">Verify this rip ↗</a>}
              </div>
            )}

            {!done && <p className="gacha-reveal-charging muted">{result ? 'Revealing…' : 'Opening your pack…'}</p>}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
