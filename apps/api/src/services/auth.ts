import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { Db, Queryer } from '../db/client.ts';
import { fmtUusdc } from '../money.ts';
import { assignReferralCode } from './referral.ts';

/**
 * Sign-In-With-Solana. The wallet signs a server-issued, single-use challenge; we
 * verify ed25519 server-side, then issue a short access JWT + a rotating refresh token
 * (reuse-detected by family). The signed message is deterministic from (pubkey, nonce)
 * and re-rendered server-side at verify time, so a tampered client message can't change
 * what was actually checked.
 */

const jwtKey = new TextEncoder().encode(config.jwtSecret);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Token/session scope. 'full' = the master wallet (everything); 'trade' = a delegated key
 *  (open/close positions only — never withdraw, move funds, or manage identity/delegates). */
export type Scope = 'full' | 'trade';

export function buildLoginMessage(pubkey: string, nonce: string): string {
  return [
    'GachaDex wants you to sign in with your Solana account:',
    pubkey,
    '',
    'Statement: Authenticate to GachaDex. This signature does not authorize any transaction or transfer of funds.',
    `Domain: ${config.authDomain}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

/**
 * Withdrawal step-up message (custody P2). A withdrawal needs a FRESH wallet signature over the
 * exact amount + destination — a stolen access/refresh token alone can't move funds. Deterministic
 * from (pubkey, amountE6, dest, nonce) and re-rendered server-side at verify time, like login.
 */
export function buildWithdrawalMessage(pubkey: string, p: { amountE6: bigint; dest: string; nonce: string }): string {
  return [
    'GachaDex withdrawal authorization:',
    pubkey,
    '',
    `Authorize a withdrawal of ${fmtUusdc(p.amountE6)} USDC to:`,
    p.dest,
    '',
    'Statement: This signature authorizes ONLY the single withdrawal above (exact amount and destination).',
    `Domain: ${config.authDomain}`,
    `Nonce: ${p.nonce}`,
  ].join('\n');
}

/**
 * Trading-key delegation message (docs/cli-spec.md Part 1). The MASTER wallet signs this to authorize
 * a separate `delegatePubkey` to TRADE on its account — never to withdraw. Deterministic from
 * (master, delegate, label, expiresAt, mode, nonce) and re-rendered server-side at verify time, like
 * login. `label` is pre-validated to printable ASCII with no newlines, so it can't forge a message
 * line; `expiresAt` is echoed verbatim (validated as bounded ISO-8601 UTC elsewhere). `Mode` binds the
 * signature to play-money vs real-funds so an authorization can't be replayed across deployments.
 */
export function buildDelegationMessage(
  pubkey: string,
  p: { delegatePubkey: string; label: string; expiresAt: string | null; nonce: string },
): string {
  return [
    'GachaDex trading-key delegation:',
    pubkey,
    '',
    'Statement: Authorize the key below to TRADE on this account. It can open and close positions but can NOT withdraw or transfer funds, and can be revoked at any time.',
    `Delegate: ${p.delegatePubkey}`,
    `Label: ${p.label}`,
    `Expires: ${p.expiresAt ?? 'never'}`,
    `Mode: ${config.realFunds ? 'real-funds' : 'play-money'}`,
    `Domain: ${config.authDomain}`,
    `Nonce: ${p.nonce}`,
  ].join('\n');
}

/**
 * NFT-withdrawal step-up (Classic Gacha P2). Sending a won graded-card NFT off-platform needs a FRESH
 * wallet signature over the exact mint + destination — same posture as a USDC withdrawal (a stolen token
 * alone can't move the asset). Deterministic from (pubkey, mint, dest, nonce), re-rendered at verify time.
 */
export function buildNftWithdrawMessage(pubkey: string, p: { mint: string; dest: string; nonce: string }): string {
  return [
    'GachaDex NFT withdrawal authorization:',
    pubkey,
    '',
    'Authorize sending this card (NFT) to:',
    p.dest,
    `Mint: ${p.mint}`,
    '',
    'Statement: This signature authorizes ONLY the single NFT transfer above (exact mint and destination).',
    `Domain: ${config.authDomain}`,
    `Nonce: ${p.nonce}`,
  ].join('\n');
}

export function isValidPubkey(pubkey: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(pubkey);
    return true;
  } catch {
    return false;
  }
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; pubkey: string };
}

/** Issue a single-use, 5-minute challenge nonce bound to a pubkey + purpose (login | withdraw |
 *  delegate). The purpose tag keeps a nonce minted for one flow from being claimed by another. */
async function insertNonce(db: Db, pubkey: string, purpose: 'login' | 'withdraw' | 'delegate' | 'nft-withdraw' = 'login'): Promise<string> {
  if (!isValidPubkey(pubkey)) throw new HttpError(400, 'invalid pubkey');
  const nonce = bs58.encode(randomBytes(24));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.query(`INSERT INTO auth_nonces(nonce, pubkey, purpose, expires_at) VALUES($1, $2, $3, $4)`, [
    nonce,
    pubkey,
    purpose,
    expiresAt.toISOString(),
  ]);
  return nonce;
}

export async function createNonce(db: Db, pubkey: string): Promise<{ nonce: string; message: string }> {
  const nonce = await insertNonce(db, pubkey);
  return { nonce, message: buildLoginMessage(pubkey, nonce) };
}

export async function createWithdrawalNonce(
  db: Db,
  pubkey: string,
  p: { amountE6: bigint; dest: string },
): Promise<{ nonce: string; message: string }> {
  if (!isValidPubkey(p.dest)) throw new HttpError(400, 'invalid destination address');
  const nonce = await insertNonce(db, pubkey, 'withdraw');
  return { nonce, message: buildWithdrawalMessage(pubkey, { ...p, nonce }) };
}

export async function createNftWithdrawNonce(
  db: Db,
  pubkey: string,
  p: { mint: string; dest: string },
): Promise<{ nonce: string; message: string }> {
  if (!isValidPubkey(p.dest)) throw new HttpError(400, 'invalid destination address');
  const nonce = await insertNonce(db, pubkey, 'nft-withdraw');
  return { nonce, message: buildNftWithdrawMessage(pubkey, { ...p, nonce }) };
}

/**
 * Verify a wallet signature over a server-rendered, single-use nonce message, then atomically claim
 * the nonce (replay/race defense). `render(nonce)` rebuilds the exact message the server expects, so
 * a tampered client message can't change what is actually checked. Shared by login + withdrawal step-up.
 * Takes a Queryer so it can run inside a caller's transaction (the withdrawal flow claims the nonce
 * atomically with the withdrawal row — a rolled-back request leaves the nonce retryable).
 */
async function verifyNonceSignature(
  db: Queryer,
  pubkey: string,
  message: string,
  signature: string,
  render: (nonce: string) => string,
  purpose: 'login' | 'withdraw' | 'delegate' | 'nft-withdraw' = 'login',
): Promise<void> {
  if (!isValidPubkey(pubkey)) throw new HttpError(400, 'invalid pubkey');
  const nonce = message.match(/^Nonce: (.+)$/m)?.[1];
  if (!nonce) throw new HttpError(400, 'message missing nonce');

  const row = await db.query<{ pubkey: string; used: boolean; expired: boolean; purpose: string }>(
    `SELECT pubkey, used, (expires_at < now()) AS expired, purpose FROM auth_nonces WHERE nonce = $1`,
    [nonce],
  );
  const n = row.rows[0];
  if (!n || n.pubkey !== pubkey || n.used || n.expired || n.purpose !== purpose)
    throw new HttpError(401, 'invalid or expired nonce', 'nonce_invalid');

  // Verify the signature against the SERVER-rendered message (not the client's text).
  const expected = render(nonce);
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(
      new TextEncoder().encode(expected),
      bs58.decode(signature),
      new PublicKey(pubkey).toBytes(),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, 'signature verification failed', 'signature_invalid');

  // Atomically claim the nonce (defends against replay/races).
  const claim = await db.query<{ nonce: string }>(
    `UPDATE auth_nonces SET used = true WHERE nonce = $1 AND used = false RETURNING nonce`,
    [nonce],
  );
  if (claim.rows.length === 0) throw new HttpError(401, 'nonce already used', 'nonce_used');
}

/** Withdrawal step-up: a fresh wallet signature over the exact (amount, dest) — token theft can't withdraw. */
export async function verifyWithdrawalStepUp(
  db: Queryer,
  p: { pubkey: string; amountE6: bigint; dest: string; message: string; signature: string },
): Promise<void> {
  await verifyNonceSignature(
    db,
    p.pubkey,
    p.message,
    p.signature,
    (nonce) => buildWithdrawalMessage(p.pubkey, { amountE6: p.amountE6, dest: p.dest, nonce }),
    'withdraw',
  );
}

/** NFT-withdrawal step-up: a fresh wallet signature over the exact (mint, dest) — token theft can't withdraw. */
export async function verifyNftWithdrawStepUp(
  db: Queryer,
  p: { pubkey: string; mint: string; dest: string; message: string; signature: string },
): Promise<void> {
  await verifyNonceSignature(
    db,
    p.pubkey,
    p.message,
    p.signature,
    (nonce) => buildNftWithdrawMessage(p.pubkey, { mint: p.mint, dest: p.dest, nonce }),
    'nft-withdraw',
  );
}

// pubkey is always the ACCOUNT (master) pubkey; for a delegated session `act` carries the delegate
// pubkey that actually signed in (audit + WS/route scoping). Absent scope claim is read as 'full'.
async function mintAccessToken(userId: string, pubkey: string, sid: string, scope: Scope = 'full', act?: string): Promise<string> {
  const claims: Record<string, unknown> = { pubkey, sid, scope };
  if (act) claims.act = act;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlSec}s`)
    .sign(jwtKey);
}

