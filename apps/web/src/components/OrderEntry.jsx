import { useState, useEffect, useCallback } from 'react';
import { liquidationPrice, fee, notional, formatUsd, MIN_NOTIONAL_UUSDC } from '@pokex/pricing';
import { useRealtime } from '../store/realtime';
import { useAuth } from '../auth/AuthContext';
import { FaucetButton } from './FaucetButton';
import { OpenPositions } from './OpenPositions';
import { thumbSrc } from '../lib/thumb.js';
import { useRestingOrders, usdToE6 } from '../lib/useRestingOrders.js';
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
  const [orderType, setOrderType] = useState('market'); // 'market' | 'limit' (limit gated on restingEnabled)
  const [limitPriceUsd, setLimitPriceUsd] = useState('');
  const { orders: restingOrders, enabled: restingEnabled, refresh: refreshResting } = useRestingOrders(user);

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
  const step = BigInt(market.qtyStepE6 ?? '100');
  const minQty = BigInt(market.minQtyE6 ?? '100');
  const qRaw = Math.round(qtyUnits * 1e6);
  let qtyE6 = Number.isFinite(qRaw) ? BigInt(qRaw) : 0n; // never BigInt(Infinity/NaN): that throws during render
  qtyE6 = (qtyE6 / step) * step; // snap to the market's step

  const liqE6 = markE6 && marginNum > 0
    ? liquidationPrice({ side, entryE6: BigInt(markE6), leverageE2: leverage * 100, maintMarginBps: market.maintMarginBps })
    : 0n;
  const orderNotionalE6 = markE6 ? notional(qtyE6, BigInt(markE6)) : 0n;
  const feeUusdc = fee(orderNotionalE6, OPEN_FEE_BPS);
  const availableUsd = balance ? Number(balance.availableUusdc) / 1e6 : 0;
  const previewSrc = thumbSrc(market); // index → /index-cards/<slug>.png; a card → its own image
  const largeImg = details?.imageLarge || previewSrc; // big card art for the click-to-enlarge modal
  const belowMin = marginNum > 0 && orderNotionalE6 < MIN_NOTIONAL_UUSDC; // order too small (sub-$1 notional)

  const isLimit = restingEnabled && orderType === 'limit';
  const canTrade =
    user && market.tradeable && market.status === 'active' && qtyE6 >= minQty && marginNum > 0 && !belowMin && (!isLimit || usdToE6(limitPriceUsd) != null);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (isLimit) {
        await api.placeRestingOrder({
          marketId: market.id, kind: 'limit', side, qtyE6: qtyE6.toString(), leverage,
          triggerPriceE6: usdToE6(limitPriceUsd), reduceOnly: false, idempotencyKey: crypto.randomUUID(),
        });
      } else {
        await api.openOrder({ marketId: market.id, side, qtyE6: qtyE6.toString(), leverage, idempotencyKey: crypto.randomUUID() });
      }
      setMarginUsd('');
      setLimitPriceUsd('');
      refresh();
      refreshResting();
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
        {previewSrc ? (
          <img src={previewSrc} alt={market.displayName} className="preview-img" />
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
        {market.markStabilizing && (
          <div className="order-gated" title="An uncorroborated price jump is being smoothed over a few updates so a bad print can't trigger a liquidation. The price shown is the one that settles trades.">
            Price stabilizing — recent move is being smoothed.
          </div>
        )}

        {restingEnabled && (
          <div className="order-type-toggle">
            <button type="button" className={`otype-btn ${orderType === 'market' ? 'active' : ''}`} onClick={() => setOrderType('market')}>MARKET</button>
            <button type="button" className={`otype-btn ${orderType === 'limit' ? 'active' : ''}`} onClick={() => setOrderType('limit')}>LIMIT</button>
          </div>
        )}

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

        {isLimit && (
          <div className="form-field">
            <label className="field-label">
              <span>LIMIT PRICE (USD)</span>
              <span className="field-hint">fills at the mark when it reaches this</span>
            </label>
            <div className="field-input-wrap">
              <input type="number" min="0" placeholder={priceUsd ? priceUsd.toFixed(2) : '0'} value={limitPriceUsd} onChange={(e) => setLimitPriceUsd(e.target.value)} />
              <span className="field-unit">USD</span>
            </div>
          </div>
        )}

        <div className="order-info-box">
          <div className="order-info-row"><span>Mark</span><span>{priceUsd ? formatUsd(priceUsd) : '—'}</span></div>
          <div className="order-info-row"><span>Position size</span><span>{(Number(qtyE6) / 1e6).toFixed(2)} @ {formatUsd(notionalUsd)}</span></div>
          <div className="order-info-row"><span>Liq. price</span><span className="down">{liqE6 ? formatUsd(BigInt(liqE6)) : '—'}</span></div>
          <div className="order-info-row"><span>Est. fee</span><span>{formatUsd(BigInt(feeUusdc))}</span></div>
        </div>

        {belowMin && <div className="order-gated">Minimum order is $1 (notional).</div>}
        {err && <div className="order-error">{err}</div>}

        {!user ? (
          <div className="order-signin-hint">Connect &amp; sign in to trade.</div>
        ) : (
          <div className="order-actions">
            <FaucetButton onFunded={refresh} />
            <button className={`place-order-btn ${side === 'long' ? 'buy' : 'sell'}`} disabled={!canTrade || busy} onClick={submit}>
              {busy ? '…' : isLimit ? `PLACE ${side === 'long' ? 'LONG' : 'SHORT'} LIMIT` : `${side === 'long' ? 'LONG' : 'SHORT'} ${market.displayName.slice(0, 16)}`}
            </button>
          </div>
        )}

        <div className="order-positions">
          <div className="order-positions-title">Open Positions</div>
          <OpenPositions
            compact
            positions={positions}
            onChanged={() => { refresh(); onTraded?.(); }}
            restingOrders={restingOrders}
            restingEnabled={restingEnabled}
            onBracketChanged={refreshResting}
          />
        </div>

        {restingEnabled && restingOrders.length > 0 && (
          <div className="order-positions">
            <div className="order-positions-title">Open Orders</div>
            <RestingOrdersList orders={restingOrders} onCancelled={refreshResting} />
          </div>
        )}
      </div>
    </div>
  );
}

// The active resting orders (limit / SL / TP) for the selected market's owner — type · side · trigger · qty,
// with a cancel. Polled by useRestingOrders; only shown when the feature flag is on.
function RestingOrdersList({ orders, onCancelled }) {
  const [busy, setBusy] = useState(null);
  const cancel = async (id) => {
    setBusy(id);
    try {
      await api.cancelRestingOrder(id);
      onCancelled?.();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  };
  const label = (k) => (k === 'limit' ? 'Limit' : k === 'stop_loss' ? 'Stop-loss' : 'Take-profit');
  return (
    <table className="positions-table resting-table">
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td className={o.kind === 'limit' ? '' : 'muted'}>{label(o.kind)}</td>
            <td className={o.side === 'long' ? 'up' : 'down'}>{(o.side ?? '').toUpperCase()}</td>
            <td>@ {formatUsd(BigInt(o.triggerPriceE6))}</td>
            <td>{o.qtyE6 ? (Number(o.qtyE6) / 1e6).toFixed(2) : 'full'}</td>
            <td>
              <button className="btn-ghost sm" disabled={busy === o.id} onClick={() => cancel(o.id)}>
                {busy === o.id ? '…' : 'Cancel'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
