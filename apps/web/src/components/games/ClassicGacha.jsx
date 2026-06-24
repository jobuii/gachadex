import { useState, useEffect } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useWallet } from '@solana/wallet-adapter-react';
import * as api from '../../lib/api.js';
import { signAndSubmitNftWithdrawal } from '../../lib/withdraw.js';
import { GachaReveal } from './GachaReveal.jsx';

// Classic Gacha (docs/classic-gacha-cc-packs-spec.md, P0–P4). Browses the live Collector Crypt machines (a
// game-filter, a machine strip, the selected machine's detail = price + tier legend + buyback %, the real
// top cards in its pool by value), rips a pack (pay USDC or loyalty Tokens) and reveals
// the won card, and manages pulls in inventory: sell back, trade the matched GDEX market, or withdraw the NFT.

const usd = (e6) => formatUsd(BigInt(e6 || 0)); // `|| 0` guards '', null, undefined (e6 is always an integer string)
const tokenPrice = (e6) => Math.floor(Number(e6 || 0) / 1000).toLocaleString(); // a pack's Token price = USD×1000 = priceE6/1000
const fmtTokens = (n) => Number(n || 0).toLocaleString();
const TIER_COLOR = { common: '#ef4444', uncommon: '#22c55e', rare: '#a855f7', epic: '#f59e0b' }; // red · green · violet · gold
const tierColor = (label, i) => TIER_COLOR[(label ?? '').toLowerCase()] ?? ['#ef4444', '#22c55e', '#a855f7', '#f59e0b'][i] ?? '#ef4444';
const GAMES = [['all', 'All'], ['pokemon', 'Pokémon'], ['onepiece', 'One Piece'], ['mtg', 'MTG']];
const ALLOWED_GAMES = new Set(['pokemon', 'onepiece', 'mtg']);
const HIDDEN_MACHINES = new Set(['pokemon_2500', 'pokemon_5000', 'pokemon_151']); // hidden per operator
const titleCase = (s) => (s ?? '').replace(/\b\w/g, (c) => c.toUpperCase());
const hideBrokenImg = (e) => { e.currentTarget.style.visibility = 'hidden'; }; // CC image 404 → hide, keep the card

