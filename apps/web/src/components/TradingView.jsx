import { useEffect, useRef, useState } from 'react';
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  AreaSeries, LineSeries, CandlestickSeries, BaselineSeries, HistogramSeries,
} from 'lightweight-charts';
import { formatUsd, formatPct } from '@pokex/pricing';
import { useRealtime } from '../store/realtime';
import { useAuth } from '../auth/AuthContext';
import { useTheme } from '../store/theme';
import { BottomPanel } from './BottomPanel';
import { MarketThumb } from './MarketThumb';
import * as api from '../lib/api.js';

const TIMEFRAMES = ['1D', '1W', '1M', '3M', '1Y'];
const CHART_TYPES = [{ id: 'area', label: 'Area' }, { id: 'line', label: 'Line' }, { id: 'candles', label: 'Candle' }, { id: 'baseline', label: 'Base' }];
const MA_PERIOD = 7;
const px = (e6) => (e6 == null ? 0 : Number(e6) / 1_000_000);

// Floor "now" to the current timeframe's bucket (hourly for 1D/1W, daily for 1M+), as UTC unix
// seconds — must match the backend bucketing so the live point lands on/after the last candle.
const bucketTime = (tf) => {
  const sec = Math.floor(Date.now() / 1000);
  const size = tf === '1D' || tf === '1W' ? 3600 : 86400;
  return sec - (sec % size);
};

// localStorage-backed prefs (chart type / timeframe / overlays), with safe fallbacks.
const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

// Read the active skin's tokens so the chart matches the theme (recomputed on skin change).
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => (cs.getPropertyValue(name).trim() || fb);
  return {
    bg: v('--bg', '#111418'),
    text: v('--text-muted', '#8b949e'),
    border: v('--border', '#30363d'),
    accent: v('--gold', '#f0c040'),
    up: v('--success', '#3fb950'),
    down: v('--danger', '#f85149'),
    font: v('--font-base', "'Press Start 2P', monospace"),
  };
}

