import { useEffect, useRef, useState } from 'react';
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
  common: { color: '#9aa0aa', label: 'Common', fx: null, sound: 'winCommon' },
  uncommon: { color: '#22c55e', label: 'Uncommon', fx: null, sound: 'winCommon' },
  rare: { color: '#3b82f6', label: 'Rare', fx: 'rare', sound: 'winRare' },
  epic: { color: '#a855f7', label: 'Epic', fx: 'epic', sound: 'winEpic' },
  legendary: { color: '#f59e0b', label: 'Legendary', fx: 'epic', sound: 'winEpic' },
  mythic: { color: '#f472b6', label: 'Mythic', fx: 'epic', sound: 'winEpic' },
};
const tierOf = (r) => RARITY[(r || '').toLowerCase()] ?? RARITY.common;

// Per-tier beat timings (ms): grade → tier → flip → done. Epics linger for maximum suspense.
const BEATS = {
  base: { grade: 400, tier: 1100, flip: 1900, done: 2400 },
  rare: { grade: 500, tier: 1500, flip: 2600, done: 3200 },
  epic: { grade: 700, tier: 2100, flip: 3700, done: 4500 },
};

export function GachaReveal({ result, spentE6, canSell, canTrade, onSellNow, onTrade, onClose }) {
  const card = result?.card ?? null;
  const tier = card ? tierOf(card.rarity) : null;
  const big = tier?.fx ?? null; // 'rare' | 'epic' | null
  const [phase, setPhase] = useState('charging'); // charging | grade | tier | flip | done | failed
  const [muted, setMutedState] = useState(isMuted());
  const [shownE6, setShownE6] = useState(null); // EPIC value count-up
  const coinLoop = useRef(null);
  const timers = useRef([]);
  const started = useRef(false);

  useEffect(() => {
    playSound('rip');
    const t = timers;
    const loop = coinLoop;
    return () => { t.current.forEach(clearTimeout); stopSound(loop.current); };
  }, []);

  // Once the open result lands, run the beat sequence exactly once.
  useEffect(() => {
    if (!result || started.current) return;
    started.current = true;
    if (!card) { setPhase('failed'); return; }
    const seq = big === 'epic' ? BEATS.epic : big === 'rare' ? BEATS.rare : BEATS.base;
    const at = (ms, fn) => timers.current.push(setTimeout(fn, ms));
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

  const close = () => { stopSound(coinLoop.current); onClose(); };

  return (
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
        ) : (
          <>
            {done && big === 'epic' && <div className="gacha-reveal-banner">{tier.label.toUpperCase()} PULL!</div>}

            <div className="gacha-card3d-wrap" style={{ '--rarity': tier?.color ?? '#8b5cf6' }}>
              <div className={`gacha-card3d ${flipped ? 'flipped' : ''} ${done ? `done done-${big || 'base'}` : ''}`}>
                {/* back face — charging + suspense beats */}
                <div className="gacha-card3d-back">
                  <div className="gacha-card3d-conic" aria-hidden />
                  <div className="gacha-card3d-logo" aria-hidden>G</div>
                  <div className="gacha-beat">
                    {phase === 'grade' && card?.grade && (
                      <div className="gacha-beat-in"><span className="gacha-beat-label">Certified</span><span className="gacha-beat-val">{card.grade}</span></div>
                    )}
                    {phase === 'tier' && tier && (
                      <div className="gacha-beat-in"><span className="gacha-beat-label">Tier</span><span className="gacha-beat-val" style={{ color: tier.color }}>{tier.label}</span></div>
                    )}
                  </div>
                </div>
                {/* front face — the revealed card */}
                <div className="gacha-card3d-front">
                  {card?.imageUrl
                    ? <img src={card.imageUrl} alt={card.name ?? ''} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                    : <div className="gacha-card3d-noimg" aria-hidden>🃏</div>}
                </div>
              </div>
            </div>

            {done && (
              <div className="gacha-reveal-info">
                <div className="gacha-reveal-name">{card?.name ?? 'a card'}{card?.grade ? ` · ${card.grade}` : ''}</div>
                <div className="gacha-reveal-val" style={{ color: tier.color }}>{usd(valE6)}</div>
                <div className="gacha-reveal-tier" style={{ color: tier.color }}>{tier.label}</div>
                <p className="gacha-reveal-spent muted">Spent {usd(spentE6)} · this slab is worth ~{usd(card?.valueE6)}</p>
                <div className="gacha-reveal-actions">
                  {canSell && <button className="btn-primary" onClick={onSellNow}>Sell now (−10%)</button>}
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
    </div>
  );
}
