import { useNavigate } from 'react-router-dom';
import { AuthButton } from './AuthButton';
import { Wordmark } from './Brand';
import { useChat } from '../store/chat';

// One list drives both bars: desktop nav links use `label`; the mobile bottom tab bar uses `short`
// + a glyph from NAV_ICONS (views without `short` — Home, which lives on the logo — get no tab).
const VIEWS = [
  { id: 'home', label: 'Home' },
  { id: 'trade', label: 'Trade', short: 'Trade' },
  { id: 'games', label: 'Play', short: 'Play' }, // shown only when GAMES_ENABLED (gamesVisible); sits right after Trade
  { id: 'markets', label: 'Markets', short: 'Markets' },
  { id: 'pool', label: 'Pool', short: 'Pool' },
  { id: 'leaderboard', label: 'Leaderboard', short: 'Ranks' },
  { id: 'docs', label: 'Docs' }, // routes to /docs (no `short` → desktop nav only, like Home)
  { id: 'portfolio', label: 'Portfolio', short: 'Folio' }, // always the rightmost nav option
];

// Mobile tab-bar glyphs (line-style; inherit the tab colour via currentColor). Keyed by view id.
const NAV_ICONS = {
  trade: <><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></>,
  markets: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>,
  pool: <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />,
  games: <><line x1="6" y1="11" x2="10" y2="11" /><line x1="8" y1="9" x2="8" y2="13" /><line x1="15" y1="12" x2="15.01" y2="12" /><line x1="18" y1="10" x2="18.01" y2="10" /><rect x="2" y="6" width="20" height="12" rx="3" /></>,
  leaderboard: <><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2z" /></>,
  portfolio: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
};

export function Navbar({ activeView, setActiveView, chatOpen, onToggleChat, gamesVisible = false }) {
  const unread = useChat((s) => s.unread);
  const navigate = useNavigate();
  // The Games tab stays hidden from customers until the operator flips GAMES_ENABLED (surfaced via /health).
  const views = gamesVisible ? VIEWS : VIEWS.filter((v) => v.id !== 'games');
  return (
    <>
    <nav className="navbar">
      <div className="nav-left">
        <button type="button" className="nav-brand" onClick={() => navigate('/')} title="Back to home">
          <Wordmark />
        </button>
        <button
          className={`chat-toggle ${chatOpen ? 'active' : ''}`}
          onClick={onToggleChat}
          title={chatOpen ? 'Hide chat' : 'Open chat'}
        >
          💬<span className="chat-label"> Chat</span>
          {!chatOpen && unread > 0 && <span className="chat-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      </div>

      <div className="nav-links">
        {views.map(({ id, label }) => (
          <button
            key={id}
            className={`nav-link ${activeView === id ? 'active' : ''}`}
            onClick={() => (id === 'home' ? navigate('/') : id === 'docs' ? navigate('/docs') : setActiveView(id))}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="nav-actions">
        <a
          href="https://x.com/gachadexcards"
          target="_blank"
          rel="noopener noreferrer"
          title="Follow on Twitter/X"
          aria-label="Follow on Twitter/X"
          className="nav-social-link"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
        <button type="button" className="chat-toggle nav-docs" onClick={() => navigate('/docs')} title="Docs" aria-label="Docs">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></svg>
        </button>
        <AuthButton />
      </div>
    </nav>

    {/* mobile-only bottom tab bar (display:none on desktop, see mobile.css) */}
    <nav className="mobile-tabbar" aria-label="Primary">
      {views.filter((v) => v.short).map(({ id, short }) => (
        <button
          key={id}
          className={`mobile-tab ${activeView === id ? 'active' : ''}`}
          onClick={() => setActiveView(id)}
        >
          <span className="mt-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{NAV_ICONS[id]}</svg>
          </span>
          {short}
        </button>
      ))}
    </nav>
    </>
  );
}
