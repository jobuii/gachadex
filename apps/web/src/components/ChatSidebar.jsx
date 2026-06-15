import { useState, useEffect, useRef, useMemo } from 'react';
import { formatUsd } from '@pokex/pricing';
import { CHAT_REACTIONS } from '@pokex/shared-types';
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
// a broader emoji set for composing messages (client-only — message bodies are free text)
const COMPOSE_EMOJIS = ['😀', '😂', '😍', '😎', '🤔', '😅', '😭', '😡', '🥳', '😱', '💀', '👀', '👍', '👎', '🙏', '👏', '💪', '🔥', '💯', '🚀', '🎉', '❤️', '💔', '✅', '❌', '💰', '📈', '📉', '🐂', '🐻', '🤑', '💎'];

// an in-progress @mention at the caret: the '@' is at the start or after whitespace, then [A-Za-z0-9_-]*.
// returns { query, start } (start = the '@' index) so the partial can be replaced on accept.
function mentionContext(value, caret) {
  const m = value.slice(0, caret).match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  return m ? { query: m[1], start: caret - m[1].length - 1 } : null;
}

// consecutive messages from the same author within 5 min group under one avatar/handle
function isGroupedWith(m, prev) {
  return !!prev && prev.kind !== 'event' && prev.userId === m.userId
    && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000;
}
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

