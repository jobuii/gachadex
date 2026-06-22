import { useNavigate } from 'react-router-dom';
import { AuthButton } from './AuthButton';
import { ThemePicker } from './ThemePicker';
import Brand from './Brand';
import { useChat } from '../store/chat';

// One list drives both bars: desktop nav links use `label`; the mobile bottom tab bar uses
// `icon` + `short` (views without an icon — Home, which lives on the logo — get no tab).
const VIEWS = [
  { id: 'home', label: 'Home' },
  { id: 'trade', label: 'Exchange', icon: '📈', short: 'Trade' },
  { id: 'markets', label: 'Markets', icon: '🎴', short: 'Markets' },
  { id: 'pool', label: 'Pool', icon: '💧', short: 'Pool' },
  { id: 'leaderboard', label: 'Leaderboard', icon: '🏆', short: 'Ranks' },
  { id: 'portfolio', label: 'Portfolio', icon: '👤', short: 'Folio' },
];

export function Navbar({ activeView, setActiveView, chatOpen, onToggleChat }) {
  const unread = useChat((s) => s.unread);
  const navigate = useNavigate();
  return (
    <>
    <nav className="navbar">
      <div className="nav-left">
        <button type="button" className="nav-brand" onClick={() => navigate('/')} title="Back to home">
          <Brand size={30} />
        </button>
        <button
          className={`chat-toggle ${chatOpen ? 'active' : ''}`}
          onClick={onToggleChat}
          title={chatOpen ? 'Hide chat' : 'Open chat'}
        >
          💬 Chat
          {!chatOpen && unread > 0 && <span className="chat-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      </div>

      <div className="nav-links">
        {VIEWS.map(({ id, label }) => (
          <button
            key={id}
            className={`nav-link ${activeView === id ? 'active' : ''}`}
            onClick={() => (id === 'home' ? navigate('/') : setActiveView(id))}
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
        <ThemePicker />
        <AuthButton />
      </div>
    </nav>

    {/* mobile-only bottom tab bar (display:none on desktop, see mobile.css) */}
    <nav className="mobile-tabbar" aria-label="Primary">
      {VIEWS.filter((v) => v.icon).map(({ id, icon, short }) => (
        <button
          key={id}
          className={`mobile-tab ${activeView === id ? 'active' : ''}`}
          onClick={() => setActiveView(id)}
        >
          <span className="mt-ico" aria-hidden="true">{icon}</span>
          {short}
        </button>
      ))}
    </nav>
    </>
  );
}
