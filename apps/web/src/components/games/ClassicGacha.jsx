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

  if (loading) return <div className="empty-state">Loading packs…</div>;
  if (err) return <div className="order-error">Couldn’t load packs: {err}</div>;
  if (machines.length === 0) return <div className="empty-state">No packs available right now.</div>;

  const games = ['all', ...Array.from(new Set(machines.map((m) => m.game)))];
  const shown = game === 'all' ? machines : machines.filter((m) => m.game === game);
  const machine = machines.find((m) => m.code === selected) ?? shown[0] ?? machines[0];

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
          <button className="btn-primary" disabled title="Buying opens in the next phase">Rip — coming soon</button>
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

      <p className="muted gacha-note">Read-only preview — buying real packs with your GachaDex balance arrives next.</p>
    </div>
  );
}
