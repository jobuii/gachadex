import { useState, useEffect, useCallback } from 'react';
import { formatUsd, shortenPubkey } from '@pokex/pricing';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAuth } from '../auth/AuthContext';
import { useChat } from '../store/chat';
import { useCopy } from '../lib/useCopy.js';
import { avatarSrc, avatarFallback } from '../lib/avatar.js';
import { AvatarPicker } from './AvatarPicker';
import * as api from '../lib/api.js';

// Portfolio header: avatar (click to change), username (click to rename — reuses /me/username), wallet, and
// a slim strip of DEX stats. The avatar + username flow the same identity that shows in chat.
export function ProfileBanner({ balance }) {
  const { user } = useAuth();
  const { publicKey } = useWallet();
  const [profile, setProfile] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editName, setEditName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { copied, copy } = useCopy(1200);
  const relabel = useChat((s) => s.relabel);

  const load = useCallback(() => {
    if (user) api.getProfile().then(setProfile).catch(() => {});
  }, [user]);
  useEffect(() => { load(); }, [load]);

  if (!user) return null;
  const pk = publicKey?.toBase58() ?? '';
  const av = avatarSrc(profile?.avatar, user.id);
  const handle = profile?.username || profile?.handle || shortenPubkey(pk);
  const realized = profile ? BigInt(profile.realizedE6) : null;

  const pickAvatar = async (path) => {
    setBusy(true); setErr(null);
    try {
      await api.setAvatar(path);
      setProfile((p) => ({ ...p, avatar: path }));
      window.dispatchEvent(new Event('profile:changed')); // let chat update the composer avatar immediately
      setPickerOpen(false);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  // Chat color is a secondary attribute — apply it in place and keep the picker open (they may also pick a
  // sprite). New chat messages + the composer pick it up immediately (profile:changed re-reads the profile).
  const pickColor = async (c) => {
    setBusy(true); setErr(null);
    try {
      await api.setColor(c);
      setProfile((p) => ({ ...p, color: c }));
      window.dispatchEvent(new Event('profile:changed'));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name || name === profile?.username) { setEditName(false); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.setUsername(name);
      setProfile((p) => ({ ...p, username: r.username, handle: r.username }));
      relabel(user.id, r.username); // re-label my already-rendered chat rows instantly (same as the chat editor)
      window.dispatchEvent(new Event('profile:changed')); // and refresh the chat composer's own handle
      setEditName(false);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="pf-banner">
      <div aria-hidden className="pf-banner-glow" />

      <button className="pf-avatar" onClick={() => setPickerOpen(true)} title="Change avatar" disabled={busy}>
        <img src={av} alt="Your avatar" className="pf-avatar-img" onError={avatarFallback(user.id)} />
        <span className="pf-avatar-overlay">Change</span>
      </button>

      <div className="pf-identity">
        <p className="pf-eyebrow">Player Profile</p>
        {editName ? (
          <div className="pf-name-edit">
            <input
              autoFocus className="wallet-input" value={nameDraft} maxLength={20} placeholder="username"
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditName(false); }}
            />
            <button className="btn-primary sm" disabled={busy} onClick={saveName}>{busy ? '…' : 'Save'}</button>
            <button className="btn-ghost sm" onClick={() => setEditName(false)}>Cancel</button>
          </div>
        ) : (
          <button
            className="pf-name" title="Change username"
            onClick={() => { setNameDraft(profile?.username ?? ''); setEditName(true); }}
          >
            <h1>{handle}</h1>
            <span className="pf-name-pencil" aria-hidden>✎</span>
          </button>
        )}
        <button className="pf-wallet" onClick={() => pk && copy(pk)} title="Copy wallet address">
          <span className="pf-wallet-k">Wallet</span>
          <span className="pf-wallet-v">{shortenPubkey(pk)}</span>
          <span className="pf-wallet-copy">{copied ? '✓' : '⧉'}</span>
        </button>
        {err && <div className="order-error pf-err">{err}</div>}
      </div>

      <div className="pf-stats">
        <div className="pf-stat">
          <span className="pf-stat-k">Equity</span>
          <span className="pf-stat-v">{balance?.equityUusdc != null ? formatUsd(BigInt(balance.equityUusdc)) : '—'}</span>
        </div>
        <div className="pf-stat">
          <span className="pf-stat-k">Realized P&amp;L</span>
          <span className={`pf-stat-v ${realized == null ? '' : realized < 0n ? 'down' : 'up'}`}>
            {realized == null ? '—' : formatUsd(realized)}
          </span>
        </div>
        <div className="pf-stat">
          <span className="pf-stat-k">Volume</span>
          <span className="pf-stat-v">{profile ? formatUsd(BigInt(profile.volumeE6)) : '—'}</span>
        </div>
        <div className="pf-stat">
          <span className="pf-stat-k">Rank</span>
          <span className="pf-stat-v">{profile?.rank ? `#${profile.rank}` : '—'}</span>
        </div>
      </div>

      {pickerOpen && (
        <AvatarPicker current={profile?.avatar} color={profile?.color} onPick={pickAvatar} onPickColor={pickColor} onClose={() => setPickerOpen(false)} busy={busy} />
      )}
    </div>
  );
}