export function ClassicGacha({ onTradeMarket }) {
  const [machines, setMachines] = useState([]);
  const [game, setGame] = useState('all');
  const [selected, setSelected] = useState(null); // selected machine code
  const [cards, setCards] = useState(null); // null = loading
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [ripping, setRipping] = useState(false);
  const [confirmMachine, setConfirmMachine] = useState(null); // machine pending the buy-confirm
  const [revealOpen, setRevealOpen] = useState(false); // the reveal overlay (charging → beats → payoff)
  const [revealResult, setRevealResult] = useState(null); // the open result once it lands (null = still charging)
  const [revealSpentE6, setRevealSpentE6] = useState('0');
  const [ripErr, setRipErr] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [payWith, setPayWith] = useState('usdc');
  const [tokens, setTokens] = useState(null); // { balance, untilFreePackTokens }
  const [tokensEnabled, setTokensEnabled] = useState(false);
  const { signMessage } = useWallet();

  useEffect(() => {
    let alive = true;
    api.getCcMachines()
      .then((m) => {
        if (!alive) return;
        const list = m.machines ?? [];
        setMachines(list);
        setSelected((cur) => cur ?? list.find((x) => ALLOWED_GAMES.has(x.game) && !HIDDEN_MACHINES.has(x.code))?.code ?? null);
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

  const loadInventory = () => { if (!api.hasSession()) return; api.getGachaInventory().then((r) => setInventory(r.inventory ?? [])).catch(() => {}); };
  useEffect(() => { loadInventory(); }, []);
  // Loyalty Tokens: the balance/progress, and whether spending Tokens is enabled (earn always accrues).
  const loadTokens = () => { if (!api.hasSession()) return; api.getTokenBalance().then(setTokens).catch(() => {}); };
  useEffect(() => { loadTokens(); api.getHealth().then((h) => setTokensEnabled(!!h.tokensEnabled)).catch(() => {}); }, []);

  const requestRip = (m) => { setRipErr(null); setConfirmMachine(m); }; // → buy-confirm modal

  // Confirmed: charge + open, then poll for CC's reveal. The overlay opens immediately in its charging state
  // (the poll latency IS the suspense), then receives the result and runs the beat sequence + payoff.
  const confirmRip = async () => {
    const m = confirmMachine;
    setConfirmMachine(null);
    if (!m) return;
    setRipErr(null);
    setRipping(true);
    try {
      const key = crypto.randomUUID();
      let r = await api.openGachaPack(m.code, key, m.priceE6, payWith);
      setRevealSpentE6(m.priceE6); setRevealResult(null); setRevealOpen(true); // charging
      for (let i = 0; i < 12 && r.status === 'paid'; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        r = await api.getGachaOpen(r.openId);
      }
      await loadInventory(); // so the reveal's Sell-now can resolve the held row
      setRevealResult(r); // → the overlay runs the beats (card payoff, or 'failed' if no card)
    } catch (e) {
      setRevealOpen(false);
      setRipErr(e?.status === 401 ? 'Sign in to rip a pack.' : e.message);
    } finally {
      setRipping(false);
      loadTokens(); // earn (USDC) or spend (Tokens) changed the balance
    }
  };

  const closeReveal = () => { setRevealOpen(false); setRevealResult(null); };

  // Dev-only: fire the reveal with a mock pull so the animation/sound can be tuned without a real (paid) open.
  // Borrows a real card image from the current pool when available. Gated by import.meta.env.DEV → never ships.
  const previewReveal = (rarity) => {
    const c = cards?.[0];
    const valueByTier = { common: '12000000', uncommon: '28000000', rare: '85000000', epic: '4475000000' };
    setRevealSpentE6('50000000');
    setRevealResult({
      openId: 'preview', status: 'opened', verifyUrl: null,
      card: { mint: 'preview', name: c?.name ?? 'Charizard VMAX', grade: c?.grade ?? 'PSA 10', imageUrl: c?.imageUrl ?? null, valueE6: valueByTier[rarity] ?? '12000000', rarity, marketId: null, year: '2000' },
    });
    setRevealOpen(true);
  };

  const sellBack = async (item, instant = false) => {
    setRipErr(null);
    try {
      await api.sellGachaPrize(item.id, instant);
      loadInventory();
    } catch (e) {
      setRipErr(e.message);
    }
  };

  // Trade tie-in: jump to the card's GDEX perp market (only shown when the won card matched one).
  const trade = (item) => { if (onTradeMarket && item?.marketId) onTradeMarket({ id: item.marketId }); };

  // Withdraw the real graded-card NFT to the user's own wallet: a fresh wallet signature over (mint, dest).
  const withdraw = async (item) => {
    setRipErr(null);
    if (!signMessage) { setRipErr('Connect a wallet that can sign messages to withdraw.'); return; }
    const dest = window.prompt('Withdraw this card NFT to which Solana wallet address?');
    if (!dest) return;
    try {
      await signAndSubmitNftWithdrawal({ prizeId: item.id, dest: dest.trim(), signMessage });
      loadInventory();
    } catch (e) {
      setRipErr(e?.status === 401 ? 'Sign in to withdraw.' : e.message);
    }
  };

  if (loading) return <div className="empty-state">Loading packs…</div>;
  if (err) return <div className="order-error">Couldn’t load packs: {err}</div>;
  if (machines.length === 0) return <div className="empty-state">No packs available right now.</div>;

  const base = machines.filter((m) => ALLOWED_GAMES.has(m.game) && !HIDDEN_MACHINES.has(m.code)); // Pokémon / One Piece / MTG, minus hidden
  const shown = game === 'all' ? base : base.filter((m) => m.game === game);
  const machine = machines.find((m) => m.code === selected) ?? shown[0] ?? base[0] ?? machines[0];
  const topCards = cards ? [...cards].sort((a, b) => Number(b.valueE6) - Number(a.valueE6)).slice(0, 25) : null; // top 25 by value
  const revealCard = revealResult?.card ?? null;
  const revealItem = revealCard ? inventory.find((i) => i.mint === revealCard.mint) : null; // held row backing the reveal

  return (
    <div className="gacha g-classic-gacha">
      <div className="games-hero">
        <h2>Classic Gacha</h2>
        <p className="muted">Real graded-card packs from Collector Crypt — win a genuine slab, sell it back or keep it.</p>
        {tokens && (
          <div className="gacha-token-bal" title="Loyalty Tokens — earned on every USDC open">
            <span className="gacha-coin" aria-hidden="true">🪙</span>
            <strong>{fmtTokens(tokens.balance)}</strong>&nbsp;Tokens
            {Number(tokens.untilFreePackTokens) > 0 && <span className="gacha-token-until">· {fmtTokens(tokens.untilFreePackTokens)} to your next free $25 pack</span>}
          </div>
        )}
      </div>

      {import.meta.env.DEV && (
        <div className="gacha-devbar">
          <span>⚡ Preview reveal (dev only):</span>
          <button onClick={() => previewReveal('common')}>Common</button>
          <button onClick={() => previewReveal('uncommon')}>Uncommon</button>
          <button onClick={() => previewReveal('rare')}>Rare</button>
          <button onClick={() => previewReveal('epic')}>Epic</button>
        </div>
      )}

      <div className="gacha-tabs">
        {GAMES.map(([key, label]) => (
          <button key={key} className={`gacha-tab ${key === game ? 'active' : ''}`} onClick={() => setGame(key)}>
            {label}
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
            <span className="gacha-machine-badge">★ Standard</span>
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
          {tokensEnabled && (
            <div className="gacha-paywith" role="group" aria-label="Pay with">
              <button className={`gacha-pay ${payWith === 'usdc' ? 'active' : ''}`} onClick={() => setPayWith('usdc')}>USDC</button>
              <button className={`gacha-pay ${payWith === 'tokens' ? 'active' : ''}`} onClick={() => setPayWith('tokens')}>🪙 Tokens</button>
            </div>
          )}
          <button className="btn-primary gacha-open-btn" disabled={ripping} onClick={() => requestRip(machine)}>
            {ripping ? 'Opening…' : payWith === 'tokens' ? `Open — ${tokenPrice(machine.priceE6)} 🪙` : `Open — ${usd(machine.priceE6)}`}
          </button>
          {ripErr && <div className="order-error" style={{ marginTop: '0.5rem' }}>{ripErr}</div>}
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
                    <span className="gacha-card-val"><span aria-hidden="true">🪙</span> {usd(c.valueE6)}</span>
                    {c.grade && <span className="gacha-card-grade">{c.grade}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {inventory.length > 0 && (
        <section className="gacha-inventory">
          <h4>Your pulls ({inventory.length})</h4>
          <div className="gacha-card-grid">
            {inventory.map((it) => (
              <div key={it.id} className="gacha-card">
                {it.imageUrl && <img src={it.imageUrl} alt={it.name ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={hideBrokenImg} />}
                <span className="gacha-card-name" title={it.name ?? ''}>{it.name ?? 'card'}{it.grade ? ` · ${it.grade}` : ''}</span>
                <span className="gacha-card-val">{usd(it.valueE6)}</span>
                {it.status === 'held' ? (
                  <>
                    <button className="btn-ghost sm" onClick={() => sellBack(it)}>Sell back</button>
                    {it.marketId && <button className="btn-ghost sm" onClick={() => trade(it)}>Trade</button>}
                    <button className="btn-ghost sm" onClick={() => withdraw(it)}>Withdraw</button>
                  </>
                ) : (
                  <span className="muted" style={{ fontSize: '0.72rem' }}>Withdrawal in progress…</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="muted gacha-note">Real graded-card packs from Collector Crypt — bought with your GachaDex balance. Sell a pull back for USDC (GDEX keeps 5%) or keep it.</p>

      {confirmMachine && (
        <div className="gacha-modal-overlay" onClick={() => setConfirmMachine(null)}>
          <div className="gacha-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="gacha-confirm-art">{confirmMachine.image ? <img src={confirmMachine.image} alt="" onError={hideBrokenImg} /> : <span aria-hidden="true">📦</span>}</div>
            <h3>Open this pack?</h3>
            <p className="muted">{confirmMachine.name}</p>
            <div className="gacha-confirm-total">
              <span>Total</span>
              <strong>{payWith === 'tokens' ? `${tokenPrice(confirmMachine.priceE6)} 🪙 Tokens` : usd(confirmMachine.priceE6)}</strong>
            </div>
            <p className="gacha-confirm-final">This action is final</p>
            <div className="gacha-modal-actions">
              <button className="btn-ghost" onClick={() => setConfirmMachine(null)}>Cancel</button>
              <button className="btn-primary" onClick={confirmRip}>Open</button>
            </div>
          </div>
        </div>
      )}

      {revealOpen && (
        <GachaReveal
          result={revealResult}
          spentE6={revealSpentE6}
          canSell={!!revealItem}
          canTrade={!!revealCard?.marketId}
          onSellNow={async () => { if (revealItem) await sellBack(revealItem, true); closeReveal(); }}
          onTrade={() => { if (revealCard) trade(revealCard); closeReveal(); }}
          onClose={closeReveal}
        />
      )}
    </div>
  );
}