async function createSession(
  db: Queryer,
  userId: string,
  opts: { family?: string; scope?: Scope; delegatePubkey?: string | null } = {},
): Promise<{ sid: string; refreshToken: string }> {
  const sid = randomUUID();
  const fam = opts.family ?? randomUUID();
  const secret = bs58.encode(randomBytes(32));
  const expiresAt = new Date(Date.now() + config.refreshTtlSec * 1000);
  await db.query(
    `INSERT INTO sessions(id, user_id, refresh_hash, family, scope, delegate_pubkey, expires_at) VALUES($1, $2, $3, $4, $5, $6, $7)`,
    [sid, userId, sha256(secret), fam, opts.scope ?? 'full', opts.delegatePubkey ?? null, expiresAt.toISOString()],
  );
  return { sid, refreshToken: `${sid}.${secret}` };
}

// Takes a Queryer (not just Db) so it can run inside a larger transaction (e.g. affiliate setup) or
// standalone (login passes the Db, which is a Queryer).
export async function upsertUser(q: Queryer, pubkey: string): Promise<string> {
  const id = randomUUID();
  const ins = await q.query<{ id: string }>(
    `INSERT INTO users(id, solana_pubkey) VALUES($1, $2) ON CONFLICT(solana_pubkey) DO NOTHING RETURNING id`,
    [id, pubkey],
  );
  if (ins.rows[0]) await assignReferralCode(q, ins.rows[0].id); // give each new account a referral code
  const r = await q.query<{ id: string }>(`SELECT id FROM users WHERE solana_pubkey = $1`, [pubkey]);
  return r.rows[0].id;
}

