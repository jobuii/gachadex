// Typed-ish REST client for the GachaDex API. Access token lives in memory; the refresh
// token in localStorage. On a 401 we transparently refresh once and retry.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

let accessToken = null;
let refreshing = null; // in-flight refresh promise (single-flight)
const REFRESH_KEY = 'pokeX_refresh';

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}
function setTokens({ accessToken: at, refreshToken: rt }) {
  accessToken = at ?? accessToken;
  if (rt) localStorage.setItem(REFRESH_KEY, rt);
}
// Module-private on purpose: ending the session is decided HERE (definitive refresh rejection
// in refreshSession, or an explicit logout) — never by callers reacting to transient failures.
function clearTokens() {
  accessToken = null;
  localStorage.removeItem(REFRESH_KEY);
}
export function hasSession() {
  return Boolean(accessToken || getRefreshToken());
}
export function getAccessToken() {
  return accessToken;
}

async function raw(path, { method = 'GET', body, auth = false } = {}) {
  // Only declare a JSON content-type when we actually send a body — Fastify rejects an EMPTY body when
  // content-type is application/json, which broke bodyless POSTs (e.g. withdrawal approve, market unpin).
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function req(path, opts = {}) {
  let res = await raw(path, opts);
  if (res.status === 401 && opts.auth && getRefreshToken()) {
    // try a single refresh + retry
    const ok = await refreshSession();
    if (ok) res = await raw(path, opts);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `request failed (${res.status})`);
  }
  return res.json();
}

// Single-flight: concurrent 401s share ONE rotation, so the rotating refresh token isn't
// presented twice (which the server would treat as reuse and revoke the whole session family).
export function refreshSession() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    let res;
    try {
      res = await raw('/auth/refresh', { method: 'POST', body: { refreshToken } });
    } catch {
      return false; // network blip — keep the session; a later request retries the refresh
    }
    if (res.ok) {
      setTokens(await res.json());
      return true;
    }
    // Only a DEFINITIVE rejection (expired/revoked/reuse-detected/malformed) ends the session.
    // Transient failures — 429 from the rate limiter, 5xx, proxies — must keep the refresh
    // token, or a blip silently logs the user out.
    if (res.status === 400 || res.status === 401 || res.status === 403) clearTokens();
    return false;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// --- auth ---
export const authNonce = (pubkey) => req('/auth/nonce', { method: 'POST', body: { pubkey } });
export async function authVerify(payload) {
  const data = await req('/auth/verify', { method: 'POST', body: payload });
  setTokens(data);
  return data;
}
export const authMe = () => req('/auth/me', { auth: true });
export async function authLogout() {
  try {
    await req('/auth/logout', { method: 'POST', auth: true, body: { refreshToken: getRefreshToken() } });
  } finally {
    clearTokens();
  }
}

// --- markets ---
export const getMarkets = () => req('/markets');
export const getCandles = (id, tf) => req(`/markets/${id}/candles?tf=${encodeURIComponent(tf)}`);
export const getMarketDetails = (id) => req(`/markets/${id}/details`);
// Search-and-bet: whole-catalog search (server-cached) + on-demand market listing (auth).
export const searchCatalog = (q, game) => req(`/catalog/search?q=${encodeURIComponent(q)}&game=${encodeURIComponent(game)}`);
export const ensureMarket = (providerCardId) => req('/markets/ensure', { method: 'POST', auth: true, body: { providerCardId } });

// --- account / trading ---
export const getBalance = () => req('/account/balance', { auth: true });
export const faucet = (amountUsd) => req('/faucet', { method: 'POST', auth: true, body: { amountUsd } });
export const getPositions = () => req('/positions', { auth: true });

// --- real-funds wallet (custody) ---
// /health carries the REAL_FUNDS flag — fetched once and cached (it can't change without a
// server restart). Decides faucet (play money) vs deposit/withdraw (real funds) UI.
let healthPromise = null;
export const getHealth = () => (healthPromise ??= req('/health'));
export const getDepositAddress = () => req('/wallet/deposit-address', { auth: true });
export const withdrawNonce = (amountE6, dest) =>
  req('/wallet/withdraw/nonce', { method: 'POST', auth: true, body: { amountE6, dest } });
export const withdraw = (body) => req('/wallet/withdraw', { method: 'POST', auth: true, body });
export const getWalletTransactions = () => req('/wallet/transactions', { auth: true });

