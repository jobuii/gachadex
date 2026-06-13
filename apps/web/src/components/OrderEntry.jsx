import { useState, useEffect, useCallback } from 'react';
import { liquidationPrice, fee, notional, formatUsd } from '@pokex/pricing';
import { useRealtime } from '../store/realtime';
import { useAuth } from '../auth/AuthContext';
import { FaucetButton } from './FaucetButton';
import { OpenPositions } from './OpenPositions';
import * as api from '../lib/api.js';

const OPEN_FEE_BPS = 10; // mirrors the server default (preview only; server is authoritative)

export function OrderEntry({ market, onTraded }) {
  const { user } = useAuth();
  const marks = useRealtime((s) => s.marks);
  const [side, setSide] = useState('long');
  const [marginUsd, setMarginUsd] = useState('');
  const [leverageInput, setLeverage] = useState(5);
  const [balance, setBalance] = useState(null);
  const [positions, setPositions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [details, setDetails] = useState(null);
  const [showGrades, setShowGrades] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (!market?.id) return;
    let alive = true;
    setDetails(null); // hide the prior market's panel during the new round-trip
    setShowGrades(false); // collapse so the prior market's ladder can't flash under the new card
    setModalOpen(false); // close the enlarged-image modal when switching markets
    api.getMarketDetails(market.id).then((d) => alive && setDetails(d)).catch(() => alive && setDetails(null));
    return () => {
      alive = false;
    };
  }, [market?.id]);

  const maxLev = market?.maxLeverage ?? 20;
  const leverage = Math.min(leverageInput, maxLev); // clamp during render (no setState-in-effect)

  const refresh = useCallback(() => {
    if (!user) {
      setBalance(null);
      setPositions([]);
      return;
    }
    api.getBalance().then(setBalance).catch(() => {});
    api.getPositions().then((r) => setPositions(r.positions)).catch(() => {});
  }, [user]);

  useEffect(() => {
    refresh();
    if (!user) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, user]);

  if (!market) {
    return (
      <div className="order-panel">
        <div className="card-placeholder">Select a market to trade</div>
      </div>
    );
  }

  const markE6 = marks[market.id]?.markE6 ?? market.markE6;
  const priceUsd = markE6 ? Number(markE6) / 1e6 : 0;
  const marginNum = Math.min(parseFloat(marginUsd) || 0, 1e15); // clamp absurd/exponential input
  const notionalUsd = marginNum * leverage;
  const qtyUnits = priceUsd > 0 ? notionalUsd / priceUsd : 0;
  const step = BigInt(market.qtyStepE6 ?? '10000');
  const minQty = BigInt(market.minQtyE6 ?? '10000');
  const qRaw = Math.round(qtyUnits * 1e6);
  let qtyE6 = Number.isFinite(qRaw) ? BigInt(qRaw) : 0n; // never BigInt(Infinity/NaN): that throws during render
  qtyE6 = (qtyE6 / step) * step; // snap to the market's step

  const liqE6 = markE6 && marginNum > 0
    ? liquidationPrice({ side, entryE6: BigInt(markE6), leverageE2: leverage * 100, maintMarginBps: market.maintMarginBps })
    : 0n;
  const feeUusdc = fee(notional(qtyE6, markE6 ? BigInt(markE6) : 0n), OPEN_FEE_BPS);
  const availableUsd = balance ? Number(balance.availableUusdc) / 1e6 : 0;
  const largeImg = details?.imageLarge || market.imageSmall; // big card art for the click-to-enlarge modal

  const canTrade = user && market.tradeable && market.status === 'active' && qtyE6 >= minQty && marginNum > 0;

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.openOrder({ marketId: market.id, side, qtyE6: qtyE6.toString(), leverage, idempotencyKey: crypto.randomUUID() });
      setMarginUsd('');
      refresh();
      onTraded?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="order-panel">
      <div
        className="card-preview"
        onClick={() => largeImg && setModalOpen(true)}
        style={{ cursor: largeImg ? 'zoom-in' : 'default' }}
        title={largeImg ? 'Click to enlarge' : undefined}
      >
        {market.imageSmall ? (
          <img src={market.imageSmall} alt={market.displayName} className="preview-img" />
        ) : (
          <div className="preview-index">📈<br />{market.displayName}</div>
        )}
        <div className="preview-label">{market.displayName}</div>
      </div>

      {modalOpen && largeImg && (
        <div className="modal" onClick={() => setModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <img src={largeImg} alt={market.displayName} className="modal-img" />
            <h3 className="modal-title">{market.displayName}</h3>
            <p className="modal-sub">{details?.metadata?.setName ? `Set: ${details.metadata.setName}` : market.symbol}</p>
            <p className="modal-sub val">
              Mark: {priceUsd ? formatUsd(priceUsd) : '—'}
              {details?.gradedPsa10E6 ? ` · PSA-10 ${formatUsd(BigInt(details.gradedPsa10E6))}` : ''}
            </p>
            <button className="btn-secondary sm" onClick={() => setModalOpen(false)}>Close</button>
          </div>
        </div>
      )}

      {details && (details.grades?.length > 0 || details.gradedPsa10E6 || details.metadata) && (
        <div className="details-panel">
          <div className="details-body">
            {details.metadata?.setName && (
              <div className="detail-row"><span>Set</span><strong>{details.metadata.setName}</strong></div>
            )}
            {details.variant && (
              <div className="detail-row"><span>Variant</span><strong>{details.variant}</strong></div>
            )}
            {details.metadata?.rarity && (
              <div className="detail-row"><span>Rarity</span><strong>{details.metadata.rarity}</strong></div>
            )}
            {details.releaseYear && (
              <div className="detail-row"><span>Release Year</span><strong>{details.releaseYear}</strong></div>
            )}
            {(details.grades?.length > 0 || details.gradedPsa10E6) && (
              <>
                <button className="grades-toggle" onClick={() => setShowGrades((v) => !v)}>
                  {showGrades ? 'Hide graded prices' : 'Show graded prices'}
                </button>
                {showGrades &&
                  (details.grades?.length > 0 ? (
                    <>
                      <div className="detail-section">Graded (eBay 7d avg)</div>
                      {details.grades.map((g) => (
                        <div className="detail-row" key={`${g.grader}-${g.grade}`}>
                          <span>{g.grader} {g.grade}</span>
                          <strong className="up">{formatUsd(BigInt(g.priceE6))}</strong>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="detail-row">
                      <span>PSA-10</span>
                      <strong className="up">{formatUsd(BigInt(details.gradedPsa10E6))}</strong>
                    </div>
                  ))}
              </>
            )}
          </div>
        </div>
      )}

      <div className="order-form">
        {!market.tradeable && <div className="order-gated">Data source pending — not yet tradeable.</div>}

        <div className="order-side-toggle">
          <button className={`side-btn buy ${side === 'long' ? 'active' : ''}`} onClick={() => setSide('long')}>LONG</button>
          <button className={`side-btn sell ${side === 'short' ? 'active' : ''}`} onClick={() => setSide('short')}>SHORT</button>
        </div>

        <div className="form-field">
          <label className="field-label">
            <span>SIZE (USDC)</span>
            <span className="field-hint">Avail: ${availableUsd.toFixed(2)}</span>
          </label>
          <div className="field-input-wrap">
            <input type="number" min="0" placeholder="0" value={marginUsd} onChange={(e) => setMarginUsd(e.target.value)} />
            <span className="field-unit">USDC</span>
          </div>
        </div>

        <div className="form-field">
          <label className="field-label">
            <span>LEVERAGE</span>
            <span className="field-hint">{leverage}x (max {maxLev}x)</span>
          </label>
          <input className="leverage-slider" type="range" min="1" max={maxLev} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
        </div>

        <div className="order-info-box">
          <div className="order-info-row"><span>Mark</span><span>{priceUsd ? formatUsd(priceUsd) : '—'}</span></div>
          <div className="order-info-row"><span>Position size</span><span>{(Number(qtyE6) / 1e6).toFixed(2)} @ {formatUsd(notionalUsd)}</span></div>
          <div className="order-info-row"><span>Liq. price</span><span className="down">{liqE6 ? formatUsd(BigInt(liqE6)) : '—'}</span></div>
          <div className="order-info-row"><span>Est. fee</span><span>{formatUsd(BigInt(feeUusdc))}</span></div>
        </div>

        {err && <div className="order-error">{err}</div>}

        {!user ? (
          <div className="order-signin-hint">Connect &amp; sign in to trade.</div>
        ) : (
          <div className="order-actions">
            <FaucetButton onFunded={refresh} />
            <button className={`place-order-btn ${side === 'long' ? 'buy' : 'sell'}`} disabled={!canTrade || busy} onClick={submit}>
              {busy ? '…' : `${side === 'long' ? 'LONG' : 'SHORT'} ${market.displayName.slice(0, 16)}`}
            </button>
          </div>
        )}

        <div className="order-positions">
          <div className="order-positions-title">Open Positions</div>
          <OpenPositions compact positions={positions} onChanged={() => { refresh(); onTraded?.(); }} />
        </div>
      </div>
    </div>
  );
}
