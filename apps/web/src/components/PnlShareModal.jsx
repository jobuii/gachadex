import { useEffect, useRef, useState } from 'react';
import { formatPct } from '@pokex/pricing';
import * as api from '../lib/api.js';

// ---- canvas geometry + palette (matches references/PNL-card.png) ----
const W = 1200;
const H = 750;
const PAD = 40;
const C = {
  bg: '#0d0d12',
  screen: '#04140b',
  screenBorder: '#1f5f3a',
  gold: '#f5c542',
  cream: '#f3ede0',
  dark: '#15100a',
  green: '#36e07a',
  red: '#ff5a5a',
  muted: '#6b6b76',
};

const usdc = (e6) => {
  const n = Math.round(Number(e6 ?? 0) / 1e6);
  return `${n.toLocaleString('en-US')} USDC`;
};
const signedUsdc = (e6) => {
  const n = Number(e6 ?? 0) / 1e6;
  const s = Math.round(Math.abs(n)).toLocaleString('en-US');
  return `${n >= 0 ? '+' : '-'}${s} USDC`;
};
// A clean short card name for the headline: drop the "(Set)" + "#123/456" tail, uppercase, clamp.
const shortName = (displayName, symbol) => {
  const base = (displayName || symbol || '').replace(/\(.*?\)/g, '').replace(/#.*/g, '').trim();
  return (base || symbol || 'MARKET').toUpperCase().slice(0, 16);
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

// A deterministic step line that climbs (profit) or falls (loss). Illustrative — positions carry no
// per-trade history. Seeded off the magnitude so the same trade always draws the same line.
function drawStepChart(ctx, x, y, w, h, gain) {
  const steps = 7;
  const seed = Math.abs(Math.round(gain * 100)) % 97;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const jitter = (((seed * (i + 3)) % 11) / 11 - 0.5) * 0.12;
    const base = gain >= 0 ? t : 1 - t; // up for profit, down for loss
    pts.push(Math.min(0.95, Math.max(0.05, base * 0.8 + 0.12 + jitter)));
  }
  ctx.strokeStyle = gain >= 0 ? C.green : C.red;
  ctx.lineWidth = 6;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const px = x + (w * i) / steps;
    const py = y + h - pts[i] * h;
    if (i === 0) ctx.moveTo(px, py);
    else {
      ctx.lineTo(px, y + h - pts[i - 1] * h); // horizontal tread
      ctx.lineTo(px, py); // vertical riser
    }
  }
  ctx.stroke();
}

function drawCard(canvas, d, bgImg) {
  const ctx = canvas.getContext('2d');
  const pos = d.side === 'long';
  const gain = d.roePct;
  const accent = gain >= 0 ? C.green : C.red;

  // base
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- header ----
  ctx.fillStyle = C.gold;
  ctx.beginPath();
  ctx.arc(PAD + 8, PAD + 16, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "22px 'Press Start 2P', monospace";
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.cream;
  ctx.fillText('GACHADEX', PAD + 28, PAD + 17);
  // top-right CTA badge
  ctx.font = "13px 'Press Start 2P', monospace";
  const cta = 'INSERT COIN · TRADE NOW';
  const cw = ctx.measureText(cta).width + 36;
  roundRect(ctx, W - PAD - cw, PAD, cw, 38, 6);
  ctx.fillStyle = C.gold;
  ctx.fill();
  ctx.fillStyle = C.dark;
  ctx.fillText(cta, W - PAD - cw + 18, PAD + 20);

  // ---- screen ----
  const sx = PAD;
  const sy = 108;
  const sw = W - PAD * 2;
  const sh = 512;
  roundRect(ctx, sx, sy, sw, sh, 6);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = C.screen;
  ctx.fillRect(sx, sy, sw, sh);
  if (bgImg) {
    // cover-fit the card art, low opacity, behind everything
    const scale = Math.max(sw / bgImg.width, sh / bgImg.height);
    const iw = bgImg.width * scale;
    const ih = bgImg.height * scale;
    ctx.globalAlpha = 0.16;
    ctx.drawImage(bgImg, sx + (sw - iw) / 2, sy + (sh - ih) / 2, iw, ih);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(4,20,11,0.55)'; // darken for text contrast
    ctx.fillRect(sx, sy, sw, sh);
  }
  ctx.restore();
  ctx.strokeStyle = C.screenBorder;
  ctx.lineWidth = 2;
  roundRect(ctx, sx, sy, sw, sh, 6);
  ctx.stroke();

  // headline: name + side badge
  const tx = sx + 36;
  ctx.font = "26px 'Press Start 2P', monospace";
  ctx.fillStyle = C.cream;
  ctx.fillText(d.name, tx, sy + 56);
  const nameW = ctx.measureText(d.name).width;
  ctx.font = "13px 'Press Start 2P', monospace";
  const badge = `${pos ? 'LONG' : 'SHORT'} ${d.leverage}X`;
  const bw = ctx.measureText(badge).width + 24;
  roundRect(ctx, tx + nameW + 22, sy + 42, bw, 30, 5);
  ctx.fillStyle = pos ? C.gold : C.red;
  ctx.fill();
  ctx.fillStyle = pos ? C.dark : C.cream;
  ctx.fillText(badge, tx + nameW + 34, sy + 58);

  // hero %
  ctx.font = "92px 'Press Start 2P', monospace";
  ctx.fillStyle = accent;
  ctx.fillText(formatPct(gain, 0), tx - 4, sy + 150);

  // stylized chart in the lower screen
  drawStepChart(ctx, tx, sy + 250, sw - 72, sh - 300, gain);

  // ---- bottom panels ----
  const py = sy + sh + 20;
  const ph = 78;
  const gap = 16;
  const pw = (sw - gap * 2) / 3;
  const panel = (i, label, value, valColor, bg, fg) => {
    const px = sx + i * (pw + gap);
    roundRect(ctx, px, py, pw, ph, 6);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.font = "12px 'Press Start 2P', monospace";
    ctx.fillStyle = fg === C.cream ? 'rgba(243,237,224,0.6)' : 'rgba(21,16,10,0.6)';
    ctx.fillText(label, px + 18, py + 24);
    ctx.font = "20px 'Press Start 2P', monospace";
    ctx.fillStyle = valColor || fg;
    ctx.fillText(value, px + 18, py + 52);
  };
  panel(0, 'INVESTED', d.invested, C.dark, C.gold, C.dark);
  panel(1, 'POSITION', d.position, C.dark, C.cream, C.dark);
  panel(2, 'PNL', d.pnl, gain >= 0 ? '#0a6b2e' : '#9a1414', C.gold, C.dark);

  // ---- footer ----
  ctx.font = "12px 'Press Start 2P', monospace";
  ctx.fillStyle = C.muted;
  ctx.fillText('GACHADEX.FUN', PAD, H - 22);
  if (d.ref) {
    const ref = d.ref.toUpperCase();
    ctx.textAlign = 'right';
    ctx.fillText(ref, W - PAD, H - 22);
    ctx.textAlign = 'left';
  }
}

// Share-card trigger icon (upload glyph) — shared by the open-positions + history PnL cells.
export function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
      <path d="M12 16V3" />
      <path d="M8 7l4-4 4 4" />
    </svg>
  );
}

