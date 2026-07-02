import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import * as api from '../../lib/api.js';
import { GachaInventory } from './GachaInventory.jsx';
import { useGachaReveal } from './useGachaReveal.jsx';
import { GoldBar } from './GoldBar.jsx';
import { RARITY_COLORS, usd, usdWhole, pollGachaOpen, hideBrokenImg } from './gacha-util.js';

// Classic Gacha (docs/classic-gacha-cc-packs-spec.md, P0–P4). Browses the live Collector Crypt machines (a
// game-filter, a machine strip, the selected machine's detail = price + tier legend + buyback %, the real
// top cards in its pool by value), rips a pack (pay USDC or loyalty Gold) and reveals
// the won card, and manages pulls in inventory: sell back, trade the matched GDEX market, or withdraw the NFT.

const goldPrice = (e6) => Math.floor(Number(e6 || 0) / 1000).toLocaleString(); // a pack's Gold price = USD×1000 = priceE6/1000
const tierColor = (label, i) => RARITY_COLORS[(label ?? '').toLowerCase()] ?? Object.values(RARITY_COLORS)[i] ?? '#ef4444';
// Nice labels for the game tabs; the set of tabs is derived from whatever machines the admin has enabled (the
// admin Machines toggle / disabledMachines knob is the SOLE visibility gate — the API already drops disabled ones).
const GAME_LABELS = { pokemon: 'Pokémon', onepiece: 'One Piece' };
// CC files some Pokémon-themed packs under their own game key; surface them under the Pokémon tab.
const GAME_REMAP = { water_100: 'pokemon' };
const gameOf = (m) => GAME_REMAP[m.code] ?? m.game;
// Price → quality badge (label + colour class). $25/$50 standard · $100 premium · $250 legendary · $1000+ grail.
const badgeOf = (priceE6) => {
  const p = Number(priceE6 || 0) / 1e6;
  if (p <= 50) return { label: 'Standard', cls: 'standard' };
  if (p <= 100) return { label: 'Premium', cls: 'premium' };
  if (p <= 250) return { label: 'Legendary', cls: 'legendary' };
  return { label: 'Grail', cls: 'grail' };
};
const PREVIEW_IMG = 'https://d1xpxki1g4htqu.cloudfront.net/_nIGwpul5IF9JxQ3La5uK3myeBL6fr6UBcA6s1ZX6V4'; // dev-preview fallback card art
const titleCase = (s) => (s ?? '').replace(/\b\w/g, (c) => c.toUpperCase());