// --- account history (trade-panel tabs) ---
export const getOrderHistory = () => req('/history/orders', { auth: true });
export const getTradeHistory = () => req('/history/trades', { auth: true });
export const getTransactionHistory = () => req('/history/transactions', { auth: true });
export const getPositionHistory = () => req('/history/positions', { auth: true });
export const openOrder = (body) => req('/orders', { method: 'POST', auth: true, body });
export const closePosition = (positionId, body) =>
  req(`/positions/${positionId}/close`, { method: 'POST', auth: true, body });

// --- social (leaderboard + referrals) ---
// Leaderboard is public; the optional Bearer (added when signed in) pins the caller's own row.
export const getLeaderboard = (limit = 100) => req(`/leaderboard?limit=${limit}`, { auth: true });
export const getReferral = () => req('/referral/me', { auth: true });
export const redeemReferral = (code) => req('/referral/redeem', { method: 'POST', auth: true, body: { code } });
export const setReferralCode = (code) => req('/referral/code', { method: 'POST', auth: true, body: { code } });

// --- global chat ---
export const getChat = () => req('/chat', { auth: true }); // auth optional: returns the viewer's own reactions
export const getChatRanks = () => req('/chat/ranks'); // { ranks: { userId: rank }, total } — top 100
export const getProfileCard = (userId) => req(`/chat/profile/${userId}`); // hover card: identity + rank + level
export const reactChat = (messageId, emoji) => req(`/chat/messages/${messageId}/react`, { method: 'POST', auth: true, body: { emoji } });
export const postChat = (body, replyTo) =>
  req('/chat', { method: 'POST', auth: true, body: { body, ...(replyTo ? { replyTo } : {}) } });
export const getProfile = () => req('/me/profile', { auth: true });
export const setUsername = (username) => req('/me/username', { method: 'POST', auth: true, body: { username } });

// Moderator actions (require a mod account; 403 otherwise).
export const chatDelete = (id) => req(`/chat/messages/${id}/delete`, { method: 'POST', auth: true });
export const chatMute = (userId, minutes) => req(`/chat/users/${userId}/mute`, { method: 'POST', auth: true, body: minutes ? { minutes } : {} });
export const chatUnmute = (userId) => req(`/chat/users/${userId}/unmute`, { method: 'POST', auth: true });
export const chatBan = (userId) => req(`/chat/users/${userId}/ban`, { method: 'POST', auth: true });
export const chatUnban = (userId) => req(`/chat/users/${userId}/unban`, { method: 'POST', auth: true });

// A ?ref=CODE link is captured on first load and held until the user signs in and redeems it.
const REF_KEY = 'pokeX_ref';
export function capturePendingReferral() {
  const code = new URLSearchParams(window.location.search).get('ref');
  if (code) localStorage.setItem(REF_KEY, code.trim().toUpperCase());
}
export const getPendingReferral = () => localStorage.getItem(REF_KEY);
export const clearPendingReferral = () => localStorage.removeItem(REF_KEY);

// --- LP ---
export const getPool = () => req('/lp/pool');
export const getLpPosition = () => req('/lp/position', { auth: true });
export const lpDeposit = (amountUsd) => req('/lp/deposit', { method: 'POST', auth: true, body: { amountUsd } });
export const lpWithdraw = (shares) => req('/lp/withdraw', { method: 'POST', auth: true, body: { shares } });

