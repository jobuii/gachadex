import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { onMessage, publish } from '../services/bus.ts';
import { verifyAccessToken } from '../services/auth.ts';
import { WS_PRIVATE_CHANNELS } from '@pokex/shared-types';

/** Minimal shape of the ws WebSocket we use (avoids an @types/ws dependency). */
interface Sock {
  send: (data: string) => void;
  on: (event: string, cb: (...args: any[]) => void) => void;
  readyState: number;
}

// Per-user channels are private; a client may only subscribe to its OWN.
const isPrivate = (ch: string) => WS_PRIVATE_CHANNELS.some((p) => ch.startsWith(p + ':'));

/** Frame + send to a socket, swallowing the throw if the client has gone. */
function send(socket: Sock, ch: string, type: string, data: unknown, seq = 0): void {
  try { socket.send(JSON.stringify({ ch, type, seq, data })); } catch { /* client gone */ }
}

// Presence: count of live WS connections on THIS instance (incl. anonymous viewers), broadcast on the
// public `chat` channel as a `presence` event. Bursts of connect/disconnect coalesce into one broadcast.
// Multi-instance shows each instance's own count, not an aggregate — acceptable for now.
let onlineCount = 0;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastPresence(): void {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => { presenceTimer = null; publish('chat', 'presence', { online: onlineCount }); }, 250);
}

/**
 * WebSocket hub at /ws. Public channels (mark/stats/oi/funding) are open. Private per-user
 * channels require authentication: the client sends an {op:'auth', token} message and may only
 * subscribe to channels suffixed with its own userId. Subscriptions wait on the in-flight auth so
 * there's no auth/sub ordering race. The token is never accepted in the URL (which would log it).
 */
export async function registerWs(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  app.get('/ws', { websocket: true }, (socket: Sock) => {
    const channels = new Set<string>();
    const seq = new Map<string, number>();
    onlineCount += 1;
    broadcastPresence();
    let userId: string | null = null;
    let authExpMs = 0; // when the auth'd token expires (ms); 0 = not authed
    let authReady: Promise<void> = Promise.resolve();
    // Auth is bounded by the access token's lifetime: a revoked/expired key can't keep streaming
    // private data by holding the socket open — once the token expires the client MUST re-auth.
    const authed = () => userId !== null && Date.now() < authExpMs;

    const unsub = onMessage((m) => {
      if (!channels.has(m.channel)) return;
      // stop delivering a private channel the moment the token expires, and drop the dead sub
      if (isPrivate(m.channel) && !authed()) {
        channels.delete(m.channel);
        return;
      }
      const n = (seq.get(m.channel) ?? 0) + 1;
      seq.set(m.channel, n);
      send(socket, m.channel, m.type, m.data, n);
    });

    socket.on('message', async (buf: Buffer) => {
      let msg: { op?: string; channels?: string[]; token?: string };
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (msg.op === 'auth' && typeof msg.token === 'string') {
        // assign authReady synchronously so a following 'sub' awaits this verification
        authReady = verifyAccessToken(msg.token)
          .then((r) => { userId = r.userId; authExpMs = r.exp * 1000; })
          .catch(() => { userId = null; authExpMs = 0; });
        await authReady;
        send(socket, '_', 'authed', { ok: authed() });
      } else if (msg.op === 'sub' && Array.isArray(msg.channels)) {
        await authReady;
        for (const c of msg.channels) {
          if (isPrivate(c)) {
            if (authed() && c.split(':')[1] === userId) channels.add(c); // only your own private channel, while authed
          } else {
            channels.add(c);
          }
        }
        // a chat subscriber gets the current online count immediately (the broadcast only reaches existing subs)
        if (channels.has('chat')) send(socket, 'chat', 'presence', { online: onlineCount });
      } else if (msg.op === 'unsub' && Array.isArray(msg.channels)) {
        for (const c of msg.channels) channels.delete(c);
      } else if (msg.op === 'ping') {
        send(socket, '_', 'pong', { ts: Date.now() });
      }
    });

    // close + error can both fire — guard so a socket is only counted out once
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsub();
      onlineCount -= 1;
      broadcastPresence();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
