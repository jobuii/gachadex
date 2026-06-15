import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api.js';
import { Stat } from './adminStats.jsx';

/**
 * Operator "Chat" tab (docs/chat-social-spec.md). Three panels: live action-bar thresholds, DROP config +
 * pot bucket, and moderation (grant/revoke MOD, muted/banned lists with unmute/unban, the mod-action audit).
 * Mirrors CustomersView — fetch-on-mount + 30s poll, takes the verified admin key. DROP here is Phase 1:
 * the knobs + the DROP_POOL pot bucket only (the rounds table + round worker land in Phase 2).
 */

const fmtWhen = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};

// A muted user's remaining time, from the mutedUntil snapshot.
const muteLeft = (until) => {
  if (!until) return 'muted';
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.ceil(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m left` : `${min}m left`;
};

export function ChatAdminView({ adminKey }) {
  const [thresholds, setThresholds] = useState(null); // { bigBetUsd, bigWinUsd, bigBetDefault, bigWinDefault }
  const [dropCfg, setDropCfg] = useState(null); // { intervalMin, houseFloorUsd, packTiers, gdexMin, gdexMint, defaults }
  const [drop, setDrop] = useState(null); // { bucketE6, recentRounds }
  const [mods, setMods] = useState(null); // { mods, muted, banned, recentActions }
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(null);

  // Drafts — a blank field is left unchanged on save (the placeholder shows the current value).
  const [betDraft, setBetDraft] = useState('');
  const [winDraft, setWinDraft] = useState('');
  const [intervalDraft, setIntervalDraft] = useState('');
  const [floorDraft, setFloorDraft] = useState('');
  const [tiersDraft, setTiersDraft] = useState('');
  const [gdexDraft, setGdexDraft] = useState('');
  const [grantInput, setGrantInput] = useState('');

  const reqSeq = useRef(0); // ignore a slow response that resolves after a newer fetch
  const load = useCallback(() => {
    const seq = ++reqSeq.current;
    return Promise.all([
      api.adminGetChatThresholds(adminKey),
      api.adminGetDropConfig(adminKey),
      api.adminGetDrop(adminKey),
      api.adminGetMods(adminKey),
    ])
      .then(([t, c, d, m]) => {
        if (seq !== reqSeq.current) return;
        setThresholds(t);
        setDropCfg(c);
        setDrop(d);
        setMods(m);
        setErr(null);
      })
      .catch((e) => seq === reqSeq.current && setErr(e.message));
  }, [adminKey]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const saveThresholds = async () => {
    const body = {};
    if (betDraft.trim() !== '') body.bigBetUsd = Math.round(Number(betDraft));
    if (winDraft.trim() !== '') body.bigWinUsd = Math.round(Number(winDraft));
    if (Object.keys(body).length === 0) {
      setErr('Enter a threshold to save.');
      return;
    }
    setBusy('thr');
    setErr(null);
    try {
      setThresholds(await api.adminSetChatThresholds(body, adminKey));
      setBetDraft('');
      setWinDraft('');
      setNote('Thresholds saved.');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const saveDropConfig = async () => {
    const body = {};
    if (intervalDraft.trim() !== '') body.intervalMin = Math.round(Number(intervalDraft));
    if (floorDraft.trim() !== '') body.houseFloorUsd = Math.round(Number(floorDraft));
    if (gdexDraft.trim() !== '') body.gdexMin = Math.round(Number(gdexDraft));
    if (tiersDraft.trim() !== '') {
      const parts = tiersDraft.split(',').map((s) => s.trim()).filter((s) => s !== '');
      const tiers = parts.map(Number);
      // Reject the whole input on any non-positive-integer part rather than silently dropping it.
      if (tiers.length === 0 || tiers.some((n) => !Number.isInteger(n) || n <= 0)) {
        setErr('Pack tiers: positive whole-dollar amounts, comma-separated (e.g. 250, 500, 1000).');
        return;
      }
      body.packTiers = tiers;
    }
    if (Object.keys(body).length === 0) {
      setErr('Enter a value to save.');
      return;
    }
    setBusy('drop');
    setErr(null);
    try {
      setDropCfg(await api.adminSetDropConfig(body, adminKey));
      setIntervalDraft('');
      setFloorDraft('');
      setTiersDraft('');
      setGdexDraft('');
      setNote('DROP config saved.');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  // grant/revoke/unmute/unban. `target` is a wallet pubkey or user id (resolved server-side).
  const modAction = async (target, action) => {
    const t = (target || '').trim();
    if (!t) return;
    setBusy(`mod:${action}:${t}`);
    setErr(null);
    try {
      await api.adminSetMod(t, action, adminKey);
      if (action === 'grant' || action === 'revoke') setGrantInput('');
      setNote(`${action} done.`);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="chatadmin">
      {note && <div className="ref-msg up">{note}</div>}
      {err && <div className="order-error">{err}</div>}

      {/* ---- Panel 1: action-bar thresholds ---- */}
      <h3 style={{ marginTop: '1rem' }}>Action-bar thresholds</h3>
      <p className="ref-blurb">
        A trade broadcasts a chat action bar when it clears these. <strong>BIG BET</strong> fires on an open
        whose size ≥ the bet threshold; <strong>BIG WIN</strong> on a close whose realized profit ≥ the win
        threshold. Whole USD — leave a field blank to keep it unchanged.
      </p>
      <div className="chatadmin-row">
        <label>
          BIG BET ≥ (USD)
          <input
            className="wallet-input" type="number" min="0" step="1"
            placeholder={thresholds ? String(thresholds.bigBetUsd) : '500'}
            value={betDraft} onChange={(e) => setBetDraft(e.target.value)}
          />
        </label>
        <label>
          BIG WIN ≥ (USD)
          <input
            className="wallet-input" type="number" min="0" step="1"
            placeholder={thresholds ? String(thresholds.bigWinUsd) : '100'}
            value={winDraft} onChange={(e) => setWinDraft(e.target.value)}
          />
        </label>
        <button className="btn-primary sm" disabled={busy === 'thr'} onClick={saveThresholds}>
          {busy === 'thr' ? '…' : 'Save thresholds'}
        </button>
      </div>
      {thresholds && (
        <p className="muted chatadmin-current">
          Current: BIG BET ≥ ${thresholds.bigBetUsd} · BIG WIN ≥ ${thresholds.bigWinUsd} (env defaults $
          {thresholds.bigBetDefault} / ${thresholds.bigWinDefault}).
        </p>
      )}

      {/* ---- Panel 2: DROP config + pot bucket ---- */}
      <h3 style={{ marginTop: '1.25rem' }}>DROP — config &amp; pot</h3>
      <p className="ref-blurb">
        The timed giveaway. The house funds a floor each round; player tips top it up. At close the round opens
        the largest pack tier the pot can afford. <strong>Phase 1</strong> persists these knobs and shows the
        pot bucket — the round worker + on-chain draw are Phase 2.
      </p>
      <div className="admin-stats">
        <Stat label="DROP pot (bucket)" value={drop ? drop.bucketE6 : null} />
      </div>
      <div className="chatadmin-row">
        <label>
          Interval (min)
          <input
            className="wallet-input" type="number" min="1" step="1"
            placeholder={dropCfg ? String(dropCfg.intervalMin) : '60'}
            value={intervalDraft} onChange={(e) => setIntervalDraft(e.target.value)}
          />
        </label>
        <label>
          House floor (USD)
          <input
            className="wallet-input" type="number" min="0" step="1"
            placeholder={dropCfg ? String(dropCfg.houseFloorUsd) : '250'}
            value={floorDraft} onChange={(e) => setFloorDraft(e.target.value)}
          />
        </label>
        <label>
          GDEX min (held)
          <input
            className="wallet-input" type="number" min="0" step="1"
            placeholder={dropCfg ? String(dropCfg.gdexMin) : '500000'}
            value={gdexDraft} onChange={(e) => setGdexDraft(e.target.value)}
          />
        </label>
      </div>
      <div className="chatadmin-row">
        <label className="chatadmin-wide">
          Pack tiers (USD, comma-separated)
          <input
            className="wallet-input" type="text"
            placeholder={dropCfg ? dropCfg.packTiers.join(', ') : '250, 500, 1000'}
            value={tiersDraft} onChange={(e) => setTiersDraft(e.target.value)}
          />
        </label>
        <button className="btn-primary sm" disabled={busy === 'drop'} onClick={saveDropConfig}>
          {busy === 'drop' ? '…' : 'Save DROP config'}
        </button>
      </div>
      {dropCfg && (
        <p className="muted chatadmin-current">
          Eligibility mint (read-only): <code>{dropCfg.gdexMint}</code>
        </p>
      )}

      {/* ---- Panel 3: moderation ---- */}
      <h3 style={{ marginTop: '1.25rem' }}>Moderation</h3>
      <p className="ref-blurb">
        Grant or revoke <strong>MOD</strong>, and clear mutes/bans. Paste a wallet address or user id to grant.
      </p>
      <div className="chatadmin-row">
        <label className="chatadmin-wide">
          Grant MOD (wallet or user id)
          <input
            className="wallet-input" type="text" placeholder="wallet address or user id"
            value={grantInput} onChange={(e) => setGrantInput(e.target.value)}
          />
        </label>
        <button
          className="btn-primary sm"
          disabled={!grantInput.trim() || busy === `mod:grant:${grantInput.trim()}`}
          onClick={() => modAction(grantInput, 'grant')}
        >
          Grant
        </button>
      </div>

      <ModList title="Moderators" rows={mods?.mods} empty="No moderators yet." actionLabel="Revoke" actionKey="revoke" busy={busy} onAction={(id) => modAction(id, 'revoke')} />
      <ModList title="Muted" rows={mods?.muted} empty="Nobody muted." actionLabel="Unmute" actionKey="unmute" busy={busy} onAction={(id) => modAction(id, 'unmute')} showMute />
      <ModList title="Banned" rows={mods?.banned} empty="Nobody banned." actionLabel="Unban" actionKey="unban" busy={busy} onAction={(id) => modAction(id, 'unban')} />

      <h4 className="chatadmin-subhead">Recent mod actions</h4>
      <table className="hist-table">
        <thead>
          <tr><th>When</th><th>Mod</th><th>Action</th><th>Target</th><th>Detail</th></tr>
        </thead>
        <tbody>
          {(!mods?.recentActions || mods.recentActions.length === 0) && (
            <tr><td colSpan={5} className="hist-empty">No actions yet.</td></tr>
          )}
          {mods?.recentActions?.map((a) => (
            <tr key={a.id}>
              <td className="muted">{fmtWhen(a.at)}</td>
              <td>{a.modHandle || 'operator'}</td>
              <td>{a.action}</td>
              <td>{a.targetHandle || '—'}</td>
              <td className="muted">{a.detail || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// One moderation list (Moderators / Muted / Banned) with a per-row action button. `showMute` adds the
// remaining-mute column.
function ModList({ title, rows, empty, actionLabel, actionKey, busy, onAction, showMute }) {
  const cols = showMute ? 3 : 2;
  return (
    <div className="chatadmin-modlist">
      <h4 className="chatadmin-subhead">{title}{rows ? ` (${rows.length})` : ''}</h4>
      <table className="hist-table">
        <tbody>
          {(!rows || rows.length === 0) && (
            <tr><td colSpan={cols} className="hist-empty">{empty}</td></tr>
          )}
          {rows?.map((r) => (
            <tr key={r.userId}>
              <td>{r.handle}</td>
              {showMute && <td className="muted">{muteLeft(r.mutedUntil)}</td>}
              <td style={{ textAlign: 'right' }}>
                <button
                  className="btn-ghost sm"
                  disabled={busy === `mod:${actionKey}:${r.userId}`}
                  onClick={() => onAction(r.userId)}
                >
                  {actionLabel}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