// --- admin (operator; authenticates with the ADMIN_API_KEY header, not the user Bearer) ---
async function adminReq(path, adminKey, body) {
  // No body => no JSON content-type (see raw()): approve/unpin send an empty body and Fastify would
  // otherwise reject it with "Body cannot be empty when content-type is set to 'application/json'".
  const headers = { 'x-admin-key': adminKey };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || `request failed (${res.status})`);
  }
  return res.json();
}
async function adminGet(path, adminKey) {
  const res = await fetch(`${API_URL}${path}`, { headers: { 'x-admin-key': adminKey } });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || `request failed (${res.status})`);
  }
  return res.json();
}
export const adminSetPrice = (id, body, adminKey) => adminReq(`/admin/markets/${id}/price`, adminKey, body);
export const adminUnpin = (id, adminKey) => adminReq(`/admin/markets/${id}/unpin`, adminKey);
// Chat moderation (operator): list mods/muted/banned + audit; grant/revoke MOD per user.
export const adminGetMods = (adminKey) => adminGet('/admin/chat/mods', adminKey);
export const adminSetMod = (userId, action, adminKey) => adminReq(`/admin/chat/mods/${userId}`, adminKey, { action });
// Treasury + insurance. /admin/treasury (full PoR view incl. insurance + allocatable surplus) is
// real-funds-only; /admin/insurance (balance) + the fee-allocation moves work in play-money too.
export const adminGetTreasury = (adminKey) => adminGet('/admin/treasury', adminKey);
export const adminGetInsurance = (adminKey) => adminGet('/admin/insurance', adminKey);
// House economics for the Overview (ledger-derived) — works in BOTH fund modes, unlike /admin/treasury.
export const adminGetEconomics = (adminKey) => adminGet('/admin/economics', adminKey);
export const adminInsuranceFromFees = (amountUusdc, adminKey) => adminReq('/admin/insurance/from-fees', adminKey, { amountUusdc });
export const adminInsuranceToFees = (amountUusdc, adminKey) => adminReq('/admin/insurance/to-fees', adminKey, { amountUusdc });
export const adminInsuranceFromTreasury = (amountUusdc, adminKey) => adminReq('/admin/insurance/from-treasury', adminKey, { amountUusdc });
// Live-tunable custody limits. GET -> { current, defaults }; POST a partial -> { current }.
export const adminGetCustodyLimits = (adminKey) => adminGet('/admin/custody-limits', adminKey);
export const adminSetCustodyLimits = (limits, adminKey) => adminReq('/admin/custody-limits', adminKey, limits);
// Live trading fee (bps; 1 bps = 0.01%). GET -> { bps, default }; POST { bps } -> the new effective fee.
export const adminGetFee = (adminKey) => adminGet('/admin/fee', adminKey);
export const adminSetFee = (bps, adminKey) => adminReq('/admin/fee', adminKey, { bps });
// Live liquidation penalty (bps; charged on a liquidated position's notional -> insurance fund).
export const adminGetLiqFee = (adminKey) => adminGet('/admin/liq-fee', adminKey);
export const adminSetLiqFee = (bps, adminKey) => adminReq('/admin/liq-fee', adminKey, { bps });
// Live funding factor (bps; max hourly funding rate at full skew). GET -> { bps, default }; POST { bps }.
export const adminGetFundingFactor = (adminKey) => adminGet('/admin/funding-factor', adminKey);
export const adminSetFundingFactor = (bps, adminKey) => adminReq('/admin/funding-factor', adminKey, { bps });
// Per-customer operator view (paginated + sortable) -> { customers: [...], total }.
export const adminGetCustomers = ({ limit = 50, offset = 0, sort = 'volume' } = {}, adminKey) =>
  adminGet(`/admin/customers?limit=${limit}&offset=${offset}&sort=${encodeURIComponent(sort)}`, adminKey);
// One customer's open positions per market (expand-row drill-down) -> { positions: [...] }.
export const adminGetCustomerPositions = (userId, adminKey) => adminGet(`/admin/customers/${userId}/positions`, adminKey);
// Operator position closes (recorded as platform closes). Scopes: one position, one customer, ALL customers.
export const adminClosePosition = (userId, positionId, adminKey) =>
  adminReq(`/admin/customers/${userId}/positions/${positionId}/close`, adminKey);
export const adminCloseUserPositions = (userId, adminKey) => adminReq(`/admin/customers/${userId}/positions/close-all`, adminKey);
export const adminCloseAllPositions = (adminKey) => adminReq('/admin/positions/close-all', adminKey);
// EMERGENCY: liquidate every underwater position now (close-all can't touch liquidatable ones).
export const adminLiquidateAll = (adminKey) => adminReq('/admin/positions/liquidate', adminKey);
// Per-asset trading stats + total net exposure -> { markets: [...], totals: { netCappedE6, netRawE6 } }.
export const adminGetMarketStats = (adminKey) => adminGet('/admin/market-stats', adminKey);
// Price-confidence gate: card markets restricted (reduce-only) now + the ones that flipped into restricted today.
export const adminGetRestrictions = (adminKey) => adminGet('/admin/restrictions', adminKey);
// Withdrawal queue (real-funds). GET by status; approve = sign+broadcast; reverse = re-credit an unpaid row.
export const adminGetWithdrawals = (status, adminKey) => adminGet(`/admin/withdrawals?status=${encodeURIComponent(status)}`, adminKey);
export const adminApproveWithdrawal = (id, adminKey) => adminReq(`/admin/withdrawals/${id}/approve`, adminKey);
export const adminReverseWithdrawal = (id, reason, adminKey) => adminReq(`/admin/withdrawals/${id}/reverse`, adminKey, { reason });

export const apiConfig = { API_URL };