// Simple moving average; leading points (< period) are omitted (lightweight-charts whitespace).
function smaSeries(candles, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

const hexAlpha = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

// Bound the bottom panel so both it and the chart stay usable.
const PANEL_MIN = 120;
const CHART_MIN = 150;
const CHART_CHROME = 190;
const clampPanel = (h) => Math.min(Math.max(h, PANEL_MIN), Math.max(PANEL_MIN + 100, window.innerHeight - CHART_CHROME - CHART_MIN));

export function TradingView({ market, mobile = false, onGoToMarket }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const mainRef = useRef(null);
  const maRef = useRef(null);
  const volRef = useRef(null);
  const priceLinesRef = useRef([]);
  const lastBarRef = useRef(null); // current bucket's bar, for live OHLC updates

  const [tf, setTf] = useState(() => (TIMEFRAMES.includes(load('gachadex_tf', '1M')) ? load('gachadex_tf', '1M') : '1M'));
  const [chartType, setChartType] = useState(() => (CHART_TYPES.some((t) => t.id === load('gachadex_chart_type', 'area')) ? load('gachadex_chart_type', 'area') : 'area'));
  const [maOn, setMaOn] = useState(() => load('gachadex_chart_ma', '0') === '1');
  const [volOn, setVolOn] = useState(() => load('gachadex_chart_vol', '0') === '1');
  const [candles, setCandles] = useState([]);
  const [noData, setNoData] = useState(false);
  const [positions, setPositions] = useState([]);
  const [seriesVersion, setSeriesVersion] = useState(0); // bumped when the main series is rebuilt
  const [panelHeight, setPanelHeight] = useState(() => (mobile ? 0 : clampPanel(Number(localStorage.getItem('gachadex_panel_h')) || 210)));
  const [dragging, setDragging] = useState(false);

  const marks = useRealtime((s) => s.marks);
  const oi = useRealtime((s) => s.oi);
  const watch = useRealtime((s) => s.watch);
  const unwatch = useRealtime((s) => s.unwatch);
  const skin = useTheme((s) => s.skin);
  const { user } = useAuth();

  const liveMark = market ? marks[market.id]?.markE6 ?? market.markE6 : null;
  const liveIndex = market ? marks[market.id]?.indexE6 ?? market.indexE6 : null;
  const change = market?.change24hPct ?? 0;
  const changeUp = change >= 0;

  useEffect(() => save('gachadex_tf', tf), [tf]);
  useEffect(() => save('gachadex_chart_type', chartType), [chartType]);
  useEffect(() => save('gachadex_chart_ma', maOn ? '1' : '0'), [maOn]);
  useEffect(() => save('gachadex_chart_vol', volOn ? '1' : '0'), [volOn]);

  // create the chart once; the container tracks its own size via ResizeObserver
  useEffect(() => {
    if (!elRef.current) return undefined;
    const chart = createChart(elRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#111418' }, textColor: '#8b949e', fontSize: 12 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: '#30363d' },
      timeScale: { borderColor: '#30363d', timeVisible: true },
      crosshair: { mode: CrosshairMode.Normal },
      width: elRef.current.clientWidth,
      height: elRef.current.clientHeight,
    });
    chartRef.current = chart;
    const fit = () => elRef.current && chart.applyOptions({ width: elRef.current.clientWidth, height: elRef.current.clientHeight });
    const ro = new ResizeObserver(fit);
    ro.observe(elRef.current);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
      chart.remove();
      chartRef.current = mainRef.current = maRef.current = volRef.current = null;
    };
  }, []);

  // subscribe to the selected market's live channels
  useEffect(() => {
    if (!market) return undefined;
    watch(market.id);
    return () => unwatch(market.id);
  }, [market?.id, watch, unwatch]);

  // load candle history on market / timeframe change
  useEffect(() => {
    if (!market) return undefined;
    let alive = true;
    api.getCandles(market.id, tf)
      .then(({ candles: data }) => {
        if (!alive) return;
        setCandles(data);
        setNoData(data.length === 0);
      })
      .catch(() => alive && setCandles([]));
    return () => { alive = false; };
  }, [market?.id, tf]);

  // chart chrome (background / text / borders) follows the active skin
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const t = readTheme();
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontFamily: t.font },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
  }, [skin]);

  // the PRICE series — rebuilt only on chart-type or skin change, re-fed on new data. Overlays
  // (MA / volume) live in their own effects below, so toggling them never disturbs this series.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const t = readTheme();
    if (mainRef.current) { try { chart.removeSeries(mainRef.current); } catch { /* gone */ } mainRef.current = null; }
    priceLinesRef.current = [];

    const closes = candles.map((c) => ({ time: c.time, value: c.close }));
    if (chartType === 'candles') {
      mainRef.current = chart.addSeries(CandlestickSeries, { upColor: t.up, downColor: t.down, borderUpColor: t.up, borderDownColor: t.down, wickUpColor: t.up, wickDownColor: t.down });
      mainRef.current.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === 'line') {
      mainRef.current = chart.addSeries(LineSeries, { color: t.accent, lineWidth: 2 });
      mainRef.current.setData(closes);
    } else if (chartType === 'baseline') {
      mainRef.current = chart.addSeries(BaselineSeries, {
        baseValue: { type: 'price', price: closes.length ? closes[0].value : 0 },
        topLineColor: t.up, topFillColor1: hexAlpha(t.up, 0.28), topFillColor2: hexAlpha(t.up, 0.05),
        bottomLineColor: t.down, bottomFillColor1: hexAlpha(t.down, 0.05), bottomFillColor2: hexAlpha(t.down, 0.28),
        lineWidth: 2,
      });
      mainRef.current.setData(closes);
    } else {
      mainRef.current = chart.addSeries(AreaSeries, { lineColor: t.accent, topColor: hexAlpha(t.accent, 0.25), bottomColor: hexAlpha(t.accent, 0.0), lineWidth: 2 });
      mainRef.current.setData(closes);
    }
    chart.timeScale().fitContent();
    lastBarRef.current = candles.length ? { ...candles[candles.length - 1] } : null;
    setSeriesVersion((v) => v + 1); // signal the price-line effect to redraw on the new series
  }, [candles, chartType, skin]);

  // MA(7) overlay — toggled independently of the price series (no flicker)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (maRef.current) { try { chart.removeSeries(maRef.current); } catch { /* gone */ } maRef.current = null; }
    if (maOn && candles.length >= MA_PERIOD) {
      const t = readTheme();
      maRef.current = chart.addSeries(LineSeries, { color: hexAlpha(t.text, 0.9), lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      maRef.current.setData(smaSeries(candles, MA_PERIOD));
    }
  }, [candles, maOn, skin]);

  // volume histogram on the bottom strip — toggled independently of the price series
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (volRef.current) { try { chart.removeSeries(volRef.current); } catch { /* gone */ } volRef.current = null; }
    if (volOn) {
      const t = readTheme();
      volRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
      volRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volRef.current.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: hexAlpha(c.close >= c.open ? t.up : t.down, 0.5) })));
    }
  }, [candles, volOn, skin]);

  // draw entry / liquidation price lines for any open position in this market
  useEffect(() => {
    const series = mainRef.current;
    if (!series) return;
    const t = readTheme();
    for (const l of priceLinesRef.current) { try { series.removePriceLine(l); } catch { /* gone */ } }
    priceLinesRef.current = [];
    for (const p of positions) {
      const entry = px(p.avgEntryE6);
      const liq = px(p.liqPriceE6);
      if (entry > 0) priceLinesRef.current.push(series.createPriceLine({ price: entry, color: hexAlpha(t.text, 0.9), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `entry ${p.side}` }));
      if (liq > 0) priceLinesRef.current.push(series.createPriceLine({ price: liq, color: t.down, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'liq' }));
    }
  }, [positions, seriesVersion]);

  // live-update the latest bar from the mark feed (maintains the current bucket's OHLC for candles)
  useEffect(() => {
    if (!market || !mainRef.current || !liveMark) return;
    const time = bucketTime(tf);
    const price = px(liveMark);
    let bar = lastBarRef.current;
    if (!bar || bar.time < time) bar = { time, open: price, high: price, low: price, close: price };
    else bar = { time, open: bar.open, high: Math.max(bar.high, price), low: Math.min(bar.low, price), close: price };
    lastBarRef.current = bar;
    try {
      mainRef.current.update(chartType === 'candles' ? bar : { time, value: price });
      setNoData(false);
    } catch { /* out-of-order time during a history reload */ }
  }, [liveMark, market?.id, tf, chartType]);

  // open positions for this market (auth-only); polled so a fresh open/close updates the lines
  useEffect(() => {
    if (!market || !user) { setPositions([]); return undefined; }
    let alive = true;
    const refresh = () => api.getPositions()
      .then((r) => alive && setPositions((r.positions ?? []).filter((p) => p.marketId === market.id)))
      .catch(() => {});
    refresh();
    const id = setInterval(refresh, 8000);
    return () => { alive = false; clearInterval(id); };
  }, [market?.id, user]);

  // persist the panel height + re-clamp it if the window shrinks (desktop-only machinery)
  useEffect(() => { if (!mobile) localStorage.setItem('gachadex_panel_h', String(panelHeight)); }, [panelHeight, mobile]);
  useEffect(() => {
    if (mobile) return undefined;
    const onResize = () => setPanelHeight((h) => clampPanel(h));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mobile]);

  const startResize = (e) => { e.preventDefault(); setDragging(true); };
  useEffect(() => {
    if (!dragging) return undefined;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => setPanelHeight((h) => clampPanel(h - ev.movementY));
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  const o = market ? oi[market.id] : null;
  const longOi = o ? Number(o.longUusdc) : 0;
  const shortOi = o ? Number(o.shortUusdc) : 0;
  const totalOi = (longOi + shortOi) / 1e6;
  // Funding rate per hour ≈ factor × skew. A live estimate off the displayed open interest (the engine
  // settles on entry-priced notional, so it can differ slightly). Sign: + when longs pay shorts
  // (long-heavy book), − when shorts pay longs; 0 with no open interest.
  const skewRatio = longOi + shortOi > 0 ? (longOi - shortOi) / (longOi + shortOi) : 0;
  const fundingPctH = Math.round((market?.fundingFactorBps ?? 0) * skewRatio) / 100;

  return (
    <div className="trading-center">
      <div className="card-header-bar">
        {!mobile && (
          <div className="card-header-left">
            <MarketThumb market={market} className="header-card-thumb" />
            <div className="card-header-meta">
              <div className="card-header-name">{market?.displayName ?? 'Select a market'}</div>
              <div className="card-header-set">{market ? (market.kind === 'index' ? 'GachaDex Index' : market.symbol) : ''}</div>
            </div>
          </div>
        )}

        <div className="card-header-stats">
          <div className="stat-block">
            <span className="stat-label">MARK</span>
            <span className="stat-value">{liveMark == null ? '—' : formatUsd(px(liveMark))}</span>
          </div>
          <div className="stat-block">
            <span className="stat-label">24H</span>
            <span className={`stat-value ${changeUp ? 'up' : 'down'}`}>{formatPct(change)}</span>
          </div>
          <div className="stat-block">
            <span className="stat-label">INDEX</span>
            <span className="stat-value">{liveIndex == null ? '—' : formatUsd(px(liveIndex))}</span>
          </div>
          <div className="stat-block">
            <span className="stat-label">OPEN INT.</span>
            <span className="stat-value">{formatUsd(totalOi, { compact: true })}</span>
          </div>
          <div className="stat-block">
            <span className="stat-label" title="Hourly funding: + longs pay shorts, − shorts pay longs">FUNDING/H</span>
            <span className={`stat-value ${fundingPctH > 0 ? 'down' : fundingPctH < 0 ? 'up' : ''}`}>
              {fundingPctH > 0 ? '+' : fundingPctH < 0 ? '−' : ''}{Math.abs(fundingPctH).toFixed(2)}%
            </span>
          </div>
        </div>
      </div>

      <div className="timeframe-bar">
        <div className="tf-group">
          {TIMEFRAMES.map((t) => (
            <button key={t} className={`tf-btn ${tf === t ? 'active' : ''}`} onClick={() => setTf(t)}>{t}</button>
          ))}
        </div>
        <div className="chart-tools">
          {CHART_TYPES.map((c) => (
            <button key={c.id} className={`tf-btn ${chartType === c.id ? 'active' : ''}`} onClick={() => setChartType(c.id)} title={`${c.label} chart`}>{c.label}</button>
          ))}
          <button className={`tf-btn ${maOn ? 'active' : ''}`} onClick={() => setMaOn((v) => !v)} title={`${MA_PERIOD}-period moving average`}>MA</button>
          <button className={`tf-btn ${volOn ? 'active' : ''}`} onClick={() => setVolOn((v) => !v)} title="Volume">VOL</button>
        </div>
        {market && market.status !== 'active' && <span className="market-halt-badge">{market.status.toUpperCase()}</span>}
      </div>

      <div className="chart-wrap">
        <div className="chart-container" ref={elRef} />
        {noData && <div className="chart-empty">No price history yet — it builds as prices update and the market trades.</div>}
      </div>

      {!mobile && (
        <>
          <div className="panel-resizer" onMouseDown={startResize} title="Drag to resize" />
          <BottomPanel market={market} height={panelHeight} onGoToMarket={onGoToMarket} />
        </>
      )}
    </div>
  );
}