// ===========================================================================
// Delegated trading keys (docs/cli-spec.md Part 1)
// ===========================================================================

interface DelegateState {
  user_id: string;
  expired: boolean;
  revoked: boolean;
}

/** Look up a delegate pubkey: its master account + whether it's expired/revoked (null if not a delegate). */
async function getDelegate(db: Queryer, pubkey: string): Promise<DelegateState | null> {
  const r = await db.query<DelegateState>(
    `SELECT user_id,
            (expires_at IS NOT NULL AND expires_at < now()) AS expired,
            (revoked_at IS NOT NULL) AS revoked
     FROM delegated_keys WHERE pubkey = $1`,
    [pubkey],
  );
  return r.rows[0] ?? null;
}

/** Validate + normalize delegation params (shared by the nonce + verify steps so the rendered
 *  message is identical at both). Returns the verbatim `expiresAt` string (for the message) and its
 *  parsed Date (for the DB). */
function validateDelegateParams(
  masterPubkey: string,
  p: { delegatePubkey: string; label?: string; expiresAt?: string },
): { delegatePubkey: string; label: string; expiresAt: string | null; expiresDate: Date | null } {
  if (!isValidPubkey(p.delegatePubkey)) throw new HttpError(400, 'invalid delegate pubkey', 'invalid_pubkey');
  if (p.delegatePubkey === masterPubkey) throw new HttpError(400, 'a key cannot delegate to itself', 'delegate_self');
  const label = p.label ?? '';
  if (!/^[\x20-\x7E]{0,64}$/.test(label)) throw new HttpError(400, 'label must be <=64 printable ASCII chars (no newlines)', 'invalid_label');
  let expiresDate: Date | null = null;
  if (p.expiresAt != null) {
    const d = new Date(p.expiresAt);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'expiresAt must be ISO-8601', 'invalid_expiry');
    if (d.getTime() <= Date.now()) throw new HttpError(400, 'expiresAt must be in the future', 'invalid_expiry');
    if (d.getTime() > Date.now() + config.delegateMaxTtlMs)
      throw new HttpError(400, `expiresAt is beyond the max delegation lifetime (${config.delegateMaxTtlMs / 86_400_000} days)`, 'invalid_expiry');
    expiresDate = d;
  }
  return { delegatePubkey: p.delegatePubkey, label, expiresAt: p.expiresAt ?? null, expiresDate };
}

