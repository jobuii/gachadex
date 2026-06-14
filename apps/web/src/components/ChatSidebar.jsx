import { useState, useEffect, useRef } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useAuth } from '../auth/AuthContext';
import { useChat } from '../store/chat';
import * as api from '../lib/api.js';

const PALETTE = ['#f0c040', '#3fb950', '#58a6ff', '#e74c3c', '#bc8cff', '#f78166', '#39d3bb'];
function colorFor(handle) {
  let h = 0;
  for (let i = 0; i < (handle || '').length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
const snippet = (s) => (s.length > 48 ? `${s.slice(0, 48)}…` : s);
const usd0 = (e6) => formatUsd(BigInt(e6 ?? 0), { decimals: 0 }); // tolerate a missing field rather than blank the rail

// leaderboard rank -> badge tier (ascending cutoff; first the rank fits wins). Only the top 100 earn one.
const RANK_TIERS = [
  { max: 1, cls: 'r1', label: '👑 #1' },
  { max: 2, cls: 'r2', label: '🥈 #2' },
  { max: 3, cls: 'r3', label: '🥉 #3' },
  { max: 10, cls: 'top10', label: 'TOP 10' },
  { max: 100, cls: 'top100', label: 'TOP 100' },
];
function rankBadgeFor(rank) {
  return rank ? (RANK_TIERS.find((t) => rank <= t.max) ?? null) : null;
}
function RankBadge({ rank }) {
  const b = rankBadgeFor(rank);
  if (!b) return null;
  return <span className={`chat-rank ${b.cls}`} title={`Leaderboard rank #${rank}`}>{b.label}</span>;
}

// BIG BET (gold) / BIG WIN (green) action bar — a trade broadcast that persists inline in the rail.
function ActionBar({ m, rank, isMod, onDelete }) {
  const meta = m.meta || {};
  const win = meta.variant === 'big_win';
  const side = String(meta.side || '').toUpperCase();
  const roe = meta.roeBps != null ? `+${Math.round(meta.roeBps / 100)}%` : null;
  return (
    <div className={`chat-event ${win ? 'big-win' : 'big-bet'}`}>
      <span className="chat-event-tag">
        {win ? '🏆 BIG WIN' : '🔥 BIG BET'}
        {isMod && <button className="chat-mod-btn chat-mod-del chat-event-del" title="Delete" onClick={onDelete}>✕</button>}
      </span>
      <span className="chat-event-body">
        <b>{m.handle}</b><RankBadge rank={rank} />{m.isMod ? <span className="chat-mod-chip">MOD</span> : null}{' '}
        {win ? (
          <>won <b>{usd0(meta.pnlE6)}</b>{roe && <b className="chat-event-roe"> {roe}</b>}</>
        ) : (
          <>opened <b>{usd0(meta.notionalE6)}</b></>
        )}{' '}
        <span className={`chat-event-side ${side.toLowerCase()}`}>{side}</span> on <b>{meta.marketName}</b>
      </span>
    </div>
  );
}

// render @mentions as highlighted chips; a mention of your own username gets a stronger highlight
function renderBody(body, myName) {
  return body.split(/(@[A-Za-z0-9_-]+)/g).map((part, i) => {
    if (/^@[A-Za-z0-9_-]+$/.test(part)) {
      const me = myName && part.slice(1).toLowerCase() === myName.toLowerCase();
      return <span key={i} className={`chat-mention ${me ? 'me' : ''}`}>{part}</span>;
    }
    return <span key={i}>{part}</span>;
  });
}

export function ChatSidebar({ open, onToggle }) {
  const { user } = useAuth();
  const messages = useChat((s) => s.messages);
  const markRead = useChat((s) => s.markRead);
  const send = useChat((s) => s.send);
  const relabel = useChat((s) => s.relabel);
  const modState = useChat((s) => s.modState); // live mute/ban snapshots (userId -> {mutedUntil, banned})
  const ranks = useChat((s) => s.ranks); // userId -> leaderboard rank (top 100) for rank badges

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState(null); // { id, handle, body } | null
  const [me, setMe] = useState(null); // { username, handle }
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [nameErr, setNameErr] = useState(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [modMsg, setModMsg] = useState(null); // transient confirmation banner for mod actions
  const [now, setNow] = useState(() => Date.now()); // ticks so the "muted — N min left" countdown stays live
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const modMsgTimer = useRef(null);

  // load my chat profile (username + handle) when signed in
  useEffect(() => {
    if (!user) {
      setMe(null);
      return;
    }
    let alive = true;
    api.getProfile().then((p) => alive && setMe(p)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [user]);

  useEffect(() => {
    if (open) markRead();
  }, [open, messages, markRead]);

  useEffect(() => {
    const el = listRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const tag = (handle) => {
    if (!/^[A-Za-z0-9_-]+$/.test(handle)) return; // only username handles are taggable (a truncated pubkey isn't)
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@${handle} `);
    inputRef.current?.focus();
  };

  const openNameEditor = () => {
    setNameInput(me?.username ?? '');
    setNameErr(null);
    setEditingName(true);
  };

  // clicking your own icon edits your username; clicking someone else's tags them
  const onIdentity = (m) => (m.userId === user?.id ? openNameEditor() : tag(m.handle));

  const onSend = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await send(body, replyTo?.id);
      setText('');
      setReplyTo(null);
    } catch {
      /* keep it simple */
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    const name = nameInput.trim();
    if (name.length < 3) return;
    setNameErr(null);
    setNameBusy(true);
    try {
      const r = await api.setUsername(name);
      setMe((p) => ({ ...(p || {}), username: r.username, handle: r.username }));
      if (user) relabel(user.id, r.username);
      setEditingName(false);
    } catch (e) {
      setNameErr(e.message);
    } finally {
      setNameBusy(false);
    }
  };

  const isMod = !!me?.isMod;
  const flash = (msg) => {
    setModMsg(msg);
    if (modMsgTimer.current) clearTimeout(modMsgTimer.current); // a newer toast cancels the prior auto-clear
    modMsgTimer.current = setTimeout(() => setModMsg(null), 3000);
  };
  // run a mod action then confirm (or surface the error). The resulting mute/ban/delete propagates via WS.
  const modAct = async (label, fn) => {
    try { await fn(); flash(label); } catch (e) { flash(e?.message || 'Action failed'); }
  };
  const muteLeftMin = (until) => { const ms = until ? new Date(until).getTime() - now : 0; return ms > 0 ? Math.ceil(ms / 60000) : 0; };
  // effective mute/ban for a user: a live modState snapshot wins over the seed baked into the message/profile.
  const effFor = (userId, seedUntil, seedBanned) => {
    const s = userId ? modState[userId] : null;
    return s ? { mutedUntil: s.mutedUntil, banned: s.banned } : { mutedUntil: seedUntil ?? null, banned: !!seedBanned };
  };
  const self = effFor(user?.id, me?.mutedUntil, me?.banned);
  const selfMutedMin = muteLeftMin(self.mutedUntil);
  const selfMuted = selfMutedMin > 0;
  const selfBanned = self.banned;

  if (!open) return null; // the navbar "Chat" button is the reopen control

  return (
    <aside className="chat-sidebar">
      <div className="chat-header">
        <span className="chat-title">▣ Live Chat</span>
        <button className="chat-collapse" onClick={onToggle} title="Hide chat" aria-label="Hide chat">◀</button>
      </div>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">No messages yet.<br />Say hi 👋</div>
        ) : (
          messages.map((m) => {
            if (m.kind === 'event') return <ActionBar key={m.id} m={m} rank={ranks[m.userId]} isMod={isMod} onDelete={() => modAct('Message deleted', () => api.chatDelete(m.id))} />;
            const mine = m.userId === user?.id;
            const hColor = colorFor(m.handle);
            const aState = effFor(m.userId, m.authorMutedUntil, m.authorBanned);
            const aMuted = muteLeftMin(aState.mutedUntil) > 0;
            const aBanned = aState.banned;
            return (
              <div key={m.id} className="chat-msg">
                <span
                  className="chat-avatar"
                  style={{ background: hColor }}
                  onClick={() => onIdentity(m)}
                  title={mine ? 'Edit your username' : `Tag ${m.handle}`}
                >
                  {m.handle?.[0]?.toUpperCase()}
                </span>
                <div className="chat-msg-main">
                  <div className="chat-msg-head">
                    <span className="chat-handle" style={{ color: hColor }} onClick={() => onIdentity(m)}>
                      {m.handle}
                    </span>
                    <RankBadge rank={ranks[m.userId]} />
                    {m.isMod && <span className="chat-mod-chip" title="Moderator">MOD</span>}
                    <span className="chat-time">{fmtTime(m.createdAt)}</span>
                    {user && (
                      <button className="chat-reply-btn" title="Reply" onClick={() => setReplyTo({ id: m.id, handle: m.handle, body: m.body })}>↩</button>
                    )}
                    {isMod && (
                      <span className="chat-mod-tools">
                        <button className="chat-mod-btn chat-mod-del" title="Delete message" onClick={() => modAct('Message deleted', () => api.chatDelete(m.id))}>✕</button>
                        {!mine && !m.isMod && (
                          <>
                            {aMuted ? (
                              <button className="chat-mod-btn" title="Unmute" onClick={() => modAct(`Unmuted ${m.handle}`, () => api.chatUnmute(m.userId))}>🔊</button>
                            ) : (
                              <button className="chat-mod-btn" title="Mute 60m" onClick={() => modAct(`Muted ${m.handle} for 60m`, () => api.chatMute(m.userId))}>🔇</button>
                            )}
                            {aBanned ? (
                              <button className="chat-mod-btn" title="Unban" onClick={() => modAct(`Unbanned ${m.handle}`, () => api.chatUnban(m.userId))}>♻️</button>
                            ) : (
                              <button className="chat-mod-btn" title="Ban from chat" onClick={() => { if (window.confirm(`Ban ${m.handle} from chat?`)) modAct(`Banned ${m.handle}`, () => api.chatBan(m.userId)); }}>🚫</button>
                            )}
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  {m.replyTo && (
                    <div className="chat-quote">↳ <b>{m.replyTo.handle}</b> {snippet(m.replyTo.body)}</div>
                  )}
                  <div className="chat-text">{renderBody(m.body, me?.username)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {replyTo && (
        <div className="chat-reply-banner">
          <span>↩ Replying to <b>{replyTo.handle}</b>: {snippet(replyTo.body)}</span>
          <button onClick={() => setReplyTo(null)} title="Cancel reply">×</button>
        </div>
      )}

      {modMsg && <div className="chat-modmsg">{modMsg}</div>}

      {user && editingName ? (
        <div className="chat-name-editor">
          <span className="chat-name-label">YOUR USERNAME</span>
          <div className="chat-name-row">
            <input
              type="text"
              value={nameInput}
              maxLength={20}
              placeholder="username"
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
            />
            <button className="btn-primary sm" disabled={nameBusy || nameInput.trim().length < 3} onClick={saveName}>{nameBusy ? '…' : 'Save'}</button>
            <button className="btn-secondary sm" onClick={() => { setEditingName(false); setNameErr(null); }}>Cancel</button>
          </div>
          {nameErr && <div className="order-error">{nameErr}</div>}
        </div>
      ) : !user ? (
        <div className="chat-input"><div className="chat-signin">Connect &amp; sign in to chat.</div></div>
      ) : selfBanned ? (
        <div className="chat-blocked banned">🚫 You are banned from chat.</div>
      ) : selfMuted ? (
        <div className="chat-blocked muted">🔇 You're muted — {selfMutedMin} min left.</div>
      ) : (
        <div className="chat-input">
          <span
            className="chat-avatar chat-me-avatar"
            style={{ background: me?.handle ? colorFor(me.handle) : 'var(--border)' }}
            onClick={openNameEditor}
            title="Change your username"
          >
            {me?.handle?.[0]?.toUpperCase() ?? '?'}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={text}
            maxLength={280}
            placeholder="Message…  (@ to tag)"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }}
          />
          <button className="btn-primary sm" disabled={busy || !text.trim()} onClick={onSend}>{busy ? '…' : 'Send'}</button>
        </div>
      )}
    </aside>
  );
}
