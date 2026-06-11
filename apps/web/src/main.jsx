import React, { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import './themes.css';
import './mobile.css'; /* last: mobile overrides must win over base + skins */
import { initialSkin } from './store/theme';

document.documentElement.setAttribute('data-theme', initialSkin());

import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import '@solana/wallet-adapter-react-ui/styles.css';

import { Buffer } from 'buffer';
import { AuthProvider } from './auth/AuthContext.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
window.Buffer = window.Buffer || Buffer;

// eslint-disable-next-line react-refresh/only-export-components
const RootApp = () => {
  // Mainnet. Override with VITE_SOLANA_RPC (apps/web/.env) — the public endpoint is heavily
  // rate-limited, so use a dedicated provider (Helius / QuickNode / Triton) in prod.
  const endpoint =
    import.meta.env.VITE_SOLANA_RPC ||
    'https://api.mainnet-beta.solana.com';

  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  console.log('[Solana] Connecting to RPC endpoint:', endpoint);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect onError={(error) => {
        console.error('[Wallet] Connection error:', error);
      }}>
        <WalletModalProvider>
          <AuthProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </AuthProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);