/** Issue a delegation challenge: the MASTER signs the returned message to authorize `delegatePubkey`. */
export async function createDelegateNonce(
  db: Db,
  masterPubkey: string,
  p: { delegatePubkey: string; label?: string; expiresAt?: string },
): Promise<{ nonce: string; message: string }> {
  const v = validateDelegateParams(masterPubkey, p);
  const nonce = await insertNonce(db, masterPubkey, 'delegate');
  return { nonce, message: buildDelegationMessage(masterPubkey, { delegatePubkey: v.delegatePubkey, label: v.label, expiresAt: v.expiresAt, nonce }) };
}

export interface DelegateView {
  pubkey: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
}

/** Verify the master's signature over the delegation message and register the trade-only key.
 *  Runs in one transaction with a row lock on the master so the cap + collision checks are race-free. */
export async function verifyAndCreateDelegate(
  db: Db,
  master: { userId: string; pubkey: string },
  input: { delegatePubkey: string; label?: string; expiresAt?: string; message: string; signature: string },
): Promise<DelegateView> {
  const v = validateDelegateParams(master.pubkey, input);
  return db.tx(async (q) => {
    // serialize concurrent delegate-creates for this master (the cap is read-then-write)
    await q.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [master.userId]);
    // verify the MASTER's signature over the delegation message + atomically claim the nonce
    await verifyNonceSignature(
      q,
      master.pubkey,
      input.message,
      input.signature,
      (nonce) => buildDelegationMessage(master.pubkey, { delegatePubkey: v.delegatePubkey, label: v.label, expiresAt: v.expiresAt, nonce }),
      'delegate',
    );
    // collision: a delegate pubkey can never be an account, nor reuse a prior delegate slot (revoked = burned)
    if ((await q.query(`SELECT 1 FROM users WHERE solana_pubkey = $1`, [v.delegatePubkey])).rows[0])
      throw new HttpError(409, 'that key is already a GachaDex account', 'delegate_is_user');
    if ((await q.query(`SELECT 1 FROM delegated_keys WHERE pubkey = $1`, [v.delegatePubkey])).rows[0])
      throw new HttpError(409, 'that delegate key already exists (revoked keys are permanent — generate a new key)', 'delegate_exists');
    const active = await q.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM delegated_keys WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [master.userId],
    );
    if (Number(active.rows[0].n) >= config.maxDelegatedKeys)
      throw new HttpError(409, `delegate key limit reached (max ${config.maxDelegatedKeys}); revoke one first`, 'delegate_cap_reached');
    const expiresAtIso = v.expiresDate ? v.expiresDate.toISOString() : null;
    const r = await q.query<{ created_at: string }>(
      `INSERT INTO delegated_keys(pubkey, user_id, label, expires_at) VALUES($1, $2, $3, $4) RETURNING created_at`,
      [v.delegatePubkey, master.userId, v.label, expiresAtIso],
    );
    return {
      pubkey: v.delegatePubkey,
      label: v.label,
      createdAt: r.rows[0].created_at,
      expiresAt: expiresAtIso,
      revokedAt: null,
      active: true,
    };
  });
}

