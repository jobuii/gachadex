import { useState, useEffect } from 'react';
import * as api from '../lib/api.js';

/**
 * Provably-fair panel (shared by every game). Shows the active server-seed commitment hash, the client
 * seed, and the next nonce. Rotating the client seed REVEALS the prior server seed so the player can
 * recompute any past play: result = HMAC-SHA256(serverSeed, "clientSeed:nonce:cursor") → first 4 bytes
 * / 2^32. sha256(serverSeed) must equal the hash that was shown before the plays.
 */
export function GamesFairnessModal({ onClose }) {
  const [state, setState] = useState(null); // { serverSeedHash, clientSeed, nonce }
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState(null); // { revealedServerSeed, revealedServerSeedHash } after a rotation
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.getGamesFairness().then((s) => { setState(s); setDraft(s.clientSeed); }).catch((e) => setErr(e.message));
  }, []);

  const rotate = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.setGamesClientSeed(draft.trim());
      setRevealed({ serverSeed: r.revealedServerSeed, hash: r.revealedServerSeedHash });
      setState({ serverSeedHash: r.serverSeedHash, clientSeed: r.clientSeed, nonce: r.nonce });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="games-modal-backdrop" onClick={onClose}>
      <div className="games-modal glass-card" onClick={(e) => e.stopPropagation()}>
        <div className="games-modal-head">
          <h3>Provably fair</h3>
          <button className="chat-collapse" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {err && <div className="order-error">{err}</div>}
        {!state ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <label className="field-label"><span>SERVER SEED HASH (committed up front)</span></label>
            <code className="games-seed">{state.serverSeedHash}</code>

            <label className="field-label"><span>CLIENT SEED (yours — editable)</span></label>
            <div className="field-input-wrap">
              <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={64} placeholder="your client seed" />
            </div>

            <label className="field-label"><span>NEXT NONCE</span></label>
            <code className="games-seed">{state.nonce}</code>

            <button className="btn-primary" disabled={busy || !draft.trim()} onClick={rotate}>
              {busy ? 'Rotating…' : 'Rotate client seed'}
            </button>
            <p className="muted games-fair-note">
              Rotating reveals your previous server seed so you can verify every prior play, then commits a new one.
            </p>

            {revealed && (
              <div className="games-revealed">
                <label className="field-label"><span>REVEALED PREVIOUS SERVER SEED</span></label>
                <code className="games-seed">{revealed.serverSeed}</code>
                <p className="muted">It hashes to <code>{revealed.hash}</code> — the commitment shown before your plays.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
