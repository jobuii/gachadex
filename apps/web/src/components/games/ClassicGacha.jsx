import { useState, useEffect } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useWallet } from '@solana/wallet-adapter-react';
import * as api from '../../lib/api.js';
import { signAndSubmitNftWithdrawal } from '../../lib/withdraw.js';

// Classic Gacha (docs/classic-gacha-cc-packs-spec.md, P0–P4). Browses the live Collector Crypt machines (a
// game-filter, a machine strip, the selected machine's detail = price + tier legend + buyback %, the real
// graded cards in its pool, a recent-winners ticker), rips a pack (pay USDC or loyalty Tokens) and reveals
// the won card, and manages pulls in inventory: sell back, trade the matched GDEX market, or withdraw the NFT.

const usd = (e6) => formatUsd(BigInt(e6 || 0)); // `|| 0` guards '', null, undefined (e6 is always an integer string)
const tokenPrice = (e6) => Math.floor(Number(e6 || 0) / 1000).toLocaleString(); // a pack's Token price = USD×1000 = priceE6/1000
const fmtTokens = (n) => Number(n || 0).toLocaleString();
const TIER_COLOR = { common: '#eab308', uncommon: '#22c55e', rare: '#3b82f6', epic: '#ef4444', legendary: '#a855f7', mythic: '#f472b6' };
const tierColor = (label, i) => TIER_COLOR[(label ?? '').toLowerCase()] ?? ['#eab308', '#22c55e', '#3b82f6', '#ef4444'][i] ?? '#eab308';
const titleCase = (s) => (s ?? '').replace(/\b\w/g, (c) => c.toUpperCase());
const hideBrokenImg = (e) => { e.currentTarget.style.visibility = 'hidden'; }; // CC image 404 → hide, keep the card

