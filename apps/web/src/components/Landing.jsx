import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChatSidebar } from './ChatSidebar';
import { useChat, initialChatOpen, persistChatOpen } from '../store/chat';
import '../landing.css';

const CYCLE = ['LONG', 'SHORT', 'LONG', 'SHORT']; // hero word swap (gold)
const TICKER = [
  'GO LONG', 'GO SHORT', '20× LEVERAGE', 'CHARIZARD', 'TCG PERPS', 'REAL USDC',
  'ON SOLANA', 'EVERY MARKET LIVE', 'PUMP IT', 'DUMP IT',
];

const STEPS = [
  ['01', 'CONNECT', 'Link your Solana wallet. No sign-up, no forms.'],
  ['02', 'DEPOSIT', 'Fund your account with USDC. Your keys, your coins.'],
  ['03', 'TRADE', 'Go long or short on any card or index — with leverage.'],
];

const FEATURES = [
  ['🎴', 'EVERY MARKET LIVE', 'Trade any card from day one. Our liquidity engine seeds every market, so you never wait for someone to take the other side.'],
  ['📈', 'LONG OR SHORT', 'Win when prices pump or dump. Pick a side on any card, set, or index.'],
  ['⚡', 'INSTANT EXECUTION', 'Lightning-fast order execution, settled on Solana.'],
  ['📊', 'REAL-TIME PRICES', 'Live prices and market data on every card, at your fingertips.'],
  ['💵', 'REAL USDC, ON-CHAIN', 'Deposit and withdraw real USDC on Solana — custodied transparently with on-chain proof-of-reserves.'],
  ['🚀', 'UP TO 20× LEVERAGE', 'Isolated-margin leverage — amplify your conviction while capping the downside to your margin.'],
  ['🏆', 'LEADERBOARD', 'Compete with other traders and climb the rankings.'],
  ['🌍', 'MULTI-UNIVERSE', 'Pokémon now — One Piece, Magic & more collectible universes incoming.'],
];

const FAQ = [
  ['What is GachaDex?', 'A leveraged perpetuals exchange for trading-card prices. Go long or short on Pokémon & TCG cards and indices — it’s the market, not the cardboard.'],
  ['Where do card prices come from?', 'A daily price oracle (TCGplayer market price) feeds every market, with operator overrides from sources that have no API (eBay solds, etc.).'],
  ['Is this real money?', 'Yes — you trade with real USDC, settled on Solana. Deposits and withdrawals are on-chain.'],
  ['What can I trade?', 'Individual cards and curated indices — Top 100, Top 250, and Graded (PSA-10) baskets.'],
  ['Do I own the cards?', 'No. GachaDex is price exposure, not physical custody. You trade the market without ever shipping a card.'],
];

