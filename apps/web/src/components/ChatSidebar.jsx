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

// BIG BET (gold) / BIG WIN (green) action bar — a trade broadcast that persists inline in the rail.
function ActionBar({ m }) {
  const meta = m.meta || {};
  const win = meta.variant === 'big_win';
  const side = String(meta.side || '').toUpperCase();
  const roe = meta.roeBps != null ? `+${Math.round(meta.roeBps / 100)}%` : null;
  return (
    <div className={`chat-event ${win ? 'big-win' : 'big-bet'}`}>
      <span className="chat-event-tag">{win ? '🏆 BIG WIN' : '🔥 BIG BET'}</span>
      <span className="chat-event-body">
        <b>{m.handle}</b>{' '}
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

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState(null); // { id, handle, body } | null
  const [me, setMe] = useState(null); // { username, handle }
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [nameErr, setNameErr] = useState(null);
  const [nameBusy, setNameBusy] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);

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
            if (m.kind === 'event') return <ActionBar key={m.id} m={m} />;
            const mine = m.userId === user?.id;
            const hColor = colorFor(m.handle);
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
                    <span className="chat-time">{fmtTime(m.createdAt)}</span>
                    {user && (
                      <button className="chat-reply-btn" title="Reply" onClick={() => setReplyTo({ id: m.id, handle: m.handle, body: m.body })}>↩</button>
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
      ) : (
        <div className="chat-input">
          {user ? (
            <>
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
            </>
          ) : (
            <div className="chat-signin">Connect &amp; sign in to chat.</div>
          )}
        </div>
      )}
    </aside>
  );
}