export function ClassicGacha({ onTradeMarket }) {
  const [machines, setMachines] = useState([]);
  const [game, setGame] = useState('all');
  const [selected, setSelected] = useState(null); // selected machine code
  const [cards, setCards] = useState(null); // null = loading
  const [winners, setWinners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [ripping, setRipping] = useState(false);
  const [reveal, setReveal] = useState(null); // the won card shown in the reveal modal
  const [ripErr, setRipErr] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [payWith, setPayWith] = useState('usdc');
  const [tokens, setTokens] = useState(null); // { balance, untilFreePackTokens }
  const [tokensEnabled, setTokensEnabled] = useState(false);
  const { signMessage } = useWallet();

  useEffect(() => {
    let alive = true;
    Promise.all([api.getCcMachines(), api.getCcWinners(30).catch(() => ({ winners: [] }))])
      .then(([m, w]) => {
        if (!alive) return;
        const list = m.machines ?? [];
        setMachines(list);
        setWinners(w.winners ?? []);
        setSelected((cur) => cur ?? list[0]?.code ?? null);
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
  // Keep the winners ticker fresh — CC's feed moves as other players rip.
  useEffect(() => {
    const t = setInterval(() => api.getCcWinners(30).then((w) => setWinners(w.winners ?? [])).catch(() => {}), 20000);
    return () => clearInterval(t);
  }, []);
  // Loyalty Tokens: the balance/progress, and whether spending Tokens is enabled (earn always accrues).
  const loadTokens = () => { if (!api.hasSession()) return; api.getTokenBalance().then(setTokens).catch(() => {}); };
  useEffect(() => { loadTokens(); api.getHealth().then((h) => setTokensEnabled(!!h.tokensEnabled)).catch(() => {}); }, []);

  // Rip: open a pack, then poll until CC's reveal lands (the payment webhook can lag a few seconds).
  const rip = async (m) => {
    setRipErr(null);
    setRipping(true);
    try {
      const key = crypto.randomUUID();
      let r = await api.openGachaPack(m.code, key, m.priceE6, payWith);
      for (let i = 0; i < 12 && r.status === 'paid'; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        r = await api.getGachaOpen(r.openId);
      }
      if (r.status === 'opened' && r.card) { await loadInventory(); setReveal(r); } // inventory first → the modal's Sell-now resolves
      else if (r.status === 'refunded' || r.status === 'failed') setRipErr('The pack didn’t open — your payment was refunded.');
      else setRipErr('Still opening — it’ll show in Your pulls shortly.');
    } catch (e) {
      setRipErr(e?.status === 401 ? 'Sign in to rip a pack.' : e.message);
    } finally {
      setRipping(false);
      loadTokens(); // earn (USDC) or spend (Tokens) changed the balance
    }
  };

  const sellBack = async (item, instant = false) => {
    setRipErr(null);
    try {
      await api.sellGachaPrize(item.id, instant);
      setReveal(null);
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
      setReveal(null);
      loadInventory();
    } catch (e) {
      setRipErr(e?.status === 401 ? 'Sign in to withdraw.' : e.message);
    }
  };

  if (loading) return <div className="empty-state">Loading packs…</div>;
  if (err) return <div className="order-error">Couldn’t load packs: {err}</div>;
  if (machines.length === 0) return <div className="empty-state">No packs available right now.</div>;

  const games = ['all', ...Array.from(new Set(machines.map((m) => m.game)))];
  const shown = game === 'all' ? machines : machines.filter((m) => m.game === game);
  const machine = machines.find((m) => m.code === selected) ?? shown[0] ?? machines[0];
  const revealItem = reveal?.card ? inventory.find((i) => i.mint === reveal.card.mint) : null; // the held row backing the reveal (enables Sell now)

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

      <div className="gacha-tabs">
        {games.map((g) => (
          <button key={g} className={`gacha-tab ${g === game ? 'active' : ''}`} onClick={() => setGame(g)}>
            {g === 'all' ? 'All' : titleCase(g)}
          </button>
        ))}
      </div>

      <div className="gacha-strip">
        {shown.map((m) => (
          <button key={m.code} className={`gacha-chip ${m.code === selected ? 'active' : ''}`} onClick={() => setSelected(m.code)}>
            {m.image ? <img src={m.image} alt="" loading="lazy" /> : <span className="gacha-chip-ph" aria-hidden="true">📦</span>}
            <span className="gacha-chip-name">{m.name}</span>
            <span className="gacha-chip-price">{usd(m.priceE6)}</span>
          </button>
        ))}
      </div>

      <div className="gacha-main">
        <aside className="gacha-machine">
          <div className="gacha-machine-art">{machine.image ? <img src={machine.image} alt={machine.name} /> : <span aria-hidden="true">📦</span>}</div>
          <h3>{machine.name}</h3>
          <div className="gacha-price">{usd(machine.priceE6)}</div>
          {tokensEnabled && (
            <div className="gacha-paywith" role="group" aria-label="Pay with">
              <button className={`gacha-pay ${payWith === 'usdc' ? 'active' : ''}`} onClick={() => setPayWith('usdc')}>USDC</button>
              <button className={`gacha-pay ${payWith === 'tokens' ? 'active' : ''}`} onClick={() => setPayWith('tokens')}>🪙 Tokens</button>
            </div>
          )}
          <button className="btn-primary" disabled={ripping} onClick={() => rip(machine)}>
            {ripping ? 'Ripping…' : payWith === 'tokens' ? `Rip — ${tokenPrice(machine.priceE6)} Tokens` : `Rip — ${usd(machine.priceE6)}`}
          </button>
          {ripErr && <div className="order-error" style={{ marginTop: '0.5rem' }}>{ripErr}</div>}
          {machine.tiers?.length > 0 && (
            <ul className="gacha-tiers">
              {machine.tiers.map((t, i) => (
                <li key={t.label}>
                  <span className="gacha-dot" style={{ background: tierColor(t.label, i) }} aria-hidden="true" />
                  <span className="gacha-tier-label">{titleCase(t.label)}</span>
                  <span className="gacha-tier-range">{t.minE6 != null ? `${usd(t.minE6)}–${usd(t.maxE6)}` : ''}</span>
                  <span className="gacha-tier-pct">{t.pct}%</span>
                </li>
              ))}
            </ul>
          )}
          <div className="gacha-meta">
            <span>Instant buyback {machine.buybackPct}%</span>
            <span>Pack contains 1 card</span>
          </div>
        </aside>

        <section className="gacha-cards">
          <h4>In this pack{cards ? ` (${cards.length})` : ''}</h4>
          {cards == null ? (
            <div className="empty-state">Loading cards…</div>
          ) : cards.length === 0 ? (
            <div className="empty-state">No cards listed for this pack right now.</div>
          ) : (
            <div className="gacha-card-grid">
              {cards.map((c) => (
                <div key={c.mint} className="gacha-card">
                  <img src={c.imageUrl} alt={c.name} loading="lazy" onError={hideBrokenImg} />
                  <span className="gacha-card-name" title={c.name}>{c.name}</span>
                  <span className="gacha-card-val">{usd(c.valueE6)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {winners.length > 0 && (
        <section className="gacha-winners">
          <h4>Recent pulls</h4>
          <ul>
            {winners.map((w, i) => (
              <li key={`${w.mint}-${i}`}>
                <span className="gacha-win-who">{w.winner}</span>
                <span className="gacha-win-name">{w.name ?? 'a card'}</span>
                <span className="gacha-win-val up">{usd(w.valueE6)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {inventory.length > 0 && (
        <section className="gacha-inventory">
          <h4>Your pulls ({inventory.length})</h4>
          <div className="gacha-card-grid">
            {inventory.map((it) => (
              <div key={it.id} className="gacha-card">
                {it.imageUrl && <img src={it.imageUrl} alt={it.name ?? ''} loading="lazy" onError={hideBrokenImg} />}
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

      {reveal?.card && (
        <div className="gacha-modal-overlay" onClick={() => setReveal(null)}>
          <div className="gacha-modal" onClick={(e) => e.stopPropagation()}>
            <h3>You pulled a card!</h3>
            {reveal.card.imageUrl && <img className="gacha-modal-img" src={reveal.card.imageUrl} alt={reveal.card.name ?? ''} />}
            <div className="gacha-modal-name">{reveal.card.name ?? 'a card'}{reveal.card.grade ? ` · ${reveal.card.grade}` : ''}</div>
            <div className="gacha-modal-val">{usd(reveal.card.valueE6)}</div>
            <div className="gacha-modal-actions">
              {revealItem && <button className="btn-primary" onClick={() => sellBack(revealItem, true)}>Sell now (−10%)</button>}
              {reveal.card.marketId && <button className="btn-ghost" onClick={() => trade(reveal.card)}>Trade</button>}
              <button className="btn-ghost" onClick={() => setReveal(null)}>Keep</button>
            </div>
            {reveal.verifyUrl && <a className="gacha-verify" href={reveal.verifyUrl} target="_blank" rel="noreferrer">Verify this rip ↗</a>}
            {ripErr && <div className="order-error" style={{ marginTop: '0.5rem' }}>{ripErr}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