// Profile hover popover: identity + rank badge + volume level. (P/L + volume are returned but hidden for now.)
const cardCache = new Map(); // userId -> profile card (session cache; fine for an ephemeral popover)
function ProfileHoverCard({ hover, onEnter, onLeave }) {
  const [card, setCard] = useState(null);
  useEffect(() => {
    if (!hover) return undefined;
    const cached = cardCache.get(hover.userId);
    if (cached) { setCard(cached); return undefined; }
    setCard(null);
    let alive = true;
    api.getProfileCard(hover.userId)
      .then((c) => { cardCache.set(hover.userId, c); if (alive) setCard(c); })
      .catch(() => {});
    return () => { alive = false; };
  }, [hover]);
  if (!hover) return null;
  return (
    <div className="chat-profile-card" style={{ top: hover.top, left: hover.left }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {card ? (
        <>
          <div className="chat-profile-head">
            <span className="chat-avatar" style={{ background: colorFor(card.handle) }}>{card.handle?.[0]?.toUpperCase()}</span>
            <span className="chat-profile-handle">{card.handle}</span>
            {card.isMod && <span className="chat-mod-chip">MOD</span>}
          </div>
          <div className="chat-profile-meta">
            <RankBadge rank={card.rank} />
            <span className="chat-profile-level" title={`Volume level ${card.level} of 6`}>LEVEL {card.level}</span>
          </div>
        </>
      ) : (
        <div className="chat-profile-loading">…</div>
      )}
    </div>
  );
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

// Faint GachaDex "G" marks raining behind the DROP banner — varied column/size/speed/delay/opacity so the
// fall looks organic. Kept low-opacity so it never competes with the headline (see .drop-gfall in index.css).
const DROP_GS = [
  { left: '4%', size: 13, dur: '3.4s', delay: '0s', op: 0.12 },
  { left: '17%', size: 20, dur: '5.2s', delay: '1.4s', op: 0.08 },
  { left: '31%', size: 11, dur: '4.0s', delay: '0.6s', op: 0.14 },
  { left: '45%', size: 16, dur: '4.8s', delay: '2.1s', op: 0.1 },
  { left: '59%', size: 12, dur: '3.7s', delay: '0.9s', op: 0.12 },
  { left: '73%', size: 22, dur: '6.0s', delay: '0.2s', op: 0.07 },
  { left: '87%', size: 14, dur: '4.4s', delay: '1.8s', op: 0.11 },
];

export function ChatSidebar({ open, onToggle }) {
  const { user } = useAuth();
  const messages = useChat((s) => s.messages);
  const markRead = useChat((s) => s.markRead);
  const send = useChat((s) => s.send);
  const relabel = useChat((s) => s.relabel);
  const modState = useChat((s) => s.modState); // live mute/ban snapshots (userId -> {mutedUntil, banned})
  const ranks = useChat((s) => s.ranks); // userId -> leaderboard rank (top 100) for rank badges
  const reactMine = useChat((s) => s.reactMine);
  const online = useChat((s) => s.online); // live connected-viewer count

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
  const [hover, setHover] = useState(null); // profile hover card anchor: { userId, top, left }
  const [pickerFor, setPickerFor] = useState(null); // messageId whose reaction picker is open
  const [composePicker, setComposePicker] = useState(false); // the compose-box emoji popup
  const [mention, setMention] = useState(null); // @mention autocomplete: { query, start, items, active } | null
  const [hasNew, setHasNew] = useState(false); // unseen messages while scrolled up -> "new messages" pill
  const [dropOpen, setDropOpen] = useState(false); // the DROP teaser modal (F6 Phase 1: coming soon)
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const modMsgTimer = useRef(null);
  const hoverTimer = useRef(null);
  const atBottomRef = useRef(true); // is the list scrolled to (near) the bottom — drives auto-stick
  const wasOpenRef = useRef(false); // was the rail open last render — detect the open transition

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

  // auto-stick to the bottom on new messages, UNLESS the user has scrolled up (then flag "new messages").
  // Opening the rail jumps to the latest and clears the flag (fresh position on reopen).
  useEffect(() => {
    const el = listRef.current;
    if (!open) { wasOpenRef.current = false; return; }
    if (!el) return;
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setHasNew(false);
      return;
    }
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    else setHasNew(true);
  }, [messages, open]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottomRef.current) setHasNew(false);
  };
  const scrollToBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setHasNew(false);
  };

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // clear any pending toast / hover-close timers when the rail unmounts
  useEffect(() => () => {
    if (modMsgTimer.current) clearTimeout(modMsgTimer.current);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  const tag = (handle) => {
    if (!/^[A-Za-z0-9_-]+$/.test(handle)) return; // only username handles are taggable (a truncated pubkey isn't)
    setMention(null);
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

  // profile hover card: open anchored below the hovered handle; a small close delay lets the cursor
  // travel onto the card without dismissing it.
  const openCard = (userId, e) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const r = e.currentTarget.getBoundingClientRect();
    setHover({ userId, top: Math.round(r.bottom + 4), left: Math.round(r.left) });
  };
  const closeCardSoon = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setHover(null), 150); };
  const cancelClose = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };

  // toggle an emoji reaction: highlight optimistically, then call the API (the WS echo sets the count).
  // On failure, revert the optimistic highlight so it doesn't stick without a matching count.
  const onReact = (m, emoji) => {
    const mine = !(m.myReactions || []).includes(emoji);
    reactMine(m.id, emoji, mine);
    api.reactChat(m.id, emoji).catch(() => reactMine(m.id, emoji, !mine));
  };

  const onSend = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await send(body, replyTo?.id);
      setText('');
      setReplyTo(null);
      setComposePicker(false);
      setMention(null);
    } catch {
      /* keep it simple */
    } finally {
      setBusy(false);
    }
  };

  // insert an emoji into the message at the caret (or append), keeping focus + caret after it
  const insertEmoji = (emoji) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    if (next.length > 280) return; // at the limit — don't insert a partial/broken emoji
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      if (!el) return;
      try { el.focus(); const pos = start + emoji.length; el.setSelectionRange(pos, pos); } catch { /* noop */ }
    });
  };

  // @mention autocomplete — candidates are taggable handles seen in chat (usernames, not the viewer)
  const taggable = useMemo(
    () => [...new Set(messages.map((mm) => mm.handle))].filter((h) => /^[A-Za-z0-9_-]+$/.test(h) && h !== me?.handle),
    [messages, me?.handle],
  );
  const updateMention = (value, caret) => {
    const ctx = mentionContext(value, caret);
    if (!ctx) { setMention(null); return; }
    const q = ctx.query.toLowerCase();
    const items = taggable.filter((h) => h.toLowerCase().includes(q)).slice(0, 6);
    setMention(items.length ? { ...ctx, items, active: 0 } : null);
  };
  const onComposeChange = (e) => { setText(e.target.value); updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length); };
  const acceptMention = (handle) => {
    const caret = inputRef.current?.selectionStart ?? text.length;
    const ctx = mentionContext(text, caret);
    if (!ctx) return;
    const insert = `@${handle} `;
    const next = text.slice(0, ctx.start) + insert + text.slice(caret);
    setText(next);
    setMention(null);
    const pos = ctx.start + insert.length;
    requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(pos, pos); } });
  };
  const onComposeKeyDown = (e) => {
    if (mention) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMention((mm) => mm && { ...mm, active: (mm.active + 1) % mm.items.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMention((mm) => mm && { ...mm, active: (mm.active - 1 + mm.items.length) % mm.items.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptMention(mention.items[mention.active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
    }
    if (e.key === 'Enter') onSend();
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
        <span className="chat-header-left">
          <span className="chat-title">LIVE CHAT</span>
          {online > 0 && <span className="chat-online" title={`${online} online`}>{online}</span>}
        </span>
        <button className="chat-collapse" onClick={onToggle} title="Hide chat" aria-label="Hide chat">◀</button>
      </div>

      {/* DROP teaser bar — pinned under the header. Phase 1: opens a "coming soon" modal (F6). */}
      <button type="button" className="chat-drop-bar" onClick={() => setDropOpen(true)} title="DROP — timed giveaway">
        <span className="drop-gfall" aria-hidden="true">
          {DROP_GS.map((g, i) => (
            <img
              key={i}
              className="drop-g"
              src="/favicon.svg"
              alt=""
              style={{ left: g.left, width: `${g.size}px`, opacity: g.op, animationDuration: g.dur, animationDelay: g.delay }}
            />
          ))}
        </span>
        <span className="drop-headline">
          <span className="drop-pre">It's about to</span>
          <span className="drop-word">DROP</span>
        </span>
        <span className="drop-pill">
          <img src="/GachaDexPFP2.png" alt="" />
          <span>SOON</span>
        </span>
      </button>

      <div className="chat-scroll-wrap">
      <div className="chat-messages" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty">No messages yet.<br />Say hi 👋</div>
        ) : (
          messages.map((m, i) => {
            if (m.kind === 'event') return <ActionBar key={m.id} m={m} rank={ranks[m.userId]} isMod={isMod} onDelete={() => modAct('Message deleted', () => api.chatDelete(m.id))} />;
            const mine = m.userId === user?.id;
            const hColor = colorFor(m.handle);
            const aState = effFor(m.userId, m.authorMutedUntil, m.authorBanned);
            const aMuted = muteLeftMin(aState.mutedUntil) > 0;
            const aBanned = aState.banned;
            const grouped = isGroupedWith(m, messages[i - 1]);
            return (
              <div key={m.id} className={`chat-msg ${grouped ? 'grouped' : ''}`}>
                {grouped ? (
                  <span className="chat-avatar-spacer" />
                ) : (
                  <span
                    className={`chat-avatar ${m.isMod ? 'av-mod' : ''}`}
                    style={{ background: hColor }}
                    onClick={() => onIdentity(m)}
                    onMouseEnter={(e) => openCard(m.userId, e)}
                    onMouseLeave={closeCardSoon}
                    title={mine ? 'Edit your username' : `Tag ${m.handle}`}
                  >
                    {m.handle?.[0]?.toUpperCase()}
                  </span>
                )}
                <div className="chat-msg-main">
                  {!grouped && (
                    <div className="chat-msg-head">
                      <span
                        className="chat-handle"
                        style={{ color: hColor }}
                        onClick={() => onIdentity(m)}
                        onMouseEnter={(e) => openCard(m.userId, e)}
                        onMouseLeave={closeCardSoon}
                      >
                        {m.handle}
                      </span>
                      <RankBadge rank={ranks[m.userId]} />
                      {m.isMod && <span className="chat-mod-chip" title="Moderator">MOD</span>}
                      <span className="chat-time">{fmtTime(m.createdAt)}</span>
                    </div>
                  )}
                  {m.replyTo && (
                    <div className="chat-quote">↳ <b>{m.replyTo.handle}</b> {snippet(m.replyTo.body)}</div>
                  )}
                  <div className="chat-text">{renderBody(m.body, me?.username)}</div>
                  {Object.keys(m.reactions || {}).length > 0 && (
                    <div className="chat-reactions">
                      {Object.entries(m.reactions || {}).map(([emoji, count]) => (
                        <button
                          key={emoji}
                          className={`chat-react ${(m.myReactions || []).includes(emoji) ? 'mine' : ''}`}
                          onClick={() => onReact(m, emoji)}
                          disabled={!user}
                        >
                          <span>{emoji}</span> {count}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* hover toolbar (reply / react / mod) — top-right of the row */}
                {user && (
                  <span className={`chat-msg-tools ${pickerFor === m.id ? 'open' : ''}`}>
                    <button className="chat-tool-btn" title="Reply" onClick={() => setReplyTo({ id: m.id, handle: m.handle, body: m.body })}>↩</button>
                    <span className={`chat-react-add-wrap ${pickerFor === m.id ? 'open' : ''}`}>
                      <button className="chat-react-add chat-tool-btn" title="Add reaction" onClick={() => setPickerFor(pickerFor === m.id ? null : m.id)}>＋</button>
                      {pickerFor === m.id && (
                        <span className="chat-react-picker">
                          {CHAT_REACTIONS.map((e) => (
                            <button key={e} onClick={() => { onReact(m, e); setPickerFor(null); }}>{e}</button>
                          ))}
                        </span>
                      )}
                    </span>
                    {isMod && (
                      <>
                        <button className="chat-mod-btn chat-mod-del" title="Delete message" onClick={() => modAct('Message deleted', () => api.chatDelete(m.id))}>✕</button>
                        {!mine && !m.isMod && (
                          aMuted ? (
                            <button className="chat-mod-btn" title="Unmute" onClick={() => modAct(`Unmuted ${m.handle}`, () => api.chatUnmute(m.userId))}>🔊</button>
                          ) : (
                            <button className="chat-mod-btn" title="Mute 60m" onClick={() => modAct(`Muted ${m.handle} for 60m`, () => api.chatMute(m.userId))}>🔇</button>
                          )
                        )}
                        {!mine && !m.isMod && (
                          aBanned ? (
                            <button className="chat-mod-btn" title="Unban" onClick={() => modAct(`Unbanned ${m.handle}`, () => api.chatUnban(m.userId))}>♻️</button>
                          ) : (
                            <button className="chat-mod-btn" title="Ban from chat" onClick={() => { if (window.confirm(`Ban ${m.handle} from chat?`)) modAct(`Banned ${m.handle}`, () => api.chatBan(m.userId)); }}>🚫</button>
                          )
                        )}
                      </>
                    )}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
        {hasNew && <button className="chat-newmsg" onClick={scrollToBottom}>New messages ↓</button>}
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
          <div className="chat-compose">
            <input
              ref={inputRef}
              type="text"
              value={text}
              maxLength={280}
              placeholder="Message… (@ to tag)"
              onChange={onComposeChange}
              onKeyDown={onComposeKeyDown}
              onBlur={() => setMention(null)}
            />
            <button className="chat-emoji-btn" title="Emoji" onClick={() => setComposePicker((v) => !v)}>😊</button>
            {composePicker && (
              <div className="chat-emoji-popup">
                {COMPOSE_EMOJIS.map((e) => (
                  <button key={e} onMouseDown={(ev) => { ev.preventDefault(); insertEmoji(e); }}>{e}</button>
                ))}
              </div>
            )}
            {mention && (
              <div className="chat-mention-menu">
                {mention.items.map((h, i) => (
                  <button
                    key={h}
                    className={`chat-mention-item ${i === mention.active ? 'active' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); acceptMention(h); }}
                    onMouseEnter={() => setMention((mm) => (mm ? { ...mm, active: i } : mm))}
                  >
                    <span className="chat-mention-ava" style={{ background: colorFor(h) }}>{h[0]?.toUpperCase()}</span>
                    <span>{h}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn-primary sm" disabled={busy || !text.trim()} onClick={onSend}>{busy ? '…' : 'Send'}</button>
        </div>
      )}

      <ProfileHoverCard hover={hover} onEnter={cancelClose} onLeave={closeCardSoon} />

      {dropOpen && (
        <div className="modal" onClick={() => setDropOpen(false)}>
          <div className="modal-content drop-modal" onClick={(e) => e.stopPropagation()}>
            <div className="drop-modal-word">DROP</div>
            <p className="drop-modal-copy">
              Every DROP, the house opens a <strong>TCG GACHA pack</strong> (bigger when the pot grows) — cards up to{' '}
              <strong>$20,000 USDC</strong>. One eligible wallet wins the card drawn. Eligible = you've deposited
              (or hold 500K+ $GDEX).
            </p>
            <label className="drop-tip-label">
              Add to the pot:
              <span className="drop-tip-row">
                <input className="wallet-input" type="number" placeholder="USDC" disabled />
                <button className="btn-primary sm" disabled>Tip</button>
              </span>
            </label>
            <div className="drop-soon">🎁 Coming soon!</div>
            <button className="btn-secondary sm" onClick={() => setDropOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </aside>
  );
}
