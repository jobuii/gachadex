/**
 * Operator push alerts (custody/RPC health). Best-effort fan-out over any CONFIGURED channel —
 * Telegram, Discord, and Email (via Resend's HTTP API, so no SMTP dependency). Every channel is
 * independent and optional: an unset channel is skipped, and a channel that errors or times out is
 * logged and never blocks the others (or the caller). Alerts are low-volume and edge-triggered
 * (incident start / recovery), so a plain fetch per channel — no queue, no retry — is the right size.
 */
import { config } from '../config.ts';

// A minimal logger shape (Fastify's logger satisfies it) so notify never depends on Fastify types.
type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

const SEND_TIMEOUT_MS = 8_000;

/** True when at least one alert channel is configured — the health checker skips its work otherwise. */
export function alertingEnabled(): boolean {
  return channelsConfigured().length > 0;
}

/** Names of the configured channels (for logging / an admin readout). */
export function channelsConfigured(): string[] {
  const out: string[] = [];
  if (config.alertTelegramBotToken && config.alertTelegramChatId) out.push('telegram');
  if (config.alertDiscordWebhookUrl) out.push('discord');
  if (config.alertResendApiKey && config.alertEmailFrom && config.alertEmailTo) out.push('email');
  return out;
}

// A single channel post, hard-bounded by a timeout so a hung endpoint can't stall the worker loop.
async function post(url: string, init: RequestInit): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan an alert out to every configured channel. Resolves once all channels have settled; a channel
 * failure is logged (never thrown) so one bad channel can't suppress the rest or crash the caller.
 */
export async function sendAlert(subject: string, body: string, log?: Logger): Promise<void> {
  const channels = channelsConfigured();
  if (channels.length === 0) return;
  const text = `${subject}\n\n${body}`;

  const jobs: Array<Promise<void>> = [];

  if (config.alertTelegramBotToken && config.alertTelegramChatId) {
    jobs.push(
      post(`https://api.telegram.org/bot${config.alertTelegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.alertTelegramChatId, text, disable_web_page_preview: true }),
      }).catch((e) => log?.warn({ err: String(e) }, 'alert: telegram send failed')),
    );
  }
  if (config.alertDiscordWebhookUrl) {
    jobs.push(
      post(config.alertDiscordWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Discord caps content at 2000 chars.
        body: JSON.stringify({ username: 'GachaDex Custody', content: text.slice(0, 1900) }),
      }).catch((e) => log?.warn({ err: String(e) }, 'alert: discord send failed')),
    );
  }
  if (config.alertResendApiKey && config.alertEmailFrom && config.alertEmailTo) {
    jobs.push(
      post('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.alertResendApiKey}` },
        body: JSON.stringify({
          from: config.alertEmailFrom,
          to: config.alertEmailTo.split(',').map((s) => s.trim()).filter(Boolean),
          subject,
          text: body,
        }),
      }).catch((e) => log?.warn({ err: String(e) }, 'alert: email send failed')),
    );
  }

  await Promise.all(jobs);
  log?.info({ channels }, `custody alert sent: ${subject}`);
}
