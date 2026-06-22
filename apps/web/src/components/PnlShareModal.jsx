import { useEffect, useRef, useState } from 'react';
import { formatPct } from '@pokex/pricing';
import * as api from '../lib/api.js';

// ---- canvas geometry + palette (GachaDex brand — fixed, since the card is a shared artifact) ----
const W = 1200;
const H = 750;
const PAD = 40;
const C = {
  bg: '#06060a',
  screenBorder: '#6D28D9',
  gold: '#22D3EE', // brand cyan (the secondary accent that replaced the old gold)
  cream: '#F5F5F7',
  dark: '#06060a',
  green: '#34D399',
  red: '#F43F5E',
  muted: '#8B8B95',
  cyan: '#22D3EE',
  violet: '#8B5CF6',
  pink: '#F472B6',
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

// A smooth trend line matching the hero terminal chart — the hero's zigzag pattern, rising for a
// profit / falling for a loss, drawn with a left→right gradient stroke + a soft glow underlayer
// (cyan→green when up, pink→red when down). Illustrative — positions carry no per-trade history.
function drawTrendChart(ctx, x, y, w, h, gain) {
  const up = gain >= 0;
  const HERO = [[0, 95], [30, 80], [55, 88], [80, 60], [110, 68], [140, 40], [170, 50], [200, 22], [230, 30], [260, 8]];
  const XMAX = 260, YMIN = 8, YMAX = 95;
  const path = HERO.map(([px, py]) => {
    const fx = px / XMAX;
    let fy = (py - YMIN) / (YMAX - YMIN); // 1 at the low end, 0 at the top → rises left→right for a profit
    if (!up) fy = 1 - fy;                 // mirror to a falling line for a loss
    return [x + fx * w, y + fy * h];
  });
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, up ? C.cyan : C.pink);
  grad.addColorStop(1, up ? C.green : C.red);
  const stroke = (width, alpha, blur) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = grad;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (blur) { ctx.shadowColor = up ? C.green : C.red; ctx.shadowBlur = blur; }
    ctx.beginPath();
    path.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
    ctx.stroke();
    ctx.restore();
  };
  stroke(7, 0.45, 18); // soft glow underlayer
  stroke(4, 1, 0);     // sharp line on top
}