export function PnlShareModal({ position, onClose }) {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState(''); // '', 'copied', 'copyfail'
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [details, ref] = await Promise.all([
        api.getMarketDetails(position.marketId).catch(() => null),
        api.getReferral().then((r) => r?.code).catch(() => null),
      ]);
      // pnlUusdc is unrealized (open positions) or realized (closed history) — the caller picks which.
      const pnlE6 = BigInt(position.pnlUusdc ?? position.unrealizedPnlUusdc ?? '0');
      const margin = BigInt(position.marginUusdc ?? '0');
      const roePct = margin > 0n ? (Number(pnlE6) / Number(margin)) * 100 : 0;
      const name = shortName(position.displayName, position.symbol);
      const data = {
        name,
        side: position.side,
        leverage: position.leverage,
        roePct,
        invested: usdc(margin),
        position: `${(Number(position.qtyE6) / 1e6).toFixed(2)} ${name}`,
        pnl: signedUsdc(pnlE6),
        ref,
      };

      // best-effort card art behind the screen (proxied so the canvas stays exportable)
      let bgImg = null;
      const src = details?.imageLarge ? api.imageProxyUrl(details.imageLarge) : null;
      if (src) {
        bgImg = await new Promise((res) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => res(img);
          img.onerror = () => res(null);
          img.src = src;
        });
      }
      await document.fonts.load("16px 'Press Start 2P'").catch(() => {}); // ensure the pixel font is loaded for canvas text
      if (!alive || !canvasRef.current) return;
      drawCard(canvasRef.current, data, bgImg);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [position]);

  const toBlob = () => new Promise((res) => canvasRef.current.toBlob(res, 'image/png'));

  const onCopy = async () => {
    try {
      const blob = await toBlob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setStatus('copied');
      setTimeout(() => setStatus(''), 1800);
    } catch {
      setStatus('copyfail');
      setTimeout(() => setStatus(''), 2600);
    }
  };

  const onDownload = async () => {
    const blob = await toBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gachadex-pnl-${position.symbol}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-content pnl-share" onClick={(e) => e.stopPropagation()}>
        <canvas ref={canvasRef} width={W} height={H} className="pnl-share-canvas" />
        <div className="pnl-share-actions">
          <button className="btn-secondary sm" disabled={!ready} onClick={onCopy}>
            {status === 'copied' ? 'Copied!' : status === 'copyfail' ? 'Copy failed — Download' : 'Copy image'}
          </button>
          <button className="btn-primary sm" disabled={!ready} onClick={onDownload}>Download PNG</button>
          <button className="btn-ghost sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
