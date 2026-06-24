import { useState, useEffect } from 'react';
import { formatUsd } from '@pokex/pricing';
import * as api from '../../lib/api.js';

// Classic Gacha lobby (docs/classic-gacha-cc-packs-spec.md, P0 — read-only). Browses the live Collector
// Crypt machines: a game-filter, a machine strip, the selected machine's detail (price + tier legend +
// buyback %), the real graded cards in its pool, and a recent-winners ticker. Buying arrives in P1, so the
// Rip button is a disabled placeholder here.

const usd = (e6) => formatUsd(BigInt(e6 || 0)); // `|| 0` guards '', null, undefined (e6 is always an integer string)
const TIER_COLOR = { common: '#eab308', uncommon: '#22c55e', rare: '#3b82f6', epic: '#ef4444', legendary: '#a855f7', mythic: '#f472b6' };
const tierColor = (label, i) => TIER_COLOR[(label ?? '').toLowerCase()] ?? ['#eab308', '#22c55e', '#3b82f6', '#ef4444'][i] ?? '#eab308';
const titleCase = (s) => (s ?? '').replace(/\b\w/g, (c) => c.toUpperCase());

export function ClassicGacha() {
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

  const loadInventory = () => api.getGachaInventory().then((r) => setInventory(r.inventory ?? [])).catch(() => {});
  useEffect(() => { loadInventory(); }, []);

  // Rip: open a pack, then poll until CC's reveal lands (the payment webhook can lag a few seconds).
  const rip = async (m) => {
    setRipErr(null);
    setRipping(true);
    try {
      const key = crypto.randomUUID();
      let r = await api.openGachaPack(m.code, key, m.priceE6);
      for (let i = 0; i < 12 && r.status === 'paid'; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        r = await api.getGachaOpen(r.openId);
      }
      if (r.status === 'opened' && r.card) { await loadInventory(); setReveal(r.card); } // inventory first → the modal's Sell-back resolves
      else if (r.status === 'refunded' || r.status === 'failed') setRipErr('The pack didn’t open — you were refunded.');
      else setRipErr('Still opening — it’ll show in Your pulls shortly.');
    } catch (e) {
      setRipErr(e?.status === 401 ? 'Sign in to rip a pack.' : e.message);
    } finally {
      setRipping(false);
    }
  };

  const sellBack = async (item) => {
    setRipErr(null);
    try {
      await api.sellGachaPrize(item.id);
      setReveal(null);
      loadInventory();
    } catch (e) {
      setRipErr(e.message);
    }
  };

  if (loading) return <div className="empty-state">Loading packs…</div>;
  if (err) return <div className="order-error">Couldn’t load packs: {err}</div>;
  if (machines.length === 0) return <div className="empty-state">No packs available right now.</div>;

  const games = ['all', ...Array.from(new Set(machines.map((m) => m.game)))];
  const shown = game === 'all' ? machines : machines.filter((m) => m.game === game);
  const machine = machines.find((m) => m.code === selected) ?? shown[0] ?? machines[0];
  const revealItem = reveal ? inventory.find((i) => i.mint === reveal.mint) : null; // the held row backing the reveal (enables Sell back)

  return (
    <div className="gacha g-classic-gacha">
      <div className="games-hero">
        <h2>Classic Gacha</h2>
        <p className="muted">Real graded-card packs from Collector Crypt — win a genuine slab, sell it back or keep it.</p>
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
          <button className="btn-primary" disabled={ripping} onClick={() => rip(machine)}>{ripping ? 'Ripping…' : `Rip — ${usd(machine.priceE6)}`}</button>
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
                  <img src={c.imageUrl} alt={c.name} loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
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
                {it.imageUrl && <img src={it.imageUrl} alt={it.name ?? ''} loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />}
                <span className="gacha-card-name" title={it.name ?? ''}>{it.name ?? 'card'}{it.grade ? ` · ${it.grade}` : ''}</span>
                <span className="gacha-card-val">{usd(it.valueE6)}</span>
                <button className="btn-ghost sm" onClick={() => sellBack(it)}>Sell back</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="muted gacha-note">Real graded-card packs from Collector Crypt — bought with your GachaDex balance. Sell a pull back for USDC (GDEX keeps 5%) or keep it.</p>

      {reveal && (
        <div className="gacha-modal-overlay" onClick={() => setReveal(null)}>
          <div className="gacha-modal" onClick={(e) => e.stopPropagation()}>
            <h3>You pulled a card!</h3>
            {reveal.imageUrl && <img className="gacha-modal-img" src={reveal.imageUrl} alt={reveal.name ?? ''} />}
            <div className="gacha-modal-name">{reveal.name ?? 'a card'}{reveal.grade ? ` · ${reveal.grade}` : ''}</div>
            <div className="gacha-modal-val">{usd(reveal.valueE6)}</div>
            <div className="gacha-modal-actions">
              {revealItem && <button className="btn-primary" onClick={() => sellBack(revealItem)}>Sell back (−5%)</button>}
              <button className="btn-ghost" onClick={() => setReveal(null)}>Keep</button>
            </div>
            {ripErr && <div className="order-error" style={{ marginTop: '0.5rem' }}>{ripErr}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
