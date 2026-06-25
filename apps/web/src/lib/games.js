// Per-game brand identity (label + dot colour) — the single source of truth for the market surfaces:
// the screener game tabs, the sidebar game switcher, and the Indices game filter. Web-only (UI colours).
export const GAME_BRAND = {
  pokemon: { label: 'Pokémon', color: '#f0c040' },
  onepiece: { label: 'One Piece', color: '#d4202a' },
  mtg: { label: 'Magic', color: '#7c5cff' },
};

// canonical display order
export const GAME_ORDER = ['pokemon', 'onepiece', 'mtg'];

// the three games as `{ id, label, color }` rows (sidebar game switcher)
export const GAME_LIST = GAME_ORDER.map((id) => ({ id, ...GAME_BRAND[id] }));

// the 'all' pseudo-game (neutral dot) + the full filter-tab list (All, then each game) for the screeners
export const GAME_ALL = { id: 'all', label: 'All', color: '#8b949e' };
export const GAME_TABS = [GAME_ALL, ...GAME_LIST];

// resolve a game's brand with a safe fallback for an unknown game id
export const gameBrand = (id) => GAME_BRAND[id] || { label: id, color: 'var(--accent)' };
