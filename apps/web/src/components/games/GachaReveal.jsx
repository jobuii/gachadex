import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatUsd } from '@pokex/pricing';
import { playSound, stopSound, isMuted, toggleMuted } from '../../lib/sound.js';
import { RevealFX } from './RevealFX.jsx';

// The Classic Gacha reveal "moment" (docs/classic-gacha-cc-packs-spec.md). A full-screen overlay that opens in
// a charging/suspense state (covering the open+poll latency), then runs a rarity-escalating beat sequence
// — Certified grade → Tier → 3D flip → revealed card — with tiered payoff: commons land softly; rares get a
// confetti puff + win sting; EPIC/legendary get the jackpot (confetti + coin/card rain + value count-up +
// slot-machine cash jingle + screen shake). CSS-only visuals; particles via RevealFX; sounds via lib/sound
// (on by default, mute toggle). Beats/effects auto-skip under prefers-reduced-motion via the FX layer + CSS.

const usd = (e6) => formatUsd(BigInt(e6 || 0));

const RARITY = {
  common: { color: '#ef4444', label: 'Common', fx: null, sound: 'winCommon' }, // red
  uncommon: { color: '#22c55e', label: 'Uncommon', fx: null, sound: 'winCommon' }, // green
  rare: { color: '#a855f7', label: 'Rare', fx: 'rare', sound: 'winRare' }, // violet — lighter celebration
  epic: { color: '#f59e0b', label: 'Epic', fx: 'epic', sound: 'winEpic' }, // gold — the full jackpot
};
const tierOf = (r) => RARITY[(r || '').toLowerCase()] ?? RARITY.common;

// Per-tier beat timings (ms): Year → Grade → Type → flip → done (revealed card). Each beat lingers ~1.1s so the
// reveal builds anticipation rare.win-style; rares/epics stretch further for the payoff. Multi-opens skip this
// (they go straight to the summary) so a slow single reveal never becomes tedious across a 5-pack.
const BEATS = {
  base: { year: 650, grade: 1800, tier: 3000, flip: 4050, done: 4750 },
  rare: { year: 800, grade: 2200, tier: 3650, flip: 4900, done: 5800 },
  epic: { year: 1000, grade: 2800, tier: 4700, flip: 6200, done: 7300 },
};

export function GachaReveal({ result, spentE6, canSell, canTrade, onSellNow, onTrade, onClose, instantCutBps = 1000 }) {
  const card = result?.card ?? null;
  const tier = card ? tierOf(card.rarity) : null;
  const big = tier?.fx ?? null; // 'rare' | 'epic' | null
  const [phase, setPhase] = useState('charging'); // charging | year | grade | tier | flip | done | failed
  const [muted, setMutedState] = useState(isMuted());
  const [shownE6, setShownE6] = useState(null); // EPIC value count-up
  const coinLoop = useRef(null);
  const timers = useRef([]);
  const started = useRef(false);

  useEffect(() => {
    playSound('rip');
    const t = timers;
    const loop = coinLoop;
    // Re-arm `started` on cleanup so React 18 StrictMode's dev mount→unmount→mount double-invoke reschedules
    // the beats instead of clearing them and freezing on the card-back (rare.win's CardReveal hits the same).
    return () => { t.current.forEach(clearTimeout); t.current = []; stopSound(loop.current); started.current = false; };
  }, []);

  // Once the open result lands, run the beat sequence exactly once.
  useEffect(() => {
    if (!result || started.current) return;
    started.current = true;
    if (!card) {
      if (result.status === 'turbo_sold') { setPhase('turbo'); playSound('winRare'); playSound('confetti', { volume: 0.5 }); }
      else setPhase('failed');
      return;
    }
    const seq = big === 'epic' ? BEATS.epic : big === 'rare' ? BEATS.rare : BEATS.base;
    const at = (ms, fn) => timers.current.push(setTimeout(fn, ms));
    at(seq.year, () => { setPhase('year'); playSound('beat', { volume: 0.7 }); });
    at(seq.grade, () => { setPhase('grade'); playSound('beat'); });
    at(seq.tier, () => { setPhase('tier'); playSound('beat', { volume: 0.9 }); });
    at(seq.flip, () => { setPhase('flip'); playSound('flip'); });
    at(seq.done, () => {
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
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
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
  const sellNetE6 = card?.valueE6 ? (BigInt(card.valueE6) * (10_000n - BigInt(instantCutBps))) / 10_000n : 0n;

  const close = () => { stopSound(coinLoop.current); onClose(); };

  return createPortal(
    <div className={`gacha-reveal-overlay ${big && done ? `gr-pop-${big}` : ''}`} onClick={close}>
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

            <div className="gacha-card3d-wrap" style={{ '--rarity': tier?.color ?? '#8b5cf6' }}>
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
                      <div className="gacha-beat-in"><span className="gacha-beat-label">Tier</span><span className="gacha-beat-val gacha-beat-tier">{tier.label}</span></div>
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
                <p className="gacha-reveal-spent muted">Spent {usd(spentE6)} · this slab is worth ~{usd(card?.valueE6)}</p>
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
