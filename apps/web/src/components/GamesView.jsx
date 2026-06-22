import { useState, useEffect } from 'react';
import * as api from '../lib/api.js';
import { useGames } from '../store/games.js';
import { PackRip } from './games/PackRip.jsx';

// The 7-game lineup (docs/games-spec.md). Phase 1 ships Pack Rip; the rest render as "coming soon"
// tiles so the surface shows the full roadmap. id matches the server's games list for the live ones.
const LINEUP = [
  { id: 'pack-rip', name: 'Pack Rip', icon: '🎴', blurb: 'Open a pack, reveal a card, sell it back for USDC.', live: true },
  { id: 'set-poker', name: 'Set Poker', icon: '🃏', blurb: 'Five-card draw — your cards’ value beats the house.', live: false },
  { id: 'grade-gamble', name: 'Grade Gamble', icon: '🔍', blurb: 'Gamble a raw card up the grade ladder.', live: false },
  { id: 'the-break', name: 'The Break', icon: '📦', blurb: 'Buy spots in a sealed digital case.', live: false },
  { id: 'price-duel', name: 'Price Duel', icon: '⚔️', blurb: 'Pick a card, biggest price move wins.', live: false },
  { id: 'fantasy', name: 'Card Fantasy', icon: '🏆', blurb: 'Draft a roster, climb the weekly board.', live: false },
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

  if (selected === 'pack-rip') {
    return (
      <div className="page games">
        <button className="link games-back" onClick={() => setSelected(null)}>← All games</button>
        <PackRip config={serverGame('pack-rip')} onTradeMarket={onTradeMarket} />
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