function drawCard(canvas, d, bgImg) {
  const ctx = canvas.getContext('2d');
  const pos = d.side === 'long';
  const gain = d.roePct;
  const accent = gain >= 0 ? C.green : C.red;

  // base + the traded card's art, cover-fit behind the WHOLE card at low opacity, then a dark overlay
  // for text contrast. The screen/panels draw over it, so the art shows through faintly everywhere.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  if (bgImg) {
    const scale = Math.max(W / bgImg.width, H / bgImg.height);
    const iw = bgImg.width * scale;
    const ih = bgImg.height * scale;
    ctx.globalAlpha = 0.38;
    ctx.drawImage(bgImg, (W - iw) / 2, 0, iw, ih); // top-aligned: show the card's TOP (name + upper art), cropped at the bottom
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(6,6,10,0.44)';
    ctx.fillRect(0, 0, W, H);
  }

  // ---- header: GACHA·DEX wordmark (text only — no gem) ----
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = "700 27px 'Space Grotesk', sans-serif";
  ctx.fillStyle = C.cream;
  const wx = PAD;
  ctx.fillText('GACHA', wx, PAD + 17);
  const gachaW = ctx.measureText('GACHA').width;
  const wgrad = ctx.createLinearGradient(wx + gachaW, 0, wx + gachaW + 90, 0);
  wgrad.addColorStop(0, C.cyan);
  wgrad.addColorStop(1, C.pink);
  ctx.fillStyle = wgrad;
  ctx.fillText('DEX', wx + gachaW, PAD + 17);
  // top-right CTA badge
  ctx.font = "700 15px 'Space Grotesk', sans-serif";
  const cta = 'TRADE NOW';
  const cw = ctx.measureText(cta).width + 34;
  roundRect(ctx, W - PAD - cw, PAD, cw, 34, 7);
  ctx.fillStyle = C.gold;
  ctx.fill();
  ctx.fillStyle = C.dark;
  ctx.fillText(cta, W - PAD - cw + 17, PAD + 17);

  // ---- screen ---- (shorter, to leave whitespace above the footer)
  const sx = PAD;
  const sy = 108;
  const sw = W - PAD * 2;
  const sh = 480;
  roundRect(ctx, sx, sy, sw, sh, 6);
  ctx.fillStyle = 'rgba(8,8,16,0.34)'; // semi-transparent so the full-bleed card art shows through
  ctx.fill();
  ctx.strokeStyle = C.screenBorder;
  ctx.lineWidth = 2;
  roundRect(ctx, sx, sy, sw, sh, 6);
  ctx.stroke();

  // headline: name + side badge
  const tx = sx + 36;
  ctx.font = "700 32px 'Space Grotesk', sans-serif";
  ctx.fillStyle = C.cream;
  ctx.fillText(d.name, tx, sy + 58);
  const nameW = ctx.measureText(d.name).width;
  ctx.font = "700 18px 'Space Grotesk', sans-serif";
  const badge = `${pos ? 'LONG' : 'SHORT'} ${d.leverage}X`;
  const bw = ctx.measureText(badge).width + 28;
  roundRect(ctx, tx + nameW + 24, sy + 40, bw, 36, 7);
  ctx.fillStyle = pos ? C.gold : C.red;
  ctx.fill();
  ctx.fillStyle = pos ? C.dark : C.cream;
  ctx.fillText(badge, tx + nameW + 38, sy + 58);

  // hero %
  ctx.font = "700 92px 'Space Grotesk', sans-serif";
  ctx.fillStyle = accent;
  ctx.fillText(formatPct(gain, 0), tx - 4, sy + 150);

  // stylized trend chart in the lower screen (matches the hero terminal line)
  drawTrendChart(ctx, tx, sy + 250, sw - 72, sh - 300, gain);

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
    ctx.font = "600 16px 'Space Grotesk', sans-serif";
    ctx.fillStyle = fg === C.cream ? 'rgba(243,237,224,0.6)' : 'rgba(21,16,10,0.6)';
    ctx.fillText(label, px + 18, py + 27);
    ctx.font = "700 26px 'Space Grotesk', sans-serif";
    ctx.fillStyle = valColor || fg;
    ctx.fillText(value, px + 18, py + 57);
  };
  panel(0, 'INVESTED', d.invested, C.dark, C.gold, C.dark);
  panel(1, 'POSITION', d.position, C.dark, C.cream, C.dark);
  panel(2, 'PNL', d.pnl, gain >= 0 ? '#0a6b2e' : '#9a1414', C.gold, C.dark);

  // ---- footer ----
  ctx.font = "600 17px 'Space Grotesk', sans-serif";
  ctx.fillStyle = C.muted;
  ctx.fillText('GACHADEX.FUN', PAD, H - 24);
  if (d.ref) {
    const ref = d.ref.toUpperCase();
    ctx.textAlign = 'right';
    ctx.fillText(ref, W - PAD, H - 24);
    ctx.textAlign = 'left';
  }
}

// Share-card trigger icon (curved "share/export" arrow) — shared by the open-positions + history PnL cells.
export function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20c0-6.6 5.4-12 12-12" />
      <path d="M11 13l5-5-5-5" />
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
      const name = shortName(details?.displayName ?? position.displayName, position.symbol);
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
      // ensure the brand font (both weights the card uses) is loaded before drawing canvas text
      await Promise.all([
        document.fonts.load("700 22px 'Space Grotesk'"),
        document.fonts.load("600 16px 'Space Grotesk'"),
        document.fonts.load("16px 'Space Grotesk'"),
      ]).catch(() => {});
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
          <button className="btn-primary sm" disabled={!ready} onClick={onDownload}>Download</button>
          <button className="btn-ghost sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
