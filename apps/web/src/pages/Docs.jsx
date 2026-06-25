import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Wordmark } from '../components/Brand';
import { DOC_SECTIONS } from '../docs/index.js';

// The /docs page: our full-width app shell (left section rail · markdown content · on-this-page rail).
// Single scrolling column; the left rail scroll-spies the section in view and deep-links via the URL hash.

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
const flatten = (c) => (Array.isArray(c) ? c.map(flatten).join('') : typeof c === 'string' ? c : '');
// give headings stable ids so the on-this-page rail (and #anchors) can target them
const MD = {
  h2: ({ children }) => <h2 id={slugify(flatten(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slugify(flatten(children))}>{children}</h3>,
};
// Extract a section's ## / ### headings for the on-this-page rail. Keep doc headings PLAIN TEXT — this slug
// must match the id slugify() gives the rendered heading (MD above); inline markdown (links/code) would diverge.
const headingsOf = (md) =>
  [...md.matchAll(/^(#{2,3})\s+(.+)$/gm)].map((m) => {
    const text = m[2].replace(/[*_`]/g, '').trim();
    return { level: m[1].length, text, slug: slugify(text) };
  });

export function Docs() {
  const navigate = useNavigate();
  const [active, setActive] = useState(DOC_SECTIONS[0].id);
  const toc = useMemo(() => headingsOf(DOC_SECTIONS.find((s) => s.id === active)?.content || ''), [active]);

  // scroll-spy: the topmost in-view section is active
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const inView = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (inView[0]) setActive(inView[0].target.id);
      },
      { rootMargin: '-12% 0px -72% 0px' },
    );
    DOC_SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, []);

  // jump to the hash target on load (so /docs#trading lands there)
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, '');
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    window.history.replaceState(null, '', `${window.location.pathname}#${id}`);
  };

  return (
    <div className="docs">
      <header className="docs-top">
        <button className="docs-brand" onClick={() => navigate('/')} aria-label="GachaDex home">
          <Wordmark />
          <em>docs</em>
        </button>
        <button className="docs-launch" onClick={() => navigate('/exchange')}>
          Launch app ▶
        </button>
      </header>

      <div className="docs-body">
        <nav className="docs-nav" aria-label="Documentation sections">
          {DOC_SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`docs-nav-link ${active === s.id ? 'active' : ''}`}
              aria-current={active === s.id ? 'true' : undefined}
              onClick={() => {
                setActive(s.id);
                scrollTo(s.id);
              }}
            >
              {s.title}
            </button>
          ))}
        </nav>

        <main className="docs-content">
          {DOC_SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="docs-section">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
                {s.content}
              </ReactMarkdown>
            </section>
          ))}
          <footer className="docs-foot">
            <span>GachaDex — trading-card prices as a tradeable asset class.</span>
            <button className="btn-ghost sm" onClick={() => navigate('/exchange')}>
              Launch app →
            </button>
          </footer>
        </main>

        <aside className="docs-toc" aria-label="On this page">
          {toc.length > 0 && (
            <>
              <span className="docs-toc-label">On this page</span>
              {toc.map((h) => (
                <button key={h.slug} className={`docs-toc-link lvl${h.level}`} onClick={() => scrollTo(h.slug)}>
                  {h.text}
                </button>
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
