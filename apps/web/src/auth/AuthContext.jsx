import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import * as api from '../lib/api.js';

const AuthCtx = createContext(null);
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthCtx);
}

export function AuthProvider({ children }) {
  const { publicKey, signMessage, connected, disconnect, wallet } = useWallet();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [connectionError, setConnectionError] = useState(null);

  // Restore an existing session on load. On failure, do NOT clear tokens here: a definitive
  // refresh-token rejection already cleared them inside refreshSession; anything else (429,
  // 5xx, network blip) is transient and the next load should retry, not log out.
  useEffect(() => {
    if (api.hasSession()) {
      api.authMe().then(setUser).catch(() => {});
    }
  }, []);

  const login = useCallback(async () => {
    if (!publicKey || !signMessage) throw new Error('Connect a wallet first');
    setLoading(true);
    setError(null);
    try {
      const pubkey = publicKey.toBase58();
      const { message } = await api.authNonce(pubkey);
      const sig = await signMessage(new TextEncoder().encode(message));
      const data = await api.authVerify({ pubkey, message, signature: bs58.encode(sig) });
      setUser(data.user);
      setConnectionError(null);
      // Attribution: redeem a held ?ref= code now that we're signed in, so a referral/affiliate link
      // actually links this account (sets referred_by) — without this it only fires if the user manually
      // opens the referral panel and clicks redeem, so most KOL referees would never get attributed.
      // Best-effort: clear on success; on a network error keep the code so a later sign-in retries
      // (redeem is idempotent + self/already-redeemed guarded server-side).
      const pendingRef = api.getPendingReferral();
      if (pendingRef) {
        try {
          await api.redeemReferral(pendingRef);
          api.clearPendingReferral();
        } catch (err) {
          // clear on a permanent rejection (4xx: already redeemed / invalid / self) so we don't retry it
          // every sign-in; keep on a transient error (network / 5xx) so a later sign-in retries.
          if (err?.status >= 400 && err.status < 500) api.clearPendingReferral();
        }
      }
      return data.user;
    } catch (e) {
      const msg = e.message || String(e);
      // Provide helpful errors for common wallet/network issues
      if (msg.includes('signature verification failed')) {
        setError('Signature verification failed.');
      } else if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setError('Wallet signature was cancelled.');
      } else if (msg.includes('network') || msg.includes('connection')) {
        setError('Network error. Check your RPC connection.');
      } else {
        setError(msg);
      }
      throw e;
    } finally {
      setLoading(false);
    }
  }, [publicKey, signMessage]);

  const logout = useCallback(async () => {
    await api.authLogout();
    setUser(null);
    try {
      await disconnect();
    } catch {
      /* noop */
    }
  }, [disconnect]);

  return (
    <AuthCtx.Provider
      value={{
        user,
        login,
        logout,
        loading,
        error,
        connectionError,
        walletConnected: connected,
        pubkey: publicKey?.toBase58() ?? null,
        walletName: wallet?.adapter?.name
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
