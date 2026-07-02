import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';
import * as api from '../lib/api.js';

// Operator "Perks" tab: the bonus-credits program (docs/bonus-credits-spec.md). Two sources — a flat-$ signup
// bonus and a %-of-deposit bonus — on one shared protection layer. DARK until a source is enabled AND its
// amount is non-zero. Fund the budget from earned fees, tune the shared protections, and release held
// first-withdrawals after reviewing them.
export function BonusView({ adminKey }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  const [form, setForm] = useState(null); // editable copy of config
  const [fundUsd, setFundUsd] = useState('');

  const load = useCallback(() => {
    api.adminGetBonuses(adminKey).then((d) => { setData(d); setForm({ ...d.config }); setErr(null); }).catch((e) => setErr(e.message));
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
  const overCap = data.signups24h > data.config.dailyAccountCap;
  // Save only the tunable fields — never the engine-managed velocity latch.
  const saveConfig = (patch) => run('cfg', async () => { await api.adminSetBonusConfig(patch, adminKey); setMsg('Settings saved.'); });

  return (
    <div>
      <h3 style={{ marginTop: '1rem' }}>Bonus credits</h3>
      <p className="ref-blurb">
        Grant new customers a <strong>non-withdrawable, tradeable</strong> USDC bonus from two independent sources —
        a flat <strong>signup</strong> bonus (new accounts) and a <strong>% of a first deposit</strong>. Funded from
        earned fees (FEE_REVENUE → the budget); the budget balance is the hard cap. The principal is never
        withdrawable; only winnings cash out, and only after the customer deposits ≥ the wager amount and trades ≥
        the wager volume. Unused bonuses expire after the dormancy window. <strong>Dark</strong> until a source is
        enabled with a non-zero amount.
      </p>
      {err && <div className="order-error">{err}</div>}
      {msg && <div className="ref-msg up">{msg}</div>}

      {(overCap || data.config.velocityTripped) && (
        <div className="order-error">
          ⚠ <strong>Velocity {data.config.velocityTripped ? 'auto-pause' : 'warning'}.</strong> {data.signups24h} new
          accounts in the last 24h vs a cap of {data.config.dailyAccountCap}. {data.config.velocityTripped
            ? 'Both bonus sources were switched OFF. Re-enable the toggles below when you’re satisfied the surge is legitimate (existing accounts and signups are unaffected).'
            : 'Over the daily cap — the next issuance will pause both sources.'}
        </div>
      )}

      <div className="stat-cards" style={{ marginBottom: '0.8rem' }}>
        <div className="stat-card"><span className="sc-label">Budget (CREDIT_BUDGET)</span><span className="sc-val">{usd(data.budgetE6)}</span></div>
        <div className="stat-card"><span className="sc-label">Fees available</span><span className="sc-val">{usd(data.feeRevenueE6)}</span></div>
        <div className="stat-card"><span className="sc-label">Total issued (signup / deposit)</span><span className="sc-val">{usd(data.totalIssuedE6)} <span className="muted" style={{ fontSize: '0.72rem' }}>({usd(data.signupIssuedE6)} / {usd(data.depositIssuedE6)})</span></span></div>
        <div className="stat-card"><span className="sc-label">Active grants</span><span className="sc-val">{data.activeGrants}</span></div>
        <div className="stat-card"><span className="sc-label">Signups (24h)</span><span className="sc-val" style={overCap ? { color: '#ef4444' } : undefined}>{data.signups24h} / {data.config.dailyAccountCap}</span></div>
      </div>

      <div className="ref-code-box" style={{ gap: '0.5rem', marginBottom: '0.8rem', flexWrap: 'wrap' }}>
        <strong style={{ flex: '1 1 100%', fontSize: '0.82rem' }}>Fund the budget — move earned fees into CREDIT_BUDGET</strong>
        <input className="wallet-input" type="number" min="0" placeholder="Amount (USD)" value={fundUsd} onChange={(e) => setFundUsd(e.target.value)} style={{ width: 160 }} />
        <button className="btn-primary sm" disabled={busy === 'fund' || !(Number(fundUsd) > 0)}
          onClick={() => run('fund', async () => { const r = await api.adminFundCreditBudget(Number(fundUsd), adminKey); setFundUsd(''); setMsg(`Moved ${formatUsd(BigInt(r.movedE6))} of fees into the budget.`); })}>
          {busy === 'fund' ? '…' : 'Fund'}
        </button>
      </div>

      {/* Signup source */}
      <div className="ref-code-box" style={{ flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.8rem' }}>
        <strong style={{ flex: '1 1 100%', fontSize: '0.82rem' }}>
          Signup bonus {form.signupEnabled && form.signupUsd > 0 ? <span style={{ color: 'var(--success)' }}>● live</span> : <span className="muted">○ dark</span>}
        </strong>
        <label className="field-label"><span>Enabled</span><input type="checkbox" checked={form.signupEnabled} onChange={(e) => set('signupEnabled', e.target.checked)} /></label>
        <label className="field-label"><span>Amount ($)</span><input className="wallet-input" type="number" min="0" value={form.signupUsd} onChange={(e) => set('signupUsd', Number(e.target.value))} style={{ width: 100 }} /></label>
        <button className="btn-primary sm" disabled={busy === 'cfg'} onClick={() => saveConfig({ signupEnabled: form.signupEnabled, signupUsd: form.signupUsd })}>{busy === 'cfg' ? '…' : 'Save signup'}</button>
      </div>

      {/* Deposit source */}
      <div className="ref-code-box" style={{ flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.8rem' }}>
        <strong style={{ flex: '1 1 100%', fontSize: '0.82rem' }}>
          Deposit bonus {form.depositEnabled && form.depositPct > 0 && form.depositMaxUsd > 0 ? <span style={{ color: 'var(--success)' }}>● live</span> : <span className="muted">○ dark</span>}
        </strong>
        <label className="field-label"><span>Enabled</span><input type="checkbox" checked={form.depositEnabled} onChange={(e) => set('depositEnabled', e.target.checked)} /></label>
        <label className="field-label"><span>% of deposit</span><input className="wallet-input" type="number" min="0" max="100" value={form.depositPct} onChange={(e) => set('depositPct', Number(e.target.value))} style={{ width: 90 }} /></label>
        <label className="field-label"><span>Cap ($)</span><input className="wallet-input" type="number" min="0" value={form.depositMaxUsd} onChange={(e) => set('depositMaxUsd', Number(e.target.value))} style={{ width: 100 }} /></label>
        <button className="btn-primary sm" disabled={busy === 'cfg'} onClick={() => saveConfig({ depositEnabled: form.depositEnabled, depositPct: form.depositPct, depositMaxUsd: form.depositMaxUsd })}>{busy === 'cfg' ? '…' : 'Save deposit'}</button>
      </div>
      <p className="ref-blurb" style={{ marginTop: '-0.4rem' }}>The deposit bonus needs both a % <em>and</em> a $ cap to pay — a $0 cap means no bonus, so a percentage match can never be uncapped. First deposit only.</p>

      {/* Shared protections */}
      <div className="ref-code-box" style={{ flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.8rem' }}>
        <strong style={{ flex: '1 1 100%', fontSize: '0.82rem' }}>Shared protections (apply to both sources)</strong>
        <label className="field-label"><span>Wager deposit ($)</span><input className="wallet-input" type="number" min="0" value={form.wagerDepositUsd} onChange={(e) => set('wagerDepositUsd', Number(e.target.value))} style={{ width: 100 }} /></label>
        <label className="field-label"><span>Wager volume ($)</span><input className="wallet-input" type="number" min="0" value={form.wagerVolumeUsd} onChange={(e) => set('wagerVolumeUsd', Number(e.target.value))} style={{ width: 110 }} /></label>
        <label className="field-label"><span>Expiry (days, dormant)</span><input className="wallet-input" type="number" min="1" value={form.expiryDays} onChange={(e) => set('expiryDays', Number(e.target.value))} style={{ width: 110 }} /></label>
        <label className="field-label"><span>Daily acct cap</span><input className="wallet-input" type="number" min="1" value={form.dailyAccountCap} onChange={(e) => set('dailyAccountCap', Number(e.target.value))} style={{ width: 100 }} /></label>
        <button className="btn-primary sm" disabled={busy === 'cfg'} onClick={() => saveConfig({ wagerDepositUsd: form.wagerDepositUsd, wagerVolumeUsd: form.wagerVolumeUsd, expiryDays: form.expiryDays, dailyAccountCap: form.dailyAccountCap })}>{busy === 'cfg' ? '…' : 'Save protections'}</button>
      </div>

      <h3 style={{ marginTop: '1rem' }}>First-withdrawal review queue ({data.reviewQueue.length})</h3>
      <p className="ref-blurb">A bonus-origin account's first withdrawal is held until you release it. Review the wallet (funding source / cluster) before releasing — once cleared it auto-processes next pass.</p>
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
                  <td><button className="btn-primary sm" disabled={busy === r.userId} onClick={() => run(r.userId, async () => { await api.adminClearBonusReview(r.userId, adminKey); setMsg('Released — it auto-processes next pass.'); })}>{busy === r.userId ? '…' : 'Release'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