const CONTRACT_ADDRESS = '3FdoksSvontxzSg42mfBccFp8zmH4KdgbS8bsoMgpump';
const SOCIALS = [
  ['X', 'https://x.com/gachadexcards', 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z'],
  ['GitHub', 'https://github.com/NoizceEra/gachadex-landing', 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'],
];

export function Landing() {
  const navigate = useNavigate();
  const unread = useChat((s) => s.unread);
  const [chatOpen, setChatOpen] = useState(initialChatOpen);
  const onToggleChat = () =>
    setChatOpen((o) => {
      const next = !o;
      persistChatOpen(next);
      return next;
    });
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setW((i) => (i + 1) % CYCLE.length), 1600);
    return () => clearInterval(t);
  }, []);

  const [copied, setCopied] = useState(false);
  const copyCa = () => {
    navigator.clipboard
      ?.writeText(CONTRACT_ADDRESS)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const enter = (e) => {
    e?.preventDefault();
    navigate('/exchange');
  };
  const scrollTo = (id) => (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className={`lp ${chatOpen ? 'lp-chat-open' : ''}`}>
      <div className="lp-scanlines" aria-hidden="true" />
      <ChatSidebar open={chatOpen} onToggle={onToggleChat} />

      <header className="lp-nav">
        <div className="lp-nav-left">
          <a className="lp-brand" href="#" onClick={enter}>
            <img src="/GachaDexPFP2.png" alt="" className="lp-logo" />
            <img src="/GachaDexWords.png" alt="GachaDex" className="lp-wordmark" />
          </a>
          <button className={`chat-toggle ${chatOpen ? 'active' : ''}`} onClick={onToggleChat} title={chatOpen ? 'Hide chat' : 'Open chat'}>
            💬 Chat
            {!chatOpen && unread > 0 && <span className="chat-badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
        </div>
        <nav className="lp-nav-links">
          <a href="#how" onClick={scrollTo('how')}>HOW IT WORKS</a>
          <a href="#why" onClick={scrollTo('why')}>FEATURES</a>
          <a href="#faq" onClick={scrollTo('faq')}>FAQ</a>
          {SOCIALS.map(([label, href, d]) => (
            <a key={label} className="lp-social" href={href} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={d} /></svg>
            </a>
          ))}
          <button className="lp-btn lp-btn-sm" onClick={enter}>ENTER ▶</button>
        </nav>
      </header>

      {/* HERO */}
      <section className="lp-hero">
        <div className="lp-hero-copy">
          <div className="lp-kicker">★ TCG CARD PERPS · ON SOLANA</div>
          <h1 className="lp-h1">
            GO <span className="lp-swap">{CYCLE[w]}</span><br />ON EVERY CARD.
          </h1>
          <p className="lp-sub">
            Leveraged perpetuals on Pokémon &amp; TCG card prices. Real USDC, on Solana,
            and <strong>every market tradeable</strong> from day one.
          </p>
          <div className="lp-cta-row">
            <button className="lp-btn lp-btn-lg" onClick={enter}>▶ INSERT COIN</button>
            <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#how" onClick={scrollTo('how')}>HOW IT WORKS</a>
          </div>
          <div className="lp-trust">NO SIGN-UP · YOUR KEYS · LONG OR SHORT</div>
        </div>

        <div className="lp-hero-art">
          {/* the cards the chart tracks — fanned behind the arcade screen */}
          <div className="lp-card lp-card-a">
            <img src="https://images.pokemontcg.io/base1/2.png" alt="Blastoise card" loading="lazy" />
            <span className="lp-card-badge down">▼ 6%</span>
          </div>
          <div className="lp-card lp-card-c">
            <img src="https://images.pokemontcg.io/base1/15.png" alt="Venusaur card" loading="lazy" />
            <span className="lp-card-badge up">▲ 48%</span>
          </div>
          <div className="lp-card lp-card-b">
            <img src="https://images.pokemontcg.io/base1/4.png" alt="Charizard card" loading="lazy" />
            <span className="lp-card-badge up">▲ 312%</span>
          </div>

          <div className="lp-screen" aria-hidden="true">
            <div className="lp-screen-bezel">
              <div className="lp-screen-glass">
                <svg viewBox="0 0 220 130" preserveAspectRatio="none" className="lp-chart">
                  <polyline points="0,96 28,88 28,70 56,70 56,100 84,100 84,58 112,58 112,76 140,76 140,40 168,40 168,52 196,52 196,22 220,22"
                    fill="none" stroke="var(--success)" strokeWidth="3" />
                  <polygon points="0,96 28,88 28,70 56,70 56,100 84,100 84,58 112,58 112,76 140,76 140,40 168,40 168,52 196,52 196,22 220,22 220,130 0,130"
                    fill="var(--success)" opacity="0.12" />
                </svg>
                <div className="lp-screen-tag">CHARIZARD ▲ +312%</div>
              </div>
            </div>
            <div className="lp-cabinet-base" />
          </div>
        </div>
      </section>

      {/* TICKER */}
      <div className="lp-ticker" aria-hidden="true">
        <div className="lp-ticker-track">
          {[...TICKER, ...TICKER].map((t, i) => (
            <span key={i} className="lp-ticker-item">{t}<span className="lp-spark">★</span></span>
          ))}
        </div>
      </div>

      {/* CONTRACT ADDRESS */}
      <section className="lp-ca">
        <span className="lp-ca-label">★ CONTRACT</span>
        <code className="lp-ca-addr">{CONTRACT_ADDRESS}</code>
        <button className="lp-ca-copy" onClick={copyCa}>{copied ? '✓ COPIED' : '📋 COPY'}</button>
      </section>

      {/* HOW IT WORKS */}
      <section className="lp-section" id="how">
        <h2 className="lp-h2">THREE MOVES TO YOUR FIRST TRADE</h2>
        <div className="lp-steps">
          {STEPS.map(([n, title, body]) => (
            <div className="lp-step" key={n}>
              <div className="lp-step-num">{n}</div>
              <h3 className="lp-h3">{title}</h3>
              <p className="lp-body">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES */}
      <section className="lp-section lp-section-alt" id="why">
        <h2 className="lp-h2">BUILT FOR SPECULATORS &amp; COLLECTORS</h2>
        <div className="lp-features">
          {FEATURES.map(([icon, title, body]) => (
            <div className="lp-feature" key={title}>
              <div className="lp-feature-icon">{icon}</div>
              <div>
                <h3 className="lp-h3">{title}</h3>
                <p className="lp-body">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="lp-section" id="faq">
        <h2 className="lp-h2">EVERYTHING YOU NEED TO KNOW</h2>
        <div className="lp-faq">
          {FAQ.map(([q, a]) => (
            <details className="lp-faq-row" key={q}>
              <summary className="lp-faq-q">{q}<span className="lp-faq-mark">+</span></summary>
              <p className="lp-faq-a">{a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="lp-final">
        <h2 className="lp-h2">READY PLAYER ONE?</h2>
        <p className="lp-body">Insert a coin and take your first position.</p>
        <button className="lp-btn lp-btn-lg" onClick={enter}>▶ ENTER THE ARCADE</button>
      </section>

      <footer className="lp-footer">
        <img src="/GachaDexPFP2.png" alt="" className="lp-logo" />
        <div className="lp-foot-meta">
          <div>GachaDex — TCG Card Perps</div>
          <div className="lp-foot-fine">
            Trade price exposure, not physical cards. Not affiliated with Nintendo / The Pokémon Company. © 2026 GachaDex.
          </div>
          <div className="lp-foot-social">
            {SOCIALS.map(([label, href, d]) => (
              <a key={label} href={href} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={d} /></svg>
              </a>
            ))}
          </div>
        </div>
        <button className="lp-btn lp-btn-sm" onClick={enter}>ENTER ▶</button>
      </footer>
    </div>
  );
}
