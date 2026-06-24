import { useState, useEffect } from 'react';
import * as api from '../lib/api.js';
import { useGames } from '../store/games.js';
import { PackRip } from './games/PackRip.jsx';
import { SetPoker } from './games/SetPoker.jsx';
import { GradeGamble } from './games/GradeGamble.jsx';
import { TheBreak } from './games/TheBreak.jsx';
import { PriceDuel } from './games/PriceDuel.jsx';
import { CardFantasy } from './games/CardFantasy.jsx';
import { DraftArena } from './games/DraftArena.jsx';
import { ClassicGacha } from './games/ClassicGacha.jsx';

// The playable game panels, keyed by the lobby/server id.
const PANELS = { 'classic-gacha': ClassicGacha, 'pack-rip': PackRip, 'set-poker': SetPoker, 'grade-gamble': GradeGamble, 'the-break': TheBreak, 'price-duel': PriceDuel, fantasy: CardFantasy, 'draft-arena': DraftArena };

// The full 7-game lineup (docs/games-spec.md) — all live. id matches the server's games list; cat groups
// the lobby into sections (like flip.gg's "Originals" rows).
const LINEUP = [
  { id: 'classic-gacha', name: 'Classic Gacha', icon: '💎', blurb: 'Open real graded-card packs from Collector Crypt.', live: true, cat: 'gacha' },
  { id: 'pack-rip', name: 'Pack Rip', icon: '🎴', blurb: 'Open a pack, reveal a card, sell it back for USDC.', live: true, cat: 'casino' },
  { id: 'set-poker', name: 'Set Poker', icon: '🃏', blurb: 'Five-card draw — your cards’ value beats the house.', live: true, cat: 'casino' },
  { id: 'grade-gamble', name: 'Grade Gamble', icon: '🔍', blurb: 'Gamble a raw card up the grade ladder.', live: true, cat: 'casino' },
  { id: 'the-break', name: 'The Break', icon: '📦', blurb: 'Buy spots in a shared case; the cards shuffle to spots.', live: true, cat: 'casino' },
  { id: 'price-duel', name: 'Price Duel', icon: '⚔️', blurb: 'Pick a card; the bigger %-move wins the pot.', live: true, cat: 'skill' },
  { id: 'fantasy', name: 'Card Fantasy', icon: '🏆', blurb: 'Draft a roster under a cap; biggest %-move wins.', live: true, cat: 'skill' },
  { id: 'draft-arena', name: 'Draft Arena', icon: '🎯', blurb: 'Snake-draft a shared pool; rosters battle on price.', live: true, cat: 'skill' },
];

// Lobby sections, in order.
const SECTIONS = [
  { cat: 'gacha', label: 'Classic Gacha', icon: '💎' },
  { cat: 'casino', label: 'Casino', icon: '🎰' },
  { cat: 'skill', label: 'Skill & PvP', icon: '🆚' },
];

export function GamesView({ onTradeMarket, gamesVisible, classicGachaVisible }) {
  const [config, setConfig] = useState(null); // server games list (enabled flags + tiers)
  const [selected, setSelected] = useState(null);
  const startFeed = useGames((s) => s.start);

  useEffect(() => {
    startFeed();
    api.getGames().then(setConfig).catch(() => {});
  }, [startFeed]);

  const serverGame = (id) => config?.games?.find((g) => g.id === id) || null;
  const masterOff = config && !config.enabled;

  const Panel = selected ? PANELS[selected] : null;
  if (Panel) {
    return (
      <div className="page games">
        <button className="link games-back" onClick={() => setSelected(null)}>← All games</button>
        <Panel config={serverGame(selected)} onTradeMarket={onTradeMarket} />
      </div>
    );
  }

  return (
    <div className="page games">
      <div className="games-hero">
        <h2>Games</h2>
        <p className="muted">
          Provably-fair card games. Win a card, sell it back for USDC at its live oracle price — or keep it and trade the market.
        </p>
      </div>
      {gamesVisible && masterOff && !classicGachaVisible && <div className="games-banner">Games are not live yet — check back soon.</div>}
      {SECTIONS.map((s) => {
        if (s.cat === 'gacha' ? !classicGachaVisible : !gamesVisible) return null; // each surface gates on its own flag
        const games = LINEUP.filter((g) => g.cat === s.cat);
        if (games.length === 0) return null;
        return (
          <section className="games-section" key={s.cat}>
            <h3 className="games-section-head"><span className="games-section-icon" aria-hidden="true">{s.icon}</span>{s.label}</h3>
            <div className="games-grid">
              {games.map((g) => {
                const enabled = g.cat === 'gacha' ? classicGachaVisible : g.live && serverGame(g.id)?.enabled;
                return (
                  <button
                    key={g.id}
                    className={`game-card g-${g.id} ${enabled ? '' : 'disabled'}`}
                    onClick={() => enabled && setSelected(g.id)}
                    disabled={!enabled}
                  >
                    <span className="game-art" aria-hidden="true">
                      <span className="game-art-deck"><i /><i /><i /></span>
                      <span className="game-art-icon">{g.icon}</span>
                      <img className="game-art-img" src={`/games/${g.id}.webp`} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    </span>
                    <span className="game-foot">
                      <span className="game-foot-main">
                        <span className="game-name">{g.name}</span>
                        <span className="game-blurb">{g.blurb}</span>
                      </span>
                      <span className="game-play">{enabled ? 'Play' : g.live ? 'Off' : 'Soon'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
