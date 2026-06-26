import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChatSidebar } from './ChatSidebar';
import { Wordmark } from './Brand';
import { useChat, initialChatOpen, persistChatOpen } from '../store/chat';
import * as api from '../lib/api.js';
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

// [branded icon (served from public/icons), title, body] — the reference SVGs recolored to our brand.
const FEATURES = [
  ['every-market-live.svg', 'EVERY MARKET LIVE', 'Trade any card from day one. Our liquidity engine seeds every market, so you never wait for someone to take the other side.'],
  ['long-or-short.svg', 'LONG OR SHORT', 'Win when prices pump or dump. Pick a side on any card, set, or index.'],
  ['instant-execution.svg', 'INSTANT EXECUTION', 'Lightning-fast order execution, settled on Solana.'],
  ['real-time-prices.svg', 'REAL-TIME PRICES', 'Live prices and market data on every card, at your fingertips.'],
  ['real-usdc.svg', 'REAL USDC, ON-CHAIN', 'Deposit and withdraw real USDC on Solana — custodied transparently with on-chain proof-of-reserves.'],
  ['leverage.svg', 'UP TO 20× LEVERAGE', 'Isolated-margin leverage — amplify your conviction while capping the downside to your margin.'],
  ['leaderboard.svg', 'LEADERBOARD', 'Compete with other traders and climb the rankings.'],
  ['multi-universe.svg', 'MULTI-UNIVERSE', 'Pokémon now — One Piece, Magic & more collectible universes incoming.'],
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
  ['GitHub', 'https://github.com/gachadex/cli', 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'],
  ['npm', 'https://www.npmjs.com/package/@gachadex/sdk', 'M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z'],
];

// --- Classic Gacha launch announcement (gated on CLASSIC_GACHA_ENABLED via /health) -------------
const GACHA_MODAL_KEY = 'gdx:gacha-launch-modal:v1'; // show the spotlight modal once, ever
const GACHA_BANNER_KEY = 'gdx:gacha-banner:v1'; // remember the top-banner dismissal
const GACHA_AUTO_CLOSE_MS = 9000; // soft auto-close once read — pauses while the pointer is over the modal
const GACHA_MAX_OPEN_MS = 18000; // hard cap: the modal always closes by here, even if left hovered (never stuck)
const GACHA_SHOW_DELAY_MS = 1400; // let the hero paint first (never pop before the page loads)
const GACHA_DROP_CARDS = ['base1/4', 'base1/2', 'base1/15', 'base1/10', 'base1/16']; // cards raining from the machine
// localStorage helpers — default to "already seen" if storage is unavailable (private mode) so we never nag
const seenFlag = (k) => { try { return !!localStorage.getItem(k); } catch { return true; } };
const setSeen = (k) => { try { localStorage.setItem(k, '1'); } catch { /* private mode */ } };

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

  // Scroll-reveal: fade/scale elements in as they enter the viewport, with a stagger (aeon-style).
  // Honors prefers-reduced-motion and degrades to "everything visible" if IntersectionObserver is absent.
  useEffect(() => {
    const els = document.querySelectorAll('[data-reveal], [data-reveal-line]');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof IntersectionObserver === 'undefined') {
      els.forEach((el) => el.classList.add('revealed'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('revealed');
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
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

  // ---- Classic Gacha launch announcement: a show-once spotlight modal + a dismissible banner + a nav entry,
  // all gated on the live CLASSIC_GACHA_ENABLED flag so nothing announces a feature that isn't on yet. ----
  const [gachaLive, setGachaLive] = useState(false);
  const [showGacha, setShowGacha] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(() => seenFlag(GACHA_BANNER_KEY));
  const [gachaPaused, setGachaPaused] = useState(false);
  const gachaDialogRef = useRef(null);
  const gachaRemaining = useRef(GACHA_AUTO_CLOSE_MS); // soft-close budget left (ms), kept across hover-pauses

  // is Classic Gacha live? (same /health gate the Exchange uses) — drives the whole announcement + nav entry
  useEffect(() => {
    api.getHealth().then((h) => setGachaLive(!!h.classicGachaEnabled)).catch(() => {});
  }, []);

  // show the spotlight modal ONCE, shortly after load — and mark it seen the moment it shows, so a refresh
  // (or navigating away) never re-triggers it
  useEffect(() => {
    if (!gachaLive || seenFlag(GACHA_MODAL_KEY)) return;
    const t = setTimeout(() => { setShowGacha(true); setSeen(GACHA_MODAL_KEY); }, GACHA_SHOW_DELAY_MS);
    return () => clearTimeout(t);
  }, [gachaLive]);

  // the dismissible banner is derived — open while live and not yet dismissed (no effect/extra state needed)
  const bannerOpen = gachaLive && !bannerDismissed;

  const closeGacha = useCallback(() => { setShowGacha(false); setGachaPaused(false); }, []);

  // refill the soft-close budget each time the modal opens
  useEffect(() => { if (showGacha) gachaRemaining.current = GACHA_AUTO_CLOSE_MS; }, [showGacha]);

  // soft auto-close — this effect OWNS the timer. It runs only while open AND not paused; on teardown it
  // deducts the elapsed slice from the remaining budget, so a hover (gachaPaused=true) stops the clock and a
  // leave resumes it from where it left off. pause/resume merely flip the flag — that sidesteps the
  // appear-under-cursor race an imperative start/stop had (a mouseenter firing before this effect could
  // corrupt the budget to 0 and flash-close the modal).
  useEffect(() => {
    if (!showGacha || gachaPaused) return;
    const startedAt = Date.now();
    const t = setTimeout(closeGacha, gachaRemaining.current);
    return () => {
      clearTimeout(t);
      gachaRemaining.current = Math.max(0, gachaRemaining.current - (Date.now() - startedAt));
    };
  }, [showGacha, gachaPaused, closeGacha]);

  // hard safety cap — closes by GACHA_MAX_OPEN_MS no matter what (never stuck open, even if left paused)
  useEffect(() => {
    if (!showGacha) return;
    const hard = setTimeout(closeGacha, GACHA_MAX_OPEN_MS);
    return () => clearTimeout(hard);
  }, [showGacha, closeGacha]);

  const pauseGacha = () => setGachaPaused(true);
  const resumeGacha = () => setGachaPaused(false);

  // a11y: focus the dialog on open, ESC closes, and Tab is trapped inside it (so aria-modal is honoured)
  useEffect(() => {
    if (!showGacha) return;
    const dialog = gachaDialogRef.current;
    const onKey = (e) => {
      if (e.key === 'Escape') { closeGacha(); return; }
      if (e.key === 'Tab' && dialog) {
        const f = dialog.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    dialog?.focus({ preventScroll: true }); // don't scroll a too-tall modal off the top on short viewports
    return () => document.removeEventListener('keydown', onKey);
  }, [showGacha, closeGacha]);

  // both CTAs (and the banner + nav entry) land on the games page; if signed out, the games/gacha flow there
  // prompts a wallet connect / sign-in — same gate as the rest of the app
  const goToGacha = (e) => { e?.preventDefault(); navigate('/exchange#games'); };
  const playGacha = () => { closeGacha(); navigate('/exchange#games'); };
  const dismissBanner = () => { setBannerDismissed(true); setSeen(GACHA_BANNER_KEY); };

  const enter = (e) => {
    e?.preventDefault();
    navigate('/exchange');
  };
  const goDocs = (e) => {
    e?.preventDefault();
    navigate('/docs');
  };
  const scrollTo = (id) => (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className={`lp ${chatOpen ? 'lp-chat-open' : ''}`}>
      <ChatSidebar open={chatOpen} onToggle={onToggleChat} />

      {bannerOpen && (
        <div className="lp-gacha-banner" role="region" aria-label="Announcement">
          <span className="lp-gb-txt">
            <span className="lp-gb-star" aria-hidden="true">✦</span> <strong>Classic Gacha is live.</strong> Open
            real graded-card packs from Collector Crypt.
          </span>
          <button className="lp-gb-cta" onClick={goToGacha}>Open a pack ▶</button>
          <button className="lp-gb-x" onClick={dismissBanner} aria-label="Dismiss announcement">✕</button>
        </div>
      )}

      <header className="lp-nav">
        <div className="lp-nav-left">
          <a className="lp-brand" href="#" onClick={enter}>
            <Wordmark />
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
          <a href="/docs" onClick={goDocs}>DOCS</a>
          {gachaLive && (
            <a className="lp-nav-gacha" href="/exchange#games" onClick={goToGacha}>
              GACHA<span className="lp-new-badge">new</span>
            </a>
          )}
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
          <div className="lp-kicker" data-reveal style={{ '--i': 0 }}>· TCG CARD PERPS · ON SOLANA</div>
          <h1 className="lp-h1" data-reveal style={{ '--i': 1 }}>
            GO <span className="lp-swap">{CYCLE[w]}</span><br />ON EVERY CARD.
          </h1>
          <p className="lp-sub" data-reveal style={{ '--i': 2 }}>
            Leveraged perpetuals on Pokémon &amp; TCG card prices. Real USDC, on Solana,
            and <strong>every market tradeable</strong> from day one.
          </p>
          <div className="lp-cta-row" data-reveal style={{ '--i': 3 }}>
            <button className="lp-btn lp-btn-lg" onClick={enter}>GO TO EXCHANGE ▸</button>
            <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#how" onClick={scrollTo('how')}>HOW IT WORKS</a>
          </div>
          <div className="lp-trust" data-reveal style={{ '--i': 4 }}>NO SIGN-UP · YOUR KEYS · LONG OR SHORT</div>
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
                <div className="lp-screen-tag">CHARIZARD <span className="lp-screen-up">+312%</span></div>
                <svg viewBox="0 0 270 120" preserveAspectRatio="none" className="lp-chart">
                  <defs>
                    <linearGradient id="lp-chart-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="var(--cyan, #22D3EE)" />
                      <stop offset="100%" stopColor="var(--success, #34D399)" />
                    </linearGradient>
                    <filter id="lp-chart-glow"><feGaussianBlur stdDeviation="2.5" /></filter>
                  </defs>
                  <polyline className="lp-line-glow" points="0,95 30,80 55,88 80,60 110,68 140,40 170,50 200,22 230,30 260,8"
                    fill="none" stroke="url(#lp-chart-grad)" strokeWidth="5" opacity="0.5" filter="url(#lp-chart-glow)" />
                  <polyline className="lp-line-main" points="0,95 30,80 55,88 80,60 110,68 140,40 170,50 200,22 230,30 260,8"
                    fill="none" stroke="url(#lp-chart-grad)" strokeWidth="2.5" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* TICKER */}
      <div className="lp-ticker" aria-hidden="true">
        <div className="lp-ticker-track">
          {[...TICKER, ...TICKER].map((t, i) => (
            <span key={i} className="lp-ticker-item">{t}<span className="lp-spark">◆</span></span>
          ))}
        </div>
      </div>

      {/* CONTRACT ADDRESS */}
      <section className="lp-ca">
        <span className="lp-ca-label">· CONTRACT</span>
        <code className="lp-ca-addr">{CONTRACT_ADDRESS}</code>
        <button className="lp-ca-copy" onClick={copyCa}>{copied ? '✓ COPIED' : '📋 COPY'}</button>
      </section>

      {/* HOW IT WORKS */}
      <section className="lp-section" id="how">
        <h2 className="lp-h2" data-reveal>THREE MOVES TO YOUR FIRST TRADE</h2>
        <div className="lp-steps">
          <div className="lp-steps-line" data-reveal-line aria-hidden="true" />
          {STEPS.map(([n, title, body], idx) => (
            <div className="lp-step" data-reveal style={{ '--i': idx }} key={n}>
              <div className="lp-step-num">{n}</div>
              <h3 className="lp-h3">{title}</h3>
              <p className="lp-body">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES */}
      <section className="lp-section lp-section-alt" id="why">
        <h2 className="lp-h2" data-reveal>BUILT FOR SPECULATORS &amp; COLLECTORS</h2>
        <div className="lp-features">
          {FEATURES.map(([icon, title, body], idx) => (
            <div className="lp-feature" data-reveal style={{ '--i': idx }} key={title}>
              <div className="lp-feature-icon"><img src={`/icons/${icon}`} alt="" loading="lazy" /></div>
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
        <h2 className="lp-h2" data-reveal>EVERYTHING YOU NEED TO KNOW</h2>
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
        <h2 className="lp-h2" data-reveal>READY PLAYER ONE?</h2>
        <p className="lp-body">Insert a coin and take your first position.</p>
        <button className="lp-btn lp-btn-lg" onClick={enter}>▶ ENTER THE ARCADE</button>
      </section>

      <footer className="lp-footer">
        <Wordmark />
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

      {/* Launch spotlight — shows once, auto-closes after a readable beat (pauses on hover), ESC/✕/"maybe
          later" close it immediately. Gated on the live flag + show-once via localStorage. */}
      {showGacha && (
        <div className="lp-gacha-scrim" onClick={(e) => { if (e.target === e.currentTarget) closeGacha(); }}>
          <div
            className="lp-gacha-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lp-gacha-h"
            ref={gachaDialogRef}
            tabIndex={-1}
            onMouseEnter={pauseGacha}
            onMouseLeave={resumeGacha}
          >
            <button className="lp-gacha-x" onClick={closeGacha} aria-label="Close">✕</button>
            <div className="lp-gacha-stage" aria-hidden="true">
              {GACHA_DROP_CARDS.map((c, i) => (
                <img key={c} className="lp-gacha-drop" style={{ '--n': i }} src={`https://images.pokemontcg.io/${c}.png`} alt="" loading="lazy" />
              ))}
              <img className="lp-gacha-machine" src="/games/classic-gacha.png" alt="" />
            </div>
            <div className="lp-gacha-body">
              <div className="lp-gacha-kicker">✦ Now live on GachaDex</div>
              <h2 className="lp-gacha-h" id="lp-gacha-h">GACHA PACKS <span className="lp-swap">HERE!</span></h2>
              <p className="lp-gacha-p">
                Open real <strong>graded-card packs</strong> from the Collector Crypt vault. Pull a card, then{' '}
                <strong>sell it back for USDC</strong> or keep it in your inventory.
              </p>
              <div className="lp-gacha-actions">
                <button className="lp-btn lp-btn-lg" onClick={playGacha}>OPEN A PACK ▶</button>
                <button className="lp-btn lp-btn-ghost lp-btn-lg" onClick={playGacha}>SEE THE MACHINES</button>
              </div>
              <button className="lp-gacha-later" onClick={closeGacha}>Maybe later</button>
            </div>
            <div className={`lp-gacha-bar ${gachaPaused ? 'paused' : ''}`} style={{ '--dur': `${GACHA_AUTO_CLOSE_MS}ms` }} aria-hidden="true" />
          </div>
        </div>
      )}
    </div>
  );
}
