import { useEffect, useRef } from 'react';

// Hand-rolled particle burst for the Classic Gacha reveal payoff (no dependency). One full-screen <canvas>
// + requestAnimationFrame, capped well under ~200 particles for 60fps (per canvas-confetti perf guidance).
// kind='rare' → a confetti puff; kind='epic' → the jackpot: confetti + gold-coin rain + falling TCG cards.
// Renders nothing for reduced-motion or when inactive. The card/coin shapes are drawn (no image loads).

const prefersReducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function RevealFX({ kind, color = '#f59e0b' }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!kind || prefersReducedMotion()) return undefined;
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    const resize = () => { W = canvas.width = window.innerWidth * dpr; H = canvas.height = window.innerHeight * dpr; };
    resize();
    window.addEventListener('resize', resize);

    const rnd = (a, b) => a + Math.random() * (b - a);
    const epic = kind === 'epic';
    const confettiColors = ['#f59e0b', '#a855f7', '#22c55e', '#3b82f6', '#ef4444', '#ffffff', color];
    const counts = epic ? { confetti: 90, coin: 60, card: 22 } : { confetti: 55, coin: 0, card: 0 };
    const parts = [];

    for (let i = 0; i < counts.confetti; i++) parts.push({ // burst from upper-centre, spread + fall
      type: 'confetti', x: rnd(0.3, 0.7) * W, y: rnd(0, 0.2) * H,
      vx: rnd(-6, 6) * dpr, vy: rnd(-2, 6) * dpr, g: 0.18 * dpr,
      w: rnd(5, 11) * dpr, h: rnd(8, 16) * dpr, rot: rnd(0, 6.28), vr: rnd(-0.3, 0.3),
      color: confettiColors[(Math.random() * confettiColors.length) | 0], life: rnd(90, 170),
    });
    for (let i = 0; i < counts.coin; i++) parts.push({ // gold-coin rain from the top
      type: 'coin', x: rnd(0, 1) * W, y: rnd(-0.4, 0) * H,
      vx: rnd(-1, 1) * dpr, vy: rnd(3, 8) * dpr, g: 0.12 * dpr,
      r: rnd(9, 16) * dpr, rot: rnd(0, 6.28), vr: rnd(-0.2, 0.2), life: rnd(140, 240),
    });
    for (let i = 0; i < counts.card; i++) parts.push({ // tumbling mini TCG cards
      type: 'card', x: rnd(0, 1) * W, y: rnd(-0.6, -0.1) * H,
      vx: rnd(-1.5, 1.5) * dpr, vy: rnd(2.5, 6) * dpr, g: 0.1 * dpr,
      w: rnd(26, 40) * dpr, h: rnd(36, 56) * dpr, rot: rnd(0, 6.28), vr: rnd(-0.12, 0.12), life: rnd(160, 260),
    });

    let raf = 0;
    let frame = 0;
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      for (const p of parts) {
        if (p.life <= 0) continue;
        alive++;
        p.life -= 1; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.life / 40);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        if (p.type === 'confetti') {
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        } else if (p.type === 'coin') {
          ctx.fillStyle = '#f4c430';
          ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 6.28); ctx.fill();
          ctx.fillStyle = '#fff3b0'; // shine
          ctx.beginPath(); ctx.arc(-p.r * 0.3, -p.r * 0.3, p.r * 0.4, 0, 6.28); ctx.fill();
        } else {
          const g = ctx.createLinearGradient(-p.w / 2, -p.h / 2, p.w / 2, p.h / 2);
          g.addColorStop(0, color); g.addColorStop(1, '#15151f');
          ctx.fillStyle = g;
          roundRect(ctx, -p.w / 2, -p.h / 2, p.w, p.h, 4 * dpr); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = dpr; ctx.stroke();
        }
        ctx.restore();
      }
      frame += 1;
      if (alive > 0 && frame < 460) { raf = requestAnimationFrame(draw); } else { ctx.clearRect(0, 0, W, H); }
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [kind, color]);

  if (!kind || prefersReducedMotion()) return null;
  return <canvas ref={ref} className="gacha-fx-canvas" aria-hidden />;
}