export function ClassicGacha({ onTradeMarket, onGoldChanged }) {
  const [machines, setMachines] = useState([]);
  const [game, setGame] = useState('all');
  const [selected, setSelected] = useState(null); // selected machine code
  const [cards, setCards] = useState(null); // null = loading
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [ripping, setRipping] = useState(false);
  const [confirmMachine, setConfirmMachine] = useState(null); // machine pending the buy-confirm
  const [ripErr, setRipErr] = useState(null);
  const [ripPending, setRipPending] = useState(null); // buyback_pending: sell-back broadcast but unconfirmed — the reconciler settles it shortly (not an error)
  const [payWith, setPayWith] = useState('usdc');
  const [yolo, setYolo] = useState(false); // YOLO/turbo: auto-sell commons
  const [qty, setQty] = useState(1);
  const [instantCutBps, setInstantCutBps] = useState(1000); // GDEX cut on an instant sell-back (from /health); drives the net shown
  const [payWithGold, setPayWithGold] = useState(false); // gates the USDC/Gold pay choice on machines
  const [invVersion, setInvVersion] = useState(0); // bump → the <GachaInventory> panel reloads (after a pull/sell)

  // Shared open→route→reveal state machine — the SAME orchestration the loyalty free-pack claim will reuse
  // (common → ⚡ auto-sold panel, YOLO uncommon → summary, rare/epic → full reveal, then Keep/Sell/Trade).
  const gacha = useGachaReveal({
    instantCutBps,
    onTradeMarket,
    onError: setRipErr,
    onPending: setRipPending,
    onAfterChange: () => setInvVersion((v) => v + 1),
  });

  useEffect(() => {
    let alive = true;
    api.getCcMachines()
      .then((m) => {
        if (!alive) return;
        const list = m.machines ?? [];
        setMachines(list);
        setSelected((cur) => cur ?? list.slice().sort((a, b) => Number(a.priceE6) - Number(b.priceE6))[0]?.code ?? null);
        setLoading(false);
      })
      .catch((e) => { if (alive) { setErr(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setCards(null);
    api.getCcMachineCards(selected).then((r) => alive && setCards(r.cards ?? [])).catch(() => alive && setCards([]));
    return () => { alive = false; };
  }, [selected]);

  // Loyalty Gold: the balance/progress, and whether spending Gold is enabled (earn always accrues).
  useEffect(() => { api.getHealth().then((h) => { setPayWithGold(!!h.payWithGoldEnabled); if (h.gachaInstantCutBps != null) setInstantCutBps(Number(h.gachaInstantCutBps)); }).catch(() => {}); }, []);

  const requestRip = (m) => { setRipErr(null); setConfirmMachine(m); }; // → buy-confirm modal

  // Open one pack: charge, then poll until CC's reveal lands (the payment webhook can lag a few seconds).
  const openOne = async (m) => {
    const key = crypto.randomUUID();
    // The POST is the charge: a throw here is pre-payment (insufficient / sold-out / 401) → safe to surface as
    // "no charge". Never send 'gold' if pay-with-Gold is off. Past the charge we only poll the reveal.
    const r = await api.openGachaPack(m.code, key, m.priceE6, payWithGold ? payWith : 'usdc', yolo);
    return await pollGachaOpen(r);
  };

  // Confirmed: open `qty` packs. The overlay opens immediately charging (latency = suspense); a single pack
  // runs the beat reveal, multiple packs collect into a summary.
  const confirmRip = async () => {
    const m = confirmMachine;
    const n = qty;
    setConfirmMachine(null);
    if (!m) return;
    setRipErr(null);
    setRipping(true);
    gacha.startCharging(m.priceE6); // overlay opens charging (open+poll latency = suspense)
    try {
      const results = [];
      for (let i = 0; i < n; i++) results.push(await openOne(m)); // sequential = qty separate charges
      // Route by the canonical rules: common → ⚡ auto-sold, YOLO uncommon → summary, rare/epic → full reveal;
      // multi-open → summary (YOLO) or a reveal-each-then-summary queue (normal). Shared with the free-pack claim.
      gacha.route(results, { yolo });
    } catch (e) {
      gacha.close();
      setRipErr(e?.status === 401 ? 'Sign in to rip a pack.' : e.message);
    } finally {
      setRipping(false);
      onGoldChanged?.(); // earn (USDC) or spend (Gold) changed the balance → refresh the Games-page Gold vault
    }
  };

  // Dev-only: fire the reveal with a mock pull so the animation/sound can be tuned without a real (paid) open.
  // Borrows a real card image from the current pool when available. Gated by import.meta.env.DEV → never ships.
  const previewReveal = (rarity) => {
    const c = cards?.[0];
    const valueByTier = { common: '12000000', uncommon: '28000000', rare: '85000000', epic: '4475000000' };
    gacha.preview({
      spentE6: '50000000',
      result: { openId: 'preview', status: 'opened', verifyUrl: null, card: { mint: 'preview', name: c?.name ?? 'Charizard VMAX', grade: c?.grade ?? 'PSA 10', imageUrl: c?.imageUrl ?? PREVIEW_IMG, valueE6: valueByTier[rarity] ?? '12000000', rarity, marketId: null, year: '2000' } },
      previewSell: true, // mock: show the Sell-back button (no real held row behind a preview)
    });
  };
  const previewYolo = () => gacha.preview({ spentE6: '50000000', result: { openId: 'preview', status: 'turbo_sold', card: null, verifyUrl: null, turboRefundE6: '27000000' } });
  const previewMulti = () => {
    const c = cards?.[0];
    let n = 0;
    const mk = (rarity, value) => { const id = `p${n++}`; return { openId: id, status: 'opened', verifyUrl: null, turboRefundE6: null, card: { mint: id, name: c?.name ?? 'Card', grade: c?.grade ?? 'PSA 10', imageUrl: c?.imageUrl ?? PREVIEW_IMG, valueE6: value, rarity, marketId: null, year: '2000' } }; };
    // mock: let the summary's Sell buttons resolve so the sell-all / sell-some flow is demoable
    gacha.preview({ spentE6: '50000000', summaryResults: [mk('common', '12000000'), mk('rare', '85000000'), mk('epic', '4475000000'), { openId: 'pt', status: 'turbo_sold', card: null, verifyUrl: null, turboRefundE6: '27000000' }, mk('uncommon', '28000000')], previewSell: true });
  };
  const previewSequence = () => { // normal-mode multi-open: reveal each card in turn, then the summary
    const c = cards?.[0];
    let n = 0;
    const mk = (rarity, value) => { const id = `p${n++}`; return { openId: id, status: 'opened', verifyUrl: null, turboRefundE6: null, card: { mint: id, name: c?.name ?? 'Card', grade: c?.grade ?? 'PSA 10', imageUrl: c?.imageUrl ?? PREVIEW_IMG, valueE6: value, rarity, marketId: null, year: '2000' } }; };
    gacha.preview({ spentE6: '50000000', queue: [mk('common', '12000000'), mk('uncommon', '28000000'), mk('rare', '85000000'), mk('epic', '4475000000')], previewSell: true });
  };

  if (loading) return <div className="empty-state">Loading packs…</div>;
  if (err) return <div className="order-error">Couldn’t load packs: {err}</div>;
  if (machines.length === 0) return <div className="empty-state">No packs available right now.</div>;

  // The API already served only the admin-enabled (non-disabled) machines — that's the visibility gate.
  const gameKeys = ['all', ...new Set(machines.map(gameOf).filter(Boolean))]; // tabs derived from the visible machines
  const activeGame = gameKeys.includes(game) ? game : 'all'; // fall back to All if the operator hid every machine of the chosen tab
  const shown = (activeGame === 'all' ? machines : machines.filter((m) => gameOf(m) === activeGame)).slice().sort((a, b) => Number(a.priceE6) - Number(b.priceE6)); // ascending price
  const machine = machines.find((m) => m.code === selected) ?? shown[0] ?? machines[0];
  const topCards = cards ? [...cards].sort((a, b) => Number(b.valueE6) - Number(a.valueE6)).slice(0, 25) : null; // top 25 by value
  const totalE6 = String(Number(machine.priceE6 || 0) * qty);

  return (
    <div className="gacha g-classic-gacha">
      <div className="games-hero">
        <h2>Classic Gacha</h2>
        <p className="muted">Real graded-card packs from Collector Crypt — win a genuine slab, sell it back or keep it.</p>
      </div>

      {import.meta.env.DEV && (
        <div className="gacha-devbar">
          <span>⚡ Preview reveal (dev only):</span>
          <button onClick={() => previewReveal('common')}>Common</button>
          <button onClick={() => previewReveal('uncommon')}>Uncommon</button>
          <button onClick={() => previewReveal('rare')}>Rare</button>
          <button onClick={() => previewReveal('epic')}>Epic</button>
          <button onClick={previewYolo}>YOLO sold</button>
          <button onClick={previewMulti}>Multi ×5</button>
          <button onClick={previewSequence}>Seq ×4</button>
        </div>
      )}

      <div className="gacha-tabs">
        {gameKeys.map((key) => (
          <button key={key} className={`gacha-tab ${key === activeGame ? 'active' : ''}`} onClick={() => setGame(key)}>
            {key === 'all' ? 'All' : (GAME_LABELS[key] ?? titleCase(key))}
          </button>
        ))}
      </div>

      <div className="gacha-strip">
        {shown.map((m) => (
          <button key={m.code} className={`gacha-chip ${m.code === selected ? 'active' : ''}`} onClick={() => setSelected(m.code)}>
            {m.image ? <img src={m.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="gacha-chip-ph" aria-hidden="true">📦</span>}
            <span className="gacha-chip-name">{m.name}</span>
            <span className="gacha-chip-price">{usd(m.priceE6)}</span>
          </button>
        ))}
      </div>

      <div className="gacha-main">
        <aside className="gacha-machine">
          <div className="gacha-machine-art">
            {(() => { const b = badgeOf(machine.priceE6); return <span className={`gacha-machine-badge badge-${b.cls}`}>★ {b.label}</span>; })()}
            {machine.video ? (
              <video className="gacha-machine-media" autoPlay loop muted playsInline poster={machine.image ?? undefined} key={machine.code}>
                {machine.videoHevc && <source src={machine.videoHevc} type="video/mp4" />}
                <source src={machine.video} type="video/webm" />
              </video>
            ) : machine.image ? (
              <img className="gacha-machine-media" src={machine.image} alt={machine.name} referrerPolicy="no-referrer" />
            ) : <span className="gacha-machine-ph" aria-hidden="true">📦</span>}
          </div>
          <div className="gacha-machine-head">
            <div className="gacha-machine-title"><span className="gacha-eyebrow">Pack</span><h3>{machine.name}</h3></div>
            {Number(machine.evE6) > 0 && (
              <div className="gacha-machine-ev"><span className="gacha-eyebrow">Expected</span><strong className="up">{usd(machine.evE6)}</strong></div>
            )}
          </div>
          <div className="gacha-qty">
            <span className="gacha-eyebrow">Quantity</span>
            <div className="gacha-qty-stepper">
              <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} aria-label="Fewer packs">−</button>
              <span>{qty}</span>
              <button type="button" onClick={() => setQty((q) => Math.min(10, q + 1))} disabled={qty >= 10} aria-label="More packs">+</button>
            </div>
          </div>
          {payWithGold && (
            <div className="gacha-paywith" role="group" aria-label="Pay with">
              <button className={`gacha-pay ${payWith === 'usdc' ? 'active' : ''}`} onClick={() => setPayWith('usdc')}>USDC</button>
              <button className={`gacha-pay ${payWith === 'gold' ? 'active' : ''}`} onClick={() => setPayWith('gold')}><GoldBar size={15} /> Gold</button>
            </div>
          )}
          <button className="btn-primary gacha-open-btn" disabled={ripping} onClick={() => requestRip(machine)}>
            <span className="gacha-open-left">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
              {ripping ? 'Opening…' : 'Open Now'}
            </span>
            <span className="gacha-open-price">{payWith === 'gold' ? <>{goldPrice(totalE6)} <GoldBar size={13} /></> : usd(totalE6)}</span>
          </button>
          <button className={`gacha-yolo ${yolo ? 'on' : ''}`} type="button" aria-pressed={yolo} onClick={() => setYolo((v) => !v)}>
            <span className="gacha-yolo-label">⚡ YOLO Mode</span>
            <span className="gacha-toggle"><span className="gacha-toggle-knob" /></span>
          </button>
          <p className="gacha-yolo-note">Auto-sells commons for instant USDC — only reveals rares &amp; epics.</p>
          {ripErr && <div className="order-error" style={{ marginTop: '0.5rem' }}>{ripErr}</div>}
          {ripPending && <div className="order-pending" style={{ marginTop: '0.5rem' }}>{ripPending}</div>}
          <div className="gacha-machine-grid">
            <div><span className="gacha-eyebrow">Contains</span><strong>1 Card</strong></div>
            <div><span className="gacha-eyebrow">Buyback</span><strong className="up">{machine.buybackPct}%</strong></div>
          </div>
          {machine.tiers?.length > 0 && (
            <div className="gacha-odds">
              <p className="gacha-odds-title">Statistics</p>
              {machine.tiers.map((t) => (
                <div key={t.label} className="gacha-odds-row">
                  <span className="gacha-dot" style={{ background: tierColor(t.label) }} aria-hidden="true" />
                  <span className="gacha-odds-label">{titleCase(t.label)}</span>
                  <span className="gacha-odds-bar"><span style={{ width: `${Math.min(100, t.pct)}%`, background: tierColor(t.label) }} /></span>
                  <span className="gacha-odds-pct">{t.pct}%</span>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="gacha-cards">
          <h4>Top cards{topCards ? ` (${topCards.length})` : ''}</h4>
          {cards == null ? (
            <div className="empty-state">Loading cards…</div>
          ) : topCards.length === 0 ? (
            <div className="empty-state">No cards listed for this pack right now.</div>
          ) : (
            <div className="gacha-card-grid">
              {topCards.map((c) => (
                <div key={c.mint} className="gacha-card">
                  <img src={c.imageUrl} alt={c.name} loading="lazy" referrerPolicy="no-referrer" onError={hideBrokenImg} />
                  <span className="gacha-card-name" title={c.name}>{c.name}</span>
                  <div className="gacha-card-meta">
                    {c.grade && <span className="gacha-card-grade">{c.grade}</span>}
                    <span className="gacha-card-val"><span aria-hidden="true">🪙</span>{usdWhole(c.valueE6)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <GachaInventory heading="Your pulls" onTradeMarket={onTradeMarket} refreshKey={invVersion} />

      <p className="muted gacha-note">Real graded-card packs from Collector Crypt — bought with your GachaDex balance. Sell a pull back for USDC (GDEX keeps 5%) or keep it.</p>

      {confirmMachine && createPortal(
        <div className="gacha-modal-overlay" onClick={() => setConfirmMachine(null)}>
          <div className="gacha-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="gacha-confirm-art">{confirmMachine.image ? <img src={confirmMachine.image} alt="" referrerPolicy="no-referrer" onError={hideBrokenImg} /> : <span aria-hidden="true">📦</span>}</div>
            <h3>Open {qty > 1 ? `${qty} packs` : 'this pack'}?</h3>
            <p className="muted">{confirmMachine.name}{qty > 1 ? ` × ${qty}` : ''}{yolo ? ' · ⚡ YOLO' : ''}</p>
            <div className="gacha-confirm-total">
              <span>Total</span>
              <strong>{payWith === 'gold' ? <>{goldPrice(String(Number(confirmMachine.priceE6) * qty))} <GoldBar size={14} /> Gold</> : usd(String(Number(confirmMachine.priceE6) * qty))}</strong>
            </div>
            <p className="gacha-confirm-final">This action is final</p>
            <div className="gacha-modal-actions">
              <button className="btn-ghost" onClick={() => setConfirmMachine(null)}>Cancel</button>
              <button className="btn-primary" onClick={confirmRip}>Open</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {gacha.overlay}
    </div>
  );
}
