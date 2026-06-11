import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, AreaSeries } from 'lightweight-charts';
import { formatUsd, formatPct } from '@pokex/pricing';
import { useRealtime } from '../store/realtime';
import { BottomPanel } from './BottomPanel';
import { MarketThumb } from './MarketThumb';
import * as api from '../lib/api.js';

const TIMEFRAMES = ['1D', '1W', '1M', '3M', '1Y'];
const px = (e6) => (e6 == null ? 0 : Number(e6) / 1_000_000);

// Floor "now" to the current timeframe's bucket (hourly for 1D/1W, daily for 1M+), as UTC unix
// seconds — must match the backend bucketing so the live point lands on/after the last candle.
const bucketTime = (tf) => {
  const sec = Math.floor(Date.now() / 1000);
  const size = tf === '1D' || tf === '1W' ? 3600 : 86400;
  return sec - (sec % size);
};

// Bound the bottom panel so both it and the chart stay usable.
const PANEL_MIN = 120; // keep the tabs + a row of content visible
const CHART_MIN = 150; // never starve the chart below this
const CHART_CHROME = 190; // fixed height above the panel: navbar + card header + timeframe bar + resizer
const clampPanel = (h) => Math.min(Math.max(h, PANEL_MIN), Math.max(PANEL_MIN + 100, window.innerHeight - CHART_CHROME - CHART_MIN));

// `mobile` renders chart-only: the page owns the BottomPanel (placed after the order form in the
// single-column flow) and there's no draggable splitter — the layout scrolls instead.
export function TradingView({ market, mobile = false }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [tf, setTf] = useState('1M');
  const [noData, setNoData] = useState(false);
  // splitter state is desktop-only; on mobile the panel isn't rendered here at all
  const [panelHeight, setPanelHeight] = useState(() => (mobile ? 0 : clampPanel(Number(localStorage.getItem('gachadex_panel_h')) || 210)));
  const [dragging, setDragging] = useState(false);

  const marks = useRealtime((s) => s.marks);
  const oi = useRealtime((s) => s.oi);
  const watch = useRealtime((s) => s.watch);
  const unwatch = useRealtime((s) => s.unwatch);

  const liveMark = market ? marks[market.id]?.markE6 ?? market.markE6 : null;
  const liveIndex = market ? marks[market.id]?.indexE6 ?? market.indexE6 : null;
  const change = market?.change24hPct ?? 0;
  const changeUp = change >= 0;

  // init chart once
  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#111418' }, textColor: '#8b949e', fontFamily: "'Press Start 2P', monospace", fontSize: 9 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: '#30363d' },
      timeScale: { borderColor: '#30363d', timeVisible: true },
      crosshair: { mode: 1 },
      width: elRef.current.clientWidth,
      height: elRef.current.clientHeight,
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#f0c040',
      topColor: 'rgba(240,192,64,0.25)',
      bottomColor: 'rgba(240,192,64,0.0)',
      lineWidth: 2,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    // Track the CONTAINER's size, not just the window — otherwise the canvas keeps its initial
    // height when the layout changes (e.g. the bottom panel resizing) and overflows over it.
    const fit = () => elRef.current && chart.applyOptions({ width: elRef.current.clientWidth, height: elRef.current.clientHeight });
    const ro = new ResizeObserver(fit);
    ro.observe(elRef.current);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
      chart.remove();
    };
  }, []);

  // subscribe to the selected market's live channels
  useEffect(() => {
    if (!market) return;
    watch(market.id);
    return () => unwatch(market.id);
  }, [market?.id, watch, unwatch]);

  // load candle history on market / timeframe change
  useEffect(() => {
    if (!market || !seriesRef.current) return;
    let alive = true;
    api
      .getCandles(market.id, tf)
      .then(({ candles }) => {
        if (!alive || !seriesRef.current) return;
        seriesRef.current.setData(candles.map((c) => ({ time: c.time, value: c.value })));
        chartRef.current?.timeScale().fitContent();
        setNoData(candles.length === 0); // real-data only; show an empty state when there's no history
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [market?.id, tf]);

  // live-update the latest point from the mark feed (bucket must match the active timeframe)
  useEffect(() => {
    if (!market || !seriesRef.current || !liveMark) return;
    try {
      seriesRef.current.update({ time: bucketTime(tf), value: px(liveMark) });
      setNoData(false); // a live point means there's something to show
    } catch {
      /* out-of-order time during history load */
    }
  }, [liveMark, market?.id, tf]);

  // persist the panel height + re-clamp it if the window shrinks (desktop-only machinery)
  useEffect(() => {
    if (!mobile) localStorage.setItem('gachadex_panel_h', String(panelHeight));
  }, [panelHeight, mobile]);
  useEffect(() => {
    if (mobile) return undefined;
    const onResize = () => setPanelHeight((h) => clampPanel(h));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mobile]);

  // drag the splitter: dragging up grows the panel and shrinks the chart (which refits via its
  // ResizeObserver). The listeners live in an effect so they're torn down even if we unmount mid-drag.
  const startResize = (e) => {
    e.preventDefault();
    setDragging(true);
  };
  useEffect(() => {
    if (!dragging) return undefined;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => setPanelHeight((h) => clampPanel(h - ev.movementY)); // moving up grows the panel
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
  const totalOi = o ? (Number(o.longUusdc) + Number(o.shortUusdc)) / 1e6 : 0;

  // NOTE: the chart container must always be mounted so the init effect (run once) can
  // attach the chart; we guard a null market inline rather than early-returning.
  return (
    <div className="trading-center">
      <div className="card-header-bar">
        {/* on mobile the market bar above already names the market */}
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
        </div>
      </div>

      <div className="timeframe-bar">
        {TIMEFRAMES.map((t) => (
          <button key={t} className={`tf-btn ${tf === t ? 'active' : ''}`} onClick={() => setTf(t)}>
            {t}
          </button>
        ))}
        {market && market.status !== 'active' && <span className="market-halt-badge">{market.status.toUpperCase()}</span>}
      </div>

      <div className="chart-wrap">
        <div className="chart-container" ref={elRef} />
        {noData && <div className="chart-empty">No price history yet — it builds as prices update and the market trades.</div>}
      </div>

      {!mobile && (
        <>
          <div className="panel-resizer" onMouseDown={startResize} title="Drag to resize" />
          <BottomPanel market={market} height={panelHeight} />
        </>
      )}
    </div>
  );
}
