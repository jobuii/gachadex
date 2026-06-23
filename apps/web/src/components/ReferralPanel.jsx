import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useCopy } from '../lib/useCopy.js';
import * as api from '../lib/api.js';

export function ReferralPanel({ onRedeemed, cashbackTotalUusdc }) {
  const [info, setInfo] = useState(null);
  const [code, setCode] = useState(api.getPendingReferral() ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const { copied, copy } = useCopy();
  const [editing, setEditing] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeErr, setCodeErr] = useState(null);

  const load = useCallback(() => {
    api.getReferral().then(setInfo).catch(() => {});
  }, []);
  useEffect(() => load(), [load]);

  const link = info ? `${window.location.origin}/?ref=${info.code}` : '';

  const startEdit = () => {
    setNewCode(info.code);
    setCodeErr(null);
    setEditing(true);
  };

  const saveCode = async () => {
    setCodeErr(null);
    setCodeBusy(true);
    try {
      await api.setReferralCode(newCode.trim());
      setEditing(false);
      load(); // refresh info.code + the share link
    } catch (e) {
      setCodeErr(e.message);
    } finally {
      setCodeBusy(false);
    }
  };

  const redeem = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const r = await api.redeemReferral(code.trim());
      api.clearPendingReferral();
      setMsg(r.credited ? `Redeemed! +$${r.bonusUsd.toLocaleString()} to you and your referrer.` : 'Referral applied.');
      load();
      onRedeemed?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!info) return null;

  return (
    <div className="referral-panel">
      <h3>Refer friends</h3>
      {info.rewardsEnabled && (
        <p className="ref-blurb">
          You and a friend each get <strong className="up">${info.bonusUsd.toLocaleString()}</strong> play-USDC when they redeem your code.
        </p>
      )}

      {editing ? (
        <>
          <div className="ref-code-box">
            <div className="ref-field">
              <span className="ref-label">YOUR CODE</span>
              <input
                type="text"
                className="ref-code-input"
                value={newCode}
                maxLength={20}
                placeholder="YOUR-CODE"
                onChange={(e) => setNewCode(e.target.value.toUpperCase())}
              />
            </div>
            <button className="btn-primary" disabled={codeBusy || newCode.trim().length < 4} onClick={saveCode}>{codeBusy ? '…' : 'Save'}</button>
            <button className="btn-secondary" onClick={() => { setEditing(false); setCodeErr(null); }}>Cancel</button>
          </div>
          {codeErr && <div className="order-error">{codeErr}</div>}
        </>
      ) : (
        <div className="ref-code-box">
          <div className="ref-field">
            <span className="ref-label">YOUR CODE</span>
            <span className="ref-code">{info.code}</span>
          </div>
          <button className="btn-secondary ref-copy" onClick={() => copy(link)}>{copied ? 'Copied ✓' : 'Copy link'}</button>
          <button className="btn-secondary ref-copy" onClick={startEdit}>Edit</button>
        </div>
      )}

      <div className="ref-stats">
        <span>Friends referred: <strong>{info.referralsCount}</strong></span>
        {BigInt(cashbackTotalUusdc || 0) > 0n && (
          <span>Cashback earned: <strong className="up">{formatUsd(BigInt(cashbackTotalUusdc))}</strong></span>
        )}
      </div>

      <div className="ref-redeem">
        {info.redeemed ? (
          <p className="ref-redeemed">✓ You joined via code <strong>{info.referredByCode ?? '—'}</strong>.</p>
        ) : (
          <>
            <span className="ref-label">HAVE A CODE?</span>
            <div className="ref-redeem-row">
              <input
                type="text"
                placeholder="POKE-XXXXX"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <button className="btn-primary" disabled={busy || code.trim().length < 4} onClick={redeem}>
                {busy ? '…' : 'Redeem'}
              </button>
            </div>
          </>
        )}
        {msg && <div className="ref-msg up">{msg}</div>}
        {err && <div className="order-error">{err}</div>}
      </div>
    </div>
  );
}
