import { useState, useEffect } from 'react';
import * as api from '../lib/api.js';
import { useGames } from '../store/games.js';
import { PackRip } from './games/PackRip.jsx';
import { SetPoker } from './games/SetPoker.jsx';
import { GradeGamble } from './games/GradeGamble.jsx';
import { TheBreak } from './games/TheBreak.jsx';
import { PriceDuel } from './games/PriceDuel.jsx';
import { CardFantasy } from './games/CardFantasy.jsx';

// The playable game panels, keyed by the lobby/server id.
const PANELS = { 'pack-rip': PackRip, 'set-poker': SetPoker, 'grade-gamble': GradeGamble, 'the-break': TheBreak, 'price-duel': PriceDuel, fantasy: CardFantasy };

// The 7-game lineup (docs/games-spec.md). The first six are live; the rest render as "coming soon"
// tiles so the surface shows the full roadmap. id matches the server's games list for live ones.
const LINEUP = [
  { id: 'pack-rip', name: 'Pack Rip', icon: '🎴', blurb: 'Open a pack, reveal a card, sell it back for USDC.', live: true },
  { id: 'set-poker', name: 'Set Poker', icon: '🃏', blurb: 'Five-card draw — your cards’ value beats the house.', live: true },
  { id: 'grade-gamble', name: 'Grade Gamble', icon: '🔍', blurb: 'Gamble a raw card up the grade ladder.', live: true },
  { id: 'the-break', name: 'The Break', icon: '📦', blurb: 'Buy spots in a shared case; the cards shuffle to spots.', live: true },
  { id: 'price-duel', name: 'Price Duel', icon: '⚔️', blurb: 'Pick a card; the bigger %-move wins the pot.', live: true },
  { id: 'fantasy', name: 'Card Fantasy', icon: '🏆', blurb: 'Draft a roster under a cap; biggest %-move wins.', live: true },
  { id: 'draft-arena', name: 'Draft Arena', icon: '🎯', blurb: 'Snake-draft, rosters battle on price.', live: false },
];

export function GamesView({ onTradeMarket }) {
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
      <h2>Games</h2>
      <p className="muted">
        Provably-fair card games. Win a card, sell it back for USDC at its live oracle price — or keep it and trade the market.
      </p>
      {masterOff && <div className="games-banner">Games are not live yet — check back soon.</div>}
      <div className="games-grid">
        {LINEUP.map((g) => {
          const sg = serverGame(g.id);
          const enabled = g.live && sg?.enabled;
          return (
            <button
              key={g.id}
              className={`game-tile ${enabled ? '' : 'disabled'}`}
              onClick={() => enabled && setSelected(g.id)}
              disabled={!enabled}
            >
              <span className="game-tile-icon" aria-hidden="true">{g.icon}</span>
              <span className="game-tile-name">{g.name}</span>
              <span className="game-tile-blurb">{g.blurb}</span>
              <span className="game-tile-tag">{g.live ? (sg?.enabled ? 'Play' : 'Off') : 'Soon'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
