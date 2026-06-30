import { useState, useEffect, useRef } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { shortenPubkey } from '@pokex/pricing';
import { useAuth } from '../auth/AuthContext';
import * as api from '../lib/api.js';
import { avatarSrc, avatarFallback } from '../lib/avatar.js';
import { useCopy } from '../lib/useCopy.js';

export function AuthButton() {
  const { user, login, logout, loading, error, walletConnected, pubkey } = useAuth();
  const [profile, setProfile] = useState(null);
  const [open, setOpen] = useState(false);
  const pillRef = useRef(null);
  const menuRef = useRef(null);
  const { copied, copy } = useCopy(1200);

  // Profile = the same identity (avatar + username) shown in chat and the Portfolio banner. The `alive`
  // flag drops a late response if the user changed (or unmounted) before it landed.
  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    api.getProfile().then((p) => { if (alive) setProfile(p); }).catch(() => {});
    return () => { alive = false; };
  }, [user]);

  // Dropdown dismissal — outside-tap + Esc (tap-triggered, works on touch). Closes itself when the
  // wallet/session goes away too.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target) && !pillRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); pillRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!walletConnected) return <WalletMultiButton />;

  if (!user) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end' }}>
        <button className="btn-primary" disabled={loading} onClick={() => login().catch(() => {})}>
          {loading ? 'Signing…' : 'Sign In'}
        </button>
        {error && (
          <div style={{ fontSize: '12px', color: '#ff6b6b', maxWidth: '200px', textAlign: 'right' }}>
            {error}
          </div>
        )}
      </div>
    );
  }

  const shortAddr = shortenPubkey(pubkey);
  const handle = profile?.username || profile?.handle || shortAddr;
  const av = avatarSrc(profile?.avatar, user.id);

  return (
    <div className="acct">
      <button
        type="button"
        ref={pillRef}
        className={`acct-pill ${open ? 'open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Account: ${handle}`}
        onClick={() => setOpen((o) => !o)}
      >
        <img className="acct-av" src={av} onError={avatarFallback(user.id)} alt="" />
        <span className="acct-handle">{handle}</span>
        <span className="acct-caret" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
        </span>
      </button>

      {open && (
        <div className="acct-menu" ref={menuRef} role="dialog" aria-label="Account">
          <div className="acct-head">
            <img className="acct-head-av" src={av} onError={avatarFallback(user.id)} alt="" />
            <div className="acct-head-meta">
              <div className="acct-head-name">{handle}</div>
              <div className="acct-head-addr">{shortAddr} · Solana</div>
            </div>
          </div>

          <button type="button" className="acct-copy" onClick={() => copy(pubkey)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            <span className="acct-copy-addr">{shortAddr}</span>
            <span className="acct-copy-net">{copied ? 'Copied!' : 'SOL'}</span>
          </button>

          <button type="button" className="acct-disconnect" onClick={() => { setOpen(false); logout(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
