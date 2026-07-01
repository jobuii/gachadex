import { useState, useEffect } from 'react';
import * as api from '../../lib/api.js';
import { GachaReveal } from './GachaReveal.jsx';
import { GachaSummary } from './GachaSummary.jsx';

/**
 * Shared open→route→reveal orchestration for gacha packs — the SINGLE source of the reveal state machine so
 * every entry point (the Classic Gacha machines AND, later, the loyalty free-pack claim) behaves identically.
 * The caller owns the *open* (it picks the pay method / turbo), then hands the landed result(s) to `route`:
 *   • Common in YOLO/turbo → CC returns `turbo_sold` (no card) → GachaReveal's ⚡ auto-sold panel.
 *   • Uncommon in YOLO → straight to the SUMMARY (Keep/Sell), skipping the beat reveal.
 *   • Rare/Epic (and EVERYTHING in normal mode) → the full beat reveal, then Keep / Sell (/ Trade).
 *   • Multi-open: YOLO → straight to the summary; normal → reveal each in turn, then the summary.
 *
 * Callbacks (all optional): `onError`/`onPending` surface a sell-back's outcome to the host's UI; `onTradeMarket`
 * jumps to a card's perp market; `onAfterChange` fires whenever the held-inventory changed (e.g. to refresh an
 * inventory panel). Returns `overlay` (render it in the host tree) plus the actions the host drives.
 */
export function useGachaReveal({ instantCutBps = 1000, onTradeMarket, onError, onPending, onAfterChange } = {}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null); // single reveal result (null while charging)
  const [spentE6, setSpentE6] = useState('0'); // per-pack spend, for the reveal's P&L line
  const [summaryResults, setSummaryResults] = useState(null); // → GachaSummary
  const [queue, setQueue] = useState(null); // normal-mode multi-open: reveal each in turn
  const [queueIndex, setQueueIndex] = useState(0);
  const [previewSell, setPreviewSell] = useState(false); // dev: stub the summary's onSell so a mock shows "Sold ✓"
  const [previewSellable, setPreviewSellable] = useState(false); // dev: force the single-reveal Sell button on
  const [inventory, setInventory] = useState([]); // held rows — resolves the sellable prize behind a reveal

  // reload the held-inventory (for prize resolution) + notify the host (e.g. its separate inventory panel)
  const reload = () => { onAfterChange?.(); if (!api.hasSession()) return; api.getGachaInventory().then((r) => setInventory(r.inventory ?? [])).catch(() => {}); };
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => { setResult(null); setSummaryResults(null); setQueue(null); setQueueIndex(0); setPreviewSell(false); setPreviewSellable(false); };
  const close = () => { setOpen(false); reset(); };

  // Open the overlay in its charging state (the open+poll latency is the suspense).
  const startCharging = (spent) => { setSpentE6(String(spent)); reset(); setOpen(true); };

  // Route the landed result(s) to the correct UI. reload() first so the reveal's Sell-now can resolve the held row.
  const route = (results, { yolo = false } = {}) => {
    reload();
    if (results.length === 1) {
      const r = results[0];
      // YOLO Uncommon skips the beat reveal → straight to the summary (Keep/Sell). Common is auto-sold to its
      // own ⚡ panel (turbo_sold, no card); Rare/Epic still get the full reveal. Normal mode is unchanged.
      if (yolo && r.status === 'opened' && (r.card?.rarity || '').toLowerCase() === 'uncommon') setSummaryResults([r]);
      else setResult(r);
    } else if (yolo) {
      setSummaryResults(results); // YOLO multi → straight to the summary (no per-card reveals)
    } else {
      setQueueIndex(0); setQueue(results); // normal multi → reveal each in turn, then the summary
    }
  };

  // dev-only: drop the overlay straight into a given state (drives the ClassicGacha preview buttons)
  const preview = ({ spentE6: s = '0', result: r = null, summaryResults: sr = null, queue: q = null, previewSell: ps = false, previewSellable: psa = false }) => {
    setSpentE6(String(s)); setResult(r); setSummaryResults(sr); setQueue(q); setQueueIndex(0); setPreviewSell(ps); setPreviewSellable(psa); setOpen(true);
  };

  // multi-open sequence: advance to the next card; after the last (or Skip-all) hand off to the summary.
  const goToSummary = () => { setSummaryResults(queue); setQueue(null); setQueueIndex(0); };
  const advanceQueue = () => { if (!queue) return; const next = queueIndex + 1; if (next >= queue.length) goToSummary(); else setQueueIndex(next); };
  const skipAllToSummary = () => { if (queue) goToSummary(); };

  // instant sell-back of a held prize (−instant cut). Returns true | 'pending' (broadcast, reconciler settles) | false.
  const sellPrize = async (id) => {
    onError?.(null); onPending?.(null);
    try { await api.sellGachaPrize(id, true); reload(); return true; }
    catch (e) {
      if (e.code === 'buyback_pending') { onPending?.(e.message); reload(); return 'pending'; }
      onError?.(e.message); return false;
    }
  };
  const sellByMint = async (mint) => { const it = inventory.find((i) => i.mint === mint && i.status === 'held'); return it ? sellPrize(it.id) : false; };
  const trade = (card) => { if (onTradeMarket && card?.marketId) onTradeMarket({ id: card.marketId }); };

  const revealCard = result?.card ?? null;
  const revealItem = revealCard ? inventory.find((i) => i.mint === revealCard.mint) : null; // held row backing the reveal

  const overlay = open && (queue ? (
    <GachaReveal
      key={queueIndex}
      result={queue[queueIndex]}
      spentE6={spentE6}
      instantCutBps={instantCutBps}
      seqPos={{ pos: queueIndex + 1, total: queue.length }}
      onNext={advanceQueue}
      onSkipAll={skipAllToSummary}
      onClose={close}
    />
  ) : summaryResults ? (
    <GachaSummary results={summaryResults} spentE6={spentE6} instantCutBps={instantCutBps} onSell={previewSell ? async () => true : sellByMint} onClose={close} />
  ) : (
    <GachaReveal
      result={result}
      spentE6={spentE6}
      instantCutBps={instantCutBps}
      canSell={!!revealItem || previewSellable}
      canTrade={!!revealCard?.marketId}
      onSellNow={async () => {
        if (previewSellable) return true;
        if (revealItem) return await sellPrize(revealItem.id);
        return false;
      }}
      onTrade={() => { if (revealCard) trade(revealCard); close(); }}
      onClose={close}
    />
  ));

  return { overlay, isOpen: open, startCharging, route, preview, close };
}
