import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAuth } from '../auth/AuthContext';
import { avatarSrc, avatarFallback } from '../lib/avatar.js';
import { AvatarPicker } from './AvatarPicker';
import * as api from '../lib/api.js';

const shortPk = (pk) => (pk ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : '');

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
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    if (user) api.getProfile().then(setProfile).catch(() => {});
  }, [user]);
  useEffect(() => { load(); }, [load]);

  if (!user) return null;
  const pk = publicKey?.toBase58() ?? '';
  const av = avatarSrc(profile?.avatar, user.id);
  const handle = profile?.username || profile?.handle || shortPk(pk);
  const realized = profile ? BigInt(profile.realizedE6) : null;

  const pickAvatar = async (path) => {
    setBusy(true); setErr(null);
    try {
      await api.setAvatar(path);
      setProfile((p) => ({ ...p, avatar: path }));
      setPickerOpen(false);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name || name === profile?.username) { setEditName(false); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.setUsername(name);
      setProfile((p) => ({ ...p, username: r.username, handle: r.username }));
      setEditName(false);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const copyPk = () => {
    if (!pk) return;
    navigator.clipboard?.writeText(pk);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
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
        <button className="pf-wallet" onClick={copyPk} title="Copy wallet address">
          <span className="pf-wallet-k">Wallet</span>
          <span className="pf-wallet-v">{shortPk(pk)}</span>
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
        <AvatarPicker current={profile?.avatar} onPick={pickAvatar} onClose={() => setPickerOpen(false)} busy={busy} />
      )}
    </div>
  );
}
