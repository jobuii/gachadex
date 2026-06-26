import { useCallback, useEffect, useState } from 'react';
import { formatUsd, shortenPubkey } from '@pokex/pricing';
import * as api from '../lib/api.js';

// Operator "Affiliates" tab: give KOLs / streamers a referral code with custom economics — a cashback % of
// their referees' TRADING fees, a discount % on their own fees, and a game-revenue % of the gacha house
// revenue (sell-back cut + markup) their referees generate. Renders inside the AdminPanel (admin-key prop).
// Percentages in the UI; bps over the wire.
const short = (a) => shortenPubkey(a) || '—';
const usd = (e6) => formatUsd(BigInt(e6 ?? 0));
// The shareable referral link the affiliate hands out — `?ref=CODE` is captured on app load and redeemed
// at sign-in. Built off the current origin so it's right on prod, preview, or localhost without a hardcode.
const refLink = (code) => `${window.location.origin}/?ref=${code}`;
const EMPTY = { pubkey: '', code: '', cashbackPct: '', discountPct: '', gamePct: '', label: '' };
// a finite percentage within [0, max] — shared by the per-affiliate form and the platform-defaults form.
const validPct = (v, max) => Number.isFinite(v) && v >= 0 && v <= max;

export function AffiliatesView({ adminKey }) {
  const [rows, setRows] = useState([]);
  const [maxCashbackBps, setMaxCashbackBps] = useState(5000);
  const [maxGameRevenueBps, setMaxGameRevenueBps] = useState(10000);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [pd, setPd] = useState({ cashbackPct: '', discountPct: '', gamePct: '' }); // platform-wide defaults
  const [pdBusy, setPdBusy] = useState(false);

  const maxCashbackPct = maxCashbackBps / 100;
  const maxGamePct = maxGameRevenueBps / 100;

  const load = useCallback(() => {
    setLoading(true);
    return api
      .adminGetAffiliates(adminKey)
      .then((r) => {
        setRows(r.affiliates || []);
        setMaxCashbackBps(r.maxCashbackBps ?? 5000);
        const d = r.platformDefaults;
        if (d) {
          setMaxGameRevenueBps(d.maxGameRevenueBps ?? 10000);
          setPd({ cashbackPct: String(d.cashbackBps / 100), discountPct: String(d.feeDiscountBps / 100), gamePct: String(d.gameRevenueBps / 100) });
        }
        setErr(null);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [adminKey]);
  useEffect(() => {
    load();
  }, [load]);

  const copy = (text) => {
    if (!text) return;
    navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1000);
  };
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const edit = (a) =>
    setForm({ pubkey: a.pubkey, code: a.code ?? '', cashbackPct: String(a.cashbackBps / 100), discountPct: String(a.feeDiscountBps / 100), gamePct: String(a.gameRevenueBps / 100), label: a.label ?? '' });

  const save = async () => {
    setErr(null);
    setNote(null);
    const pubkey = form.pubkey.trim();
    if (!pubkey) {
      setErr('Enter the affiliate wallet address.');
      return;
    }
    const cashbackPct = Number(form.cashbackPct);
    const discountPct = Number(form.discountPct);
    const gamePct = Number(form.gamePct);
    if (!validPct(cashbackPct, maxCashbackPct)) {
      setErr(`Cashback must be 0–${maxCashbackPct}% (the house keeps the rest of each fee).`);
      return;
    }
    if (!validPct(discountPct, 100)) {
      setErr('Fee discount must be 0–100%.');
      return;
    }
    if (!validPct(gamePct, maxGamePct)) {
      setErr(`Game revenue must be 0–${maxGamePct}%.`);
      return;
    }
    setBusy(true);
    try {
      const r = await api.adminSetAffiliate(
        {
          pubkey,
          code: form.code.trim() || undefined,
          cashbackBps: Math.round(cashbackPct * 100),
          feeDiscountBps: Math.round(discountPct * 100),
          gameRevenueBps: Math.round(gamePct * 100),
          label: form.label.trim() || undefined,
          // no `active`: the backend defaults a new affiliate to active and preserves an existing one's
          // flag, so editing a deactivated affiliate's rates won't silently re-enable them (use the
          // Activate/Deactivate button for that).
        },
        adminKey,
      );
      setNote(`Saved ${r.code ?? short(r.pubkey)} — ${r.cashbackBps / 100}% cashback, ${r.feeDiscountBps / 100}% off fees, ${r.gameRevenueBps / 100}% game rev.`);
      setForm(EMPTY);
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Platform-wide defaults: the baseline cashback + fee-discount + game-revenue share paid to every code that
  // has no active per-wallet terms. Individual affiliate rows above override these for that wallet.
  const savePd = async () => {
    setErr(null);
    setNote(null);
    const cashbackPct = Number(pd.cashbackPct);
    const discountPct = Number(pd.discountPct);
    const gamePct = Number(pd.gamePct);
    if (!validPct(cashbackPct, maxCashbackPct)) {
      setErr(`Default cashback must be 0–${maxCashbackPct}%.`);
      return;
    }
    if (!validPct(discountPct, 100)) {
      setErr('Default fee discount must be 0–100%.');
      return;
    }
    if (!validPct(gamePct, maxGamePct)) {
      setErr(`Default game revenue must be 0–${maxGamePct}%.`);
      return;
    }
    setPdBusy(true);
    try {
      const r = await api.adminSetAffiliateDefaults(
        { cashbackBps: Math.round(cashbackPct * 100), feeDiscountBps: Math.round(discountPct * 100), gameRevenueBps: Math.round(gamePct * 100) },
        adminKey,
      );
      setNote(`Platform defaults saved — ${r.cashbackBps / 100}% cashback, ${r.feeDiscountBps / 100}% off fees, ${r.gameRevenueBps / 100}% game rev for every code.`);
      setPd({ cashbackPct: String(r.cashbackBps / 100), discountPct: String(r.feeDiscountBps / 100), gamePct: String(r.gameRevenueBps / 100) });
    } catch (e) {
      setErr(e.message);
    } finally {
      setPdBusy(false);
    }
  };

  // Flip active without changing the rates (re-sends the existing bps so validation passes + nothing resets).
  const toggleActive = async (a) => {
    setErr(null);
    setNote(null);
    setBusy(true);
    try {
      await api.adminSetAffiliate(
        { pubkey: a.pubkey, cashbackBps: a.cashbackBps, feeDiscountBps: a.feeDiscountBps, gameRevenueBps: a.gameRevenueBps, active: !a.active },
        adminKey,
      );
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 style={{ marginTop: '1rem' }}>Affiliates ({rows.length})</h3>
      <p className="ref-blurb">
        Give a KOL / streamer / affiliate a referral code with custom economics. <strong>Cashback</strong> = the
        % of their referees' trading fees paid back to them as real USDC, from the house revenue share (max{' '}
        {maxCashbackPct}%). <strong>Fee discount</strong> = the % off their own trading fees.{' '}
        <strong>Game rev</strong> = the % of the gacha house revenue (the sell-back cut + pack markup GDEX keeps)
        their referees generate, paid back to them. The code links to their wallet — if they've never signed in,
        the account is created. Edit any row to change its rates; deactivating drops a wallet's custom rates (it
        then falls back to the platform defaults) without deleting the link. Set <strong>platform defaults</strong>{' '}
        below to pay <em>every</em> code a baseline; any active per-wallet row overrides them for that wallet (set
        one to 0 to zero a wallet out).
      </p>
      {err && <div className="order-error">{err}</div>}
      {note && <div className="ref-msg up">{note}</div>}

      <div className="ref-code-box" style={{ flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.6rem' }}>
        <strong style={{ flex: '1 1 100%', fontSize: '0.82rem' }}>Platform defaults — every code without its own terms</strong>
        <input className="wallet-input" type="number" min="0" max={maxCashbackPct} step="1" placeholder={`Cashback % (≤${maxCashbackPct})`} value={pd.cashbackPct} onChange={(e) => setPd((p) => ({ ...p, cashbackPct: e.target.value }))} style={{ width: 150 }} />
        <input className="wallet-input" type="number" min="0" max="100" step="1" placeholder="Discount %" value={pd.discountPct} onChange={(e) => setPd((p) => ({ ...p, discountPct: e.target.value }))} style={{ width: 120 }} />
        <input className="wallet-input" type="number" min="0" max={maxGamePct} step="1" placeholder={`Game rev % (≤${maxGamePct})`} value={pd.gamePct} onChange={(e) => setPd((p) => ({ ...p, gamePct: e.target.value }))} style={{ width: 150 }} />
        <button className="btn-primary sm" disabled={pdBusy} onClick={savePd}>{pdBusy ? '…' : 'Save defaults'}</button>
      </div>

      <div className="ref-code-box" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <input className="wallet-input" placeholder="Wallet address" value={form.pubkey} onChange={(e) => set('pubkey', e.target.value)} style={{ flex: '2 1 220px' }} />
        <input className="wallet-input" placeholder="CODE (optional)" value={form.code} maxLength={20} onChange={(e) => set('code', e.target.value.toUpperCase())} style={{ flex: '1 1 110px' }} />
        <input className="wallet-input" type="number" min="0" max={maxCashbackPct} step="1" placeholder={`Cashback % (≤${maxCashbackPct})`} value={form.cashbackPct} onChange={(e) => set('cashbackPct', e.target.value)} style={{ width: 140 }} />
        <input className="wallet-input" type="number" min="0" max="100" step="1" placeholder="Discount %" value={form.discountPct} onChange={(e) => set('discountPct', e.target.value)} style={{ width: 110 }} />
        <input className="wallet-input" type="number" min="0" max={maxGamePct} step="1" placeholder={`Game rev % (≤${maxGamePct})`} value={form.gamePct} onChange={(e) => set('gamePct', e.target.value)} style={{ width: 140 }} />
        <input className="wallet-input" placeholder="Label (optional)" value={form.label} onChange={(e) => set('label', e.target.value)} style={{ flex: '1 1 110px' }} />
        <button className="btn-primary sm" disabled={busy} onClick={save}>{busy ? '…' : 'Save affiliate'}</button>
        {form !== EMPTY && (
          <button className="btn-ghost sm" disabled={busy} onClick={() => setForm(EMPTY)}>Clear</button>
        )}
      </div>

      <div style={{ overflowX: 'auto', marginTop: '0.8rem' }}>
        <table className="cust-table">
          <thead>
            <tr>
              <th>Code</th><th>Wallet</th><th>Label</th><th>Cashback</th><th>Discount</th><th>Game rev</th><th>Referrals</th><th>Cashback paid</th><th>Game rev paid</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.userId} style={{ opacity: a.active ? 1 : 0.5 }}>
                <td>
                  {a.code ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}>
                      {a.code}
                      <button
                        className="btn-ghost sm"
                        title={`Copy referral link — ${refLink(a.code)}`}
                        onClick={() => copy(refLink(a.code))}
                      >
                        {copied === refLink(a.code) ? 'copied!' : 'copy link'}
                      </button>
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="addr" title={a.pubkey} onClick={() => copy(a.pubkey)}>{copied === a.pubkey ? 'copied!' : short(a.pubkey)}</td>
                <td className="muted">{a.label || '—'}</td>
                <td className="num">{a.cashbackBps / 100}%</td>
                <td className="num">{a.feeDiscountBps / 100}%</td>
                <td className="num">{a.gameRevenueBps / 100}%</td>
                <td className="num">{a.referrals}</td>
                <td className="num">{usd(a.cashbackPaidUusdc)}</td>
                <td className="num">{usd(a.gameRevenuePaidUusdc)}</td>
                <td className={a.active ? 'up' : 'muted'}>{a.active ? 'active' : 'inactive'}</td>
                <td>
                  <div style={{ display: 'flex', gap: '0.3rem' }}>
                    <button className="btn-ghost sm" disabled={busy} onClick={() => edit(a)}>Edit</button>
                    <button className="btn-ghost sm" disabled={busy} onClick={() => toggleActive(a)}>{a.active ? 'Deactivate' : 'Activate'}</button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={11} className="muted" style={{ textAlign: 'center', padding: '1rem' }}>No affiliates yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {loading && <span className="muted" style={{ fontSize: '0.78rem' }}>loading…</span>}
    </div>
  );
}
