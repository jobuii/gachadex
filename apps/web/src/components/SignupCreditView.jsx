import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import * as api from '../lib/api.js';

// Operator "Perks" tab: the free signup-credit program (docs/signup-credit-spec.md). DARK until Enabled.
// Fund the budget from earned fees, tune the knobs, and release held first-withdrawals after reviewing them.
export function SignupCreditView({ adminKey }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  const [form, setForm] = useState(null); // editable copy of config
  const [fundUsd, setFundUsd] = useState('');

  const load = useCallback(() => {
    api.adminGetSignupCredit(adminKey).then((d) => { setData(d); setForm({ ...d.config }); setErr(null); }).catch((e) => setErr(e.message));
  }, [adminKey]);
  useEffect(() => { load(); }, [load]);

  const run = async (key, fn) => {
    setBusy(key); setMsg(null); setErr(null);
    try { await fn(); load(); } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };

  if (err && !data) return <div className="order-error">{err}</div>;
  if (!data || !form) return <div className="loading-pixel" style={{ padding: '2rem' }}><span /><span /><span /></div>;

  const usd = (e6) => formatUsd(BigInt(e6 ?? 0));
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <h3 style={{ marginTop: '1rem' }}>
        Free signup credit{' '}
        {form.enabled ? <span style={{ color: 'var(--success)' }}>● LIVE</span> : <span className="muted">○ dark</span>}
      </h3>
      <p className="ref-blurb">
        Grant new depositors a <strong>non-withdrawable, tradeable</strong> USDC credit. Funded from earned fees
        (FEE_REVENUE → the budget); the budget balance is the hard cap. The grant fires on a customer's first deposit.
        Winnings withdraw only after they deposit ≥ the wager amount and trade ≥ the wager volume; the principal never
        cashes out. <strong>Dark</strong> until Enabled.
      </p>
      {err && <div className="order-error">{err}</div>}
      {msg && <div className="ref-msg up">{msg}</div>}

      <div className="stat-cards" style={{ marginBottom: '0.8rem' }}>
        <div className="stat-card"><span className="sc-label">Budget (CREDIT_BUDGET)</span><span className="sc-val">{usd(data.budgetE6)}</span></div>
        <div className="stat-card"><span className="sc-label">Fees available</span><span className="sc-val">{usd(data.feeRevenueE6)}</span></div>
        <div className="stat-card"><span className="sc-label">Total bonuses issued</span><span className="sc-val">{usd(data.totalIssuedE6)}</span></div>
        <div className="stat-card"><span className="sc-label">Active grants</span><span className="sc-val">{data.activeGrants}</span></div>
      </div>

      <div className="ref-code-box" style={{ gap: '0.5rem', marginBottom: '0.8rem', flexWrap: 'wrap' }}>
        <strong style={{ flex: '1 1 100%', fontSize: '0.82rem' }}>Fund the budget — move earned fees into CREDIT_BUDGET</strong>
        <input className="wallet-input" type="number" min="0" placeholder="Amount (USD)" value={fundUsd} onChange={(e) => setFundUsd(e.target.value)} style={{ width: 160 }} />
        <button className="btn-primary sm" disabled={busy === 'fund' || !(Number(fundUsd) > 0)}
          onClick={() => run('fund', async () => { const r = await api.adminFundCreditBudget(Number(fundUsd), adminKey); setFundUsd(''); setMsg(`Moved ${formatUsd(BigInt(r.movedE6))} of fees into the budget.`); })}>
          {busy === 'fund' ? '…' : 'Fund'}
        </button>
      </div>

      <div className="ref-code-box" style={{ flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.8rem' }}>
        <strong style={{ flex: '1 1 100%', fontSize: '0.82rem' }}>Program settings</strong>
        <label className="field-label"><span>Enabled</span><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /></label>
        <label className="field-label"><span>Grant ($)</span><input className="wallet-input" type="number" min="0" value={form.grantUsd} onChange={(e) => set('grantUsd', Number(e.target.value))} style={{ width: 90 }} /></label>
        <label className="field-label"><span>Wager deposit ($)</span><input className="wallet-input" type="number" min="0" value={form.wagerDepositUsd} onChange={(e) => set('wagerDepositUsd', Number(e.target.value))} style={{ width: 100 }} /></label>
        <label className="field-label"><span>Wager volume ($)</span><input className="wallet-input" type="number" min="0" value={form.wagerVolumeUsd} onChange={(e) => set('wagerVolumeUsd', Number(e.target.value))} style={{ width: 110 }} /></label>
        <label className="field-label"><span>Expiry (days)</span><input className="wallet-input" type="number" min="1" value={form.expiryDays} onChange={(e) => set('expiryDays', Number(e.target.value))} style={{ width: 90 }} /></label>
        <button className="btn-primary sm" disabled={busy === 'cfg'} onClick={() => run('cfg', async () => { await api.adminSetSignupCreditConfig(form, adminKey); setMsg('Settings saved.'); })}>{busy === 'cfg' ? '…' : 'Save settings'}</button>
      </div>

      <h3 style={{ marginTop: '1rem' }}>First-withdrawal review queue ({data.reviewQueue.length})</h3>
      <p className="ref-blurb">A credit-origin account's first withdrawal is held until you release it. Review the wallet (funding source / cluster) before releasing — once cleared it auto-processes next pass.</p>
      {data.reviewQueue.length === 0 ? (
        <div className="empty-state">Nothing awaiting review.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="cust-table">
            <thead><tr><th>Wallet</th><th>Granted</th><th>Pending withdrawal</th><th></th></tr></thead>
            <tbody>
              {data.reviewQueue.map((r) => (
                <tr key={r.userId}>
                  <td>{r.pubkey}</td>
                  <td className="num">{usd(r.grantedE6)}</td>
                  <td className="num">{usd(r.pendingWithdrawalE6)}</td>
                  <td><button className="btn-primary sm" disabled={busy === r.userId} onClick={() => run(r.userId, async () => { await api.adminClearCreditReview(r.userId, adminKey); setMsg('Released — it auto-processes next pass.'); })}>{busy === r.userId ? '…' : 'Release'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