/** List a master account's delegate keys (active + revoked), newest first. */
export async function listDelegates(db: Db, userId: string): Promise<DelegateView[]> {
  const r = await db.query<{ pubkey: string; label: string; created_at: string; expires_at: string | null; revoked_at: string | null }>(
    `SELECT pubkey, label, created_at, expires_at, revoked_at FROM delegated_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return r.rows.map((d) => ({
    pubkey: d.pubkey,
    label: d.label,
    createdAt: d.created_at,
    expiresAt: d.expires_at,
    revokedAt: d.revoked_at,
    active: !d.revoked_at && (!d.expires_at || new Date(d.expires_at).getTime() > Date.now()),
  }));
}

/** Revoke a delegate key (permanent) and immediately kill any live sessions it holds. */
export async function revokeDelegate(db: Db, userId: string, pubkey: string): Promise<void> {
  const r = await db.query<{ pubkey: string }>(
    `UPDATE delegated_keys SET revoked_at = now() WHERE pubkey = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING pubkey`,
    [pubkey, userId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'no such active delegate key', 'delegate_not_found');
  // revocation is immediate, not TTL-bounded: drop the delegate's sessions so its refresh tokens die now
  await db.query(`UPDATE sessions SET revoked = true WHERE delegate_pubkey = $1`, [pubkey]);
}

export async function verifyAndLogin(
  db: Db,
  input: { pubkey: string; message: string; signature: string },
): Promise<LoginResult> {
  const { pubkey, message, signature } = input;
  await verifyNonceSignature(db, pubkey, message, signature, (nonce) => buildLoginMessage(pubkey, nonce), 'login');

  // Is this a delegated trading key? Check BEFORE upsertUser — a delegate must never get its own
  // users row (that would shadow the account and permanently block re-delegation).
  const delegate = await getDelegate(db, pubkey);
  let userId: string;
  let accountPubkey: string;
  let scope: Scope;
  let act: string | undefined;
  if (delegate) {
    if (delegate.revoked || delegate.expired) throw new HttpError(401, 'delegate key is revoked or expired', 'delegate_revoked');
    // active delegate -> trade scope on the MASTER account
    userId = delegate.user_id;
    accountPubkey = (await db.query<{ solana_pubkey: string }>(`SELECT solana_pubkey FROM users WHERE id = $1`, [userId])).rows[0].solana_pubkey;
    scope = 'trade';
    act = pubkey;
  } else {
    userId = await upsertUser(db, pubkey);
    accountPubkey = pubkey;
    scope = 'full';
  }
  const { sid, refreshToken } = await createSession(db, userId, { scope, delegatePubkey: act ?? null });
  const accessToken = await mintAccessToken(userId, accountPubkey, sid, scope, act);
  return { accessToken, refreshToken, expiresIn: config.accessTtlSec, user: { id: userId, pubkey: accountPubkey } };
}

export async function refresh(db: Db, refreshToken: string): Promise<LoginResult> {
  const [sid, secret] = refreshToken.split('.');
  if (!sid || !secret) throw new HttpError(401, 'malformed refresh token');

  const r = await db.query<{ user_id: string; refresh_hash: string; family: string; revoked: boolean; expired: boolean; scope: string; delegate_pubkey: string | null }>(
    `SELECT user_id, refresh_hash, family, revoked, (expires_at < now()) AS expired, scope, delegate_pubkey FROM sessions WHERE id = $1`,
    [sid],
  );
  const s = r.rows[0];
  if (!s) throw new HttpError(401, 'unknown session');

  // Reuse of a revoked session, or a wrong secret = theft signal -> revoke the whole family.
  if (s.revoked || sha256(secret) !== s.refresh_hash) {
    await db.query(`UPDATE sessions SET revoked = true WHERE family = $1`, [s.family]);
    throw new HttpError(401, 'refresh token reuse detected', 'refresh_reuse');
  }
  if (s.expired) throw new HttpError(401, 'refresh token expired', 'refresh_expired');

  // A delegated session re-checks the delegate row on EVERY rotation, so revoking/expiring a key
  // takes effect within one access-token TTL even though the refresh token lives for days.
  const scope: Scope = s.scope === 'trade' ? 'trade' : 'full';
  // invariant: a trade session is always bound to a delegate. A trade scope without one is corrupt
  // data (it would otherwise rotate forever with no revocation re-check) — refuse it.
  if (scope === 'trade' && !s.delegate_pubkey) throw new HttpError(401, 'invalid session', 'invalid_session');
  let act: string | undefined;
  if (s.delegate_pubkey) {
    const del = await getDelegate(db, s.delegate_pubkey);
    if (!del || del.revoked || del.expired) {
      await db.query(`UPDATE sessions SET revoked = true WHERE family = $1`, [s.family]);
      throw new HttpError(401, 'delegate key is revoked or expired', 'delegate_revoked');
    }
    act = s.delegate_pubkey;
  }

  // Rotate: revoke this session, mint a new one in the same family (carrying scope + delegate).
  await db.query(`UPDATE sessions SET revoked = true WHERE id = $1`, [sid]);
  const u = await db.query<{ solana_pubkey: string }>(`SELECT solana_pubkey FROM users WHERE id = $1`, [s.user_id]);
  const pubkey = u.rows[0]?.solana_pubkey;
  if (!pubkey) throw new HttpError(401, 'user not found');
  const next = await createSession(db, s.user_id, { family: s.family, scope, delegatePubkey: s.delegate_pubkey });
  const accessToken = await mintAccessToken(s.user_id, pubkey, next.sid, scope, act);
  return { accessToken, refreshToken: next.refreshToken, expiresIn: config.accessTtlSec, user: { id: s.user_id, pubkey } };
}

/**
 * Log out. With a refresh token: revokes just that session. Without one ("log out everywhere"): a
 * full-scope (master) session revokes ALL the account's sessions; a trade-scoped delegate may only
 * revoke its OWN sessions — never the master's — so a leaked trade key can't log the owner out.
 */
export async function logout(
  db: Db,
  refreshToken: string | undefined,
  ctx: { userId: string; scope: Scope; actor?: string },
): Promise<void> {
  if (refreshToken) {
    const [sid] = refreshToken.split('.');
    if (sid) {
      // a trade key may only end ITS OWN sessions, even by id — never a master/sibling session
      if (ctx.scope === 'trade') {
        await db.query(`UPDATE sessions SET revoked = true WHERE id = $1 AND user_id = $2 AND delegate_pubkey = $3`, [sid, ctx.userId, ctx.actor ?? '']);
      } else {
        await db.query(`UPDATE sessions SET revoked = true WHERE id = $1 AND user_id = $2`, [sid, ctx.userId]);
      }
    }
    return;
  }
  if (ctx.scope === 'trade') {
    await db.query(`UPDATE sessions SET revoked = true WHERE user_id = $1 AND delegate_pubkey = $2`, [ctx.userId, ctx.actor ?? '']);
  } else {
    await db.query(`UPDATE sessions SET revoked = true WHERE user_id = $1`, [ctx.userId]);
  }
}

export async function verifyAccessToken(token: string): Promise<{ userId: string; pubkey: string; sid: string; scope: Scope; act?: string; exp: number }> {
  const { payload } = await jwtVerify(token, jwtKey, { algorithms: ['HS256'] }); // pin the alg (defense-in-depth)
  return {
    userId: String(payload.sub),
    pubkey: String(payload.pubkey),
    sid: String(payload.sid),
    scope: payload.scope === 'trade' ? 'trade' : 'full', // absent/legacy claim => full
    act: payload.act ? String(payload.act) : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : 0, // unix seconds; drives WS auth expiry
  };
}
