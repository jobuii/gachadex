import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
// the browser entry, NOT bare 'qrcode' (whose Node entry drags server-only renderers into the
// bundle); it's already in the main chunk via wallet-adapter's mobile package, so this is free
import QRCode from 'qrcode/lib/browser';
import { formatUsd, toE6, shortenPubkey } from '@pokex/pricing';
import { useAuth } from '../auth/AuthContext';
import { signAndSubmitWithdrawal } from '../lib/withdraw.js';
import { useCopy } from '../lib/useCopy.js';
import * as api from '../lib/api.js';

/**
 * Real-funds wallet (custody): deposit address + QR, step-up withdrawal, lifecycle list.
 * Rendered in place of the faucet when the API reports REAL_FUNDS. A withdrawal needs a fresh
 * wallet signature over the exact (amount, dest) — the server renders the message, the wallet
 * signs it, the server verifies + debits atomically. Built entirely from theme tokens /
 * existing component classes so all skins style it natively.
 */

const STATUS_TONE = {
  credited: 'up',
  confirmed: 'up',
  failed: 'down',
  reversed: 'down',
};

function fmtRow(t) {
  const amount =
    t.asset === 'SOL'
      ? `${(Number(t.amountRaw) / 1e9).toFixed(4)} SOL`
      : formatUsd(BigInt(t.usdcE6 ?? t.amountRaw));
  return {
    ...t,
    amount,
    when: new Date(t.time).toLocaleString(),
    tone: STATUS_TONE[t.status] ?? '',
  };
}

export function WalletPanel({ onChanged }) {
  const { user, pubkey } = useAuth();
  const { signMessage } = useWallet();

  const [address, setAddress] = useState(null);
  const [qr, setQr] = useState(null);
  const { copied, copy } = useCopy();
  const [txs, setTxs] = useState([]);

  const [amount, setAmount] = useState('');
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const loadTxs = useCallback(() => {
    api.getWalletTransactions().then((r) => setTxs(r.transactions.map(fmtRow))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    api.getDepositAddress().then((r) => setAddress(r.address)).catch(() => {});
    loadTxs();
    const t = setInterval(loadTxs, 10_000); // deposits land asynchronously (chain scanner)
    return () => clearInterval(t);
  }, [user, loadTxs]);

  useEffect(() => {
    if (!address) return;
    // QR stays black-on-white regardless of skin — scannability beats theming.
    QRCode.toDataURL(address, { margin: 1, width: 132 }).then(setQr).catch(() => {});
  }, [address]);

  const submitWithdraw = async () => {
    setErr(null);
    setMsg(null);
    if (!signMessage) {
      setErr('Connect the wallet you signed in with to authorize a withdrawal.');
      return;
    }
    const usd = Number(amount);
    if (!Number.isFinite(usd) || usd <= 0) {
      setErr('Enter a positive USDC amount.');
      return;
    }
    setBusy(true);
    try {
      const amountE6 = toE6(usd).toString();
      const to = (dest.trim() || pubkey).trim();
      // server renders the exact message binding (amount, dest, nonce); the wallet signs it —
      // a stolen session alone can't move funds
      const r = await signAndSubmitWithdrawal({ amountE6, dest: to, signMessage });
      setMsg(
        r.autoApprove
          ? `Withdrawal of ${formatUsd(BigInt(amountE6))} approved — funds reserved, your payout is on its way.`
          : `Withdrawal of ${formatUsd(BigInt(amountE6))} ${r.status} — funds reserved, payout follows approval.`,
      );
      setAmount('');
      loadTxs();
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;

  return (
    <div className="referral-panel wallet-panel">
      <h3>Wallet</h3>
      <p className="ref-blurb">
        Real-funds mode — USDC on Solana. Deposits credit after on-chain finalization; withdrawals
        are authorized by your wallet signature.
      </p>

      <div className="ref-code-box">
        <div className="ref-field">
          <span className="ref-label">DEPOSIT ADDRESS</span>
          {address ? (
            <>
              <span className="wallet-addr">{address}</span>
              <div className="wallet-addr-actions">
                {qr && <img className="wallet-qr" src={qr} alt="deposit address QR" width="66" height="66" />}
                <button className="btn-secondary" onClick={() => copy(address)}>{copied ? 'Copied ✓' : 'Copy'}</button>
              </div>
              <span className="wallet-hint">Send USDC (or SOL — auto-converted) to this address.</span>
            </>
          ) : (
            <span className="wallet-hint">…</span>
          )}
        </div>

        <div className="ref-field">
          <span className="ref-label">WITHDRAW USDC</span>
          <input
            className="wallet-input"
            type="number"
            min="0"
            step="0.01"
            placeholder="Amount (USDC)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            className="wallet-input"
            type="text"
            spellCheck={false}
            placeholder={pubkey ? `Destination (default: ${shortenPubkey(pubkey)})` : 'Destination address'}
            value={dest}
            onChange={(e) => setDest(e.target.value)}
          />
          <button className="btn-primary" disabled={busy || !amount} onClick={submitWithdraw}>
            {busy ? 'Sign in wallet…' : 'Withdraw'}
          </button>
        </div>
      </div>

      {msg && <div className="ref-msg up">{msg}</div>}
      {err && <div className="order-error">{err}</div>}

      {txs.length > 0 && (
        <>
          <span className="ref-label wallet-txs-label">DEPOSITS &amp; WITHDRAWALS</span>
          <table className="positions-table">
            <thead>
              <tr><th>Type</th><th>Amount</th><th>Status</th><th>Tx</th><th>Time</th></tr>
            </thead>
            <tbody>
              {txs.map((t) => (
                <tr key={t.id}>
                  <td className="wallet-kind">{t.kind}</td>
                  <td>{t.amount}</td>
                  <td className={t.tone}>{t.status}</td>
                  <td>{t.sig ? shortenPubkey(t.sig) : '—'}</td>
                  <td>{t.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
