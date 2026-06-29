import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from './gacha-util.js';

// Ambient backdrop for the Classic Gacha reveal: soft nebula clouds, rarity-tinted light rays, drifting
// bokeh orbs (all CSS), floating "motes", and a cursor-trail of rarity-coloured embers (canvas). Intensity
// scales with the pulled tier (set in CSS via data-gtier). Everything is decorative + aria-hidden, and all
// motion is gated by prefers-reduced-motion (the ember canvas no-ops, motes/animations are killed in CSS).

const MOTE_COUNT = { common: 8, uncommon: 12, rare: 16, epic: 26 };

export function RevealAmbient({ tier = 'rare', color = '#8b5cf6' }) {
  const trailRef = useRef(null);
  const motesRef = useRef(null);

  // Populate the mote layer imperatively — a randomized decorative scatter scaled by tier. Done in an effect
  // (not render) so Math.random stays out of the render path; cleared + re-rolled when the tier changes.
  useEffect(() => {
    const box = motesRef.current;
    if (!box) return undefined;
    box.replaceChildren();
    if (prefersReducedMotion()) return undefined;
    const n = MOTE_COUNT[tier] ?? 12;
    for (let i = 0; i < n; i++) {
      const m = document.createElement('span');
      m.className = 'gr-mote';
      m.style.left = `${Math.random() * 100}%`;
      m.style.animationDuration = `${7 + Math.random() * 8}s`;
      m.style.animationDelay = `${-Math.random() * 12}s`;
      m.style.setProperty('--drift', `${Math.random() * 60 - 30}px`);
      const s = 2 + Math.random() * 3;
      m.style.width = `${s}px`;
      m.style.height = `${s}px`;
      box.appendChild(m);
    }
    return () => { box.replaceChildren(); };
  }, [tier]);

  // Cursor-trail embers on a full-screen canvas. Spawns sparks under the pointer; when the pointer is idle
  // it drifts a virtual cursor near centre so the effect never fully dies. rAF + array splice, no allocations
  // in the hot path beyond the spark objects themselves.
  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const canvas = trailRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    const resize = () => { W = canvas.width = window.innerWidth * dpr; H = canvas.height = window.innerHeight * dpr; };
    resize();
    window.addEventListener('resize', resize);

    const embers = [];
    let lastEm = 0;
    let lastMove = -9999;
    const cur = { x: 0.5, y: 0.46 }; // normalized virtual-cursor position for the idle drift
    const mk = (x, y) => embers.push({
      x, y,
      vx: (Math.random() - 0.5) * 0.7 * dpr, vy: (Math.random() - 0.5) * 0.7 * dpr,
      buoy: (-0.02 - Math.random() * 0.03) * dpr, r: (1.4 + Math.random() * 2.4) * dpr,
      life: 1, col: Math.random() < 0.55 ? color : '#fff',
    });
    const onMove = (e) => {
      const now = performance.now();
      cur.x = e.clientX / window.innerWidth; cur.y = e.clientY / window.innerHeight;
      lastMove = now;
      if (now - lastEm > 14) { lastEm = now; mk(e.clientX * dpr, e.clientY * dpr); mk(e.clientX * dpr, e.clientY * dpr); }
    };
    window.addEventListener('pointermove', onMove);

    let raf = 0;
    const tick = () => {
      const now = performance.now();
      if (now - lastMove > 1300) { // idle: orbit a virtual cursor near centre and emit gently
        const t = now / 1000;
        cur.x = 0.5 + 0.16 * Math.cos(t * 0.45); cur.y = 0.46 + 0.13 * Math.sin(t * 0.62);
        if (now - lastEm > 55) { lastEm = now; mk(cur.x * W, cur.y * H); }
      }
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = embers.length - 1; i >= 0; i--) {
        const em = embers[i];
        em.x += em.vx; em.y += em.vy; em.vy += em.buoy; em.life -= 0.02; em.r *= 0.985;
        if (em.life <= 0) { embers.splice(i, 1); continue; }
        ctx.globalAlpha = Math.max(0, em.life) * 0.75;
        ctx.fillStyle = em.col;
        ctx.beginPath(); ctx.arc(em.x, em.y, em.r, 0, 6.28); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); window.removeEventListener('pointermove', onMove); };
  }, [color]);

  return (
    <div className="gacha-reveal-env" data-gtier={tier} style={{ '--rarity': color }} aria-hidden>
      <div className="gr-nebula"><span /></div>
      <div className="gr-rays"><span className="gr-ray-glow" /><span className="gr-ray-fan" /></div>
      <div className="gr-bokeh"><span className="b1" /><span className="b2" /><span className="b3" /><span className="b4" /><span className="b5" /></div>
      <canvas ref={trailRef} className="gr-trail" />
      <div className="gr-motes" ref={motesRef} />
    </div>
  );
}
