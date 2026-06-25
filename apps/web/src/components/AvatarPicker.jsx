import { useState, useMemo } from 'react';
import { AVATAR_DEX_MAX } from '../lib/avatar.js';

// Modal grid of the bundled gen 1–5 sprites. Default / shiny toggle + search by Pokédex number. Picking
// one calls onPick(path) where path is 'default/<n>.png' | 'shiny/<n>.png'.
export function AvatarPicker({ current, onPick, onClose, busy }) {
  const [variant, setVariant] = useState(current?.startsWith('shiny/') ? 'shiny' : 'default');
  const [q, setQ] = useState('');

  const nums = useMemo(() => {
    const all = Array.from({ length: AVATAR_DEX_MAX }, (_, i) => i + 1);
    return q ? all.filter((n) => String(n).includes(q)) : all;
  }, [q]);

  return (
    <div className="avatar-modal-backdrop" onClick={onClose}>
      <div className="avatar-modal" onClick={(e) => e.stopPropagation()}>
        <div className="avatar-modal-head">
          <h3>Choose your avatar</h3>
          <button className="avatar-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="avatar-modal-controls">
          <div className="avatar-variant-toggle">
            <button type="button" className={variant === 'default' ? 'on' : ''} onClick={() => setVariant('default')}>Default</button>
            <button type="button" className={variant === 'shiny' ? 'on' : ''} onClick={() => setVariant('shiny')}>✨ Shiny</button>
          </div>
          <input
            className="avatar-search wallet-input" type="text" inputMode="numeric" placeholder="Search #…"
            value={q} onChange={(e) => setQ(e.target.value.replace(/[^\d]/g, ''))}
          />
        </div>
        <div className="avatar-grid">
          {nums.map((n) => {
            const path = `${variant}/${n}.png`;
            return (
              <button
                key={n}
                type="button"
                className={`avatar-cell ${current === path ? 'sel' : ''}`}
                disabled={busy}
                title={`#${n}`}
                onClick={() => onPick(path)}
              >
                <img
                  src={`/avatars/${path}`}
                  alt={`#${n}`}
                  loading="lazy"
                  onError={(e) => { e.currentTarget.parentElement.style.display = 'none'; }}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
