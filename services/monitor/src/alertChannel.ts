// Alert delivery channels. Default posture is log-only/dry-run (no
// network, ever) -- same "alerts are a convenience, never load-bearing"
// rule as the rest of this repo (notifier.ts, telegram.ts). Real
// delivery reuses notifier/src/telegram.ts's TelegramChannel verbatim
// (same Bot API call, retry/backoff, PII-safe failure logging) against
// an operator chat id, never a bettor's -- this is an OPS channel.
import type { TelegramChannel } from "../../notifier/src/telegram.js";
import type { Alert } from "./alertsCore.js";

export interface AlertChannel {
  send(alert: Alert): Promise<void>;
}

/** Default channel: logs the alert (via an injectable logger, default
 * console.log) and does nothing else. What every deployment gets
 * unless an operator Telegram chat is explicitly configured (see
 * runner.ts's main()). */
export class LogOnlyAlertChannel implements AlertChannel {
  constructor(private readonly log: (msg: string) => void = (m) => console.log(m)) {}

  async send(alert: Alert): Promise<void> {
    this.log(`[ALERT:${alert.severity}] ${alert.kind} ${alert.key}: ${alert.message} -- ${alert.detail}`);
  }
}

/** Operator Telegram channel: delegates to notifier's existing
 * TelegramChannel.send -- this file adds no new HTTP/retry logic of
 * its own, it only formats the message and picks the operator chat id. */
export class TelegramAlertChannel implements AlertChannel {
  constructor(
    private readonly channel: TelegramChannel,
    private readonly operatorChatId: string,
  ) {}

  async send(alert: Alert): Promise<void> {
    const text = `[${alert.severity.toUpperCase()}] ${alert.message}\n${alert.detail}`;
    await this.channel.send(this.operatorChatId, text);
  }
}

/** Fans the same alert out to every configured channel (e.g. log file
 * AND Telegram at once) -- additive, never a replacement for any one
 * channel. A single channel throwing is caught and logged; it never
 * blocks delivery to the others. */
export class MultiAlertChannel implements AlertChannel {
  constructor(private readonly channels: AlertChannel[]) {}

  async send(alert: Alert): Promise<void> {
    for (const c of this.channels) {
      try {
        await c.send(alert);
      } catch (err) {
        console.error("alert channel failed", err);
      }
    }
  }
}

/** LH5: generic JSON webhook (POST {severity,kind,key,message,detail}). Opt-in by URL only; the
 * fetch is injectable so tests never touch the network. Throws on a non-2xx so MultiAlertChannel logs it. */
export class WebhookAlertChannel implements AlertChannel {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: (url: string, init: any) => Promise<{ ok: boolean; status: number }> = (u, i) => fetch(u, i),
  ) {}

  async send(alert: Alert): Promise<void> {
    const r = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ severity: alert.severity, kind: alert.kind, key: alert.key, message: alert.message, detail: alert.detail, text: `[${alert.severity.toUpperCase()}] ${alert.message}\n${alert.detail}` }),
    });
    if (!r.ok) throw new Error(`webhook responded ${r.status}`);
  }
}
