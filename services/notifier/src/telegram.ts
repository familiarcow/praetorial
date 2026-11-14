// Telegram channel (TASK: launch checklist "Notifier: 2nd channel
// (Telegram) for bets >= $500"). Sends via the Bot API sendMessage
// endpoint using an INJECTED fetch (tests never hit the network, this
// repo makes no real Telegram calls either -- testnet-only, no spend).
// The bot token comes from TELEGRAM_BOT_TOKEN and is NEVER logged: on
// any failure (non-retryable status, retry exhaustion, network error)
// only a generic message + HTTP status is logged, never the token,
// never the chat_id, never the message text (both can carry/target
// personal data -- see contactStore.ts's PII-light rules).
export interface TelegramChannelOptions {
  fetchImpl: typeof fetch;
  botToken: string;
  maxAttempts?: number; // total attempts including the first, default 4
  sleepImpl?: (ms: number) => Promise<void>;
  log?: (msg: string) => void; // injectable so tests can assert on log content
}

const API_BASE = "https://api.telegram.org";

export class TelegramChannel {
  private readonly fetchImpl: typeof fetch;
  private readonly botToken: string;
  private readonly maxAttempts: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(opts: TelegramChannelOptions) {
    if (!opts.botToken) {
      throw new Error("TelegramChannel requires a bot token (TELEGRAM_BOT_TOKEN)");
    }
    this.fetchImpl = opts.fetchImpl;
    this.botToken = opts.botToken;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.sleepImpl = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? ((msg) => console.error(msg));
  }

  /** Sends `text` to `chatId` via Bot API sendMessage. Retries with
   * exponential backoff on HTTP 429/5xx, gives up after maxAttempts
   * and logs a PII-free failure line. Returns true iff the message
   * was accepted by Telegram. Never throws on a delivery failure --
   * notifications are a best-effort convenience, never on the
   * contract's critical path (same posture as notifier.ts). */
  async send(chatId: string, text: string): Promise<boolean> {
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response | undefined;
      let networkErr: unknown;
      try {
        // The token lives only in this URL string, constructed fresh
        // per call and never passed to `this.log`.
        res = await this.fetchImpl(`${API_BASE}/bot${this.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      } catch (err) {
        networkErr = err;
      }

      if (networkErr !== undefined) {
        if (attempt >= this.maxAttempts) {
          this.log(`telegram: giving up after ${attempt} attempt(s) (network error)`);
          return false;
        }
        await this.sleepImpl(backoffMs(attempt));
        continue;
      }

      if (res!.ok) return true;

      const retryable = res!.status === 429 || res!.status >= 500;
      if (retryable && attempt < this.maxAttempts) {
        await this.sleepImpl(backoffMs(attempt));
        continue;
      }

      this.log(
        retryable
          ? `telegram: giving up after ${attempt} attempt(s) (HTTP ${res!.status})`
          : `telegram: send failed (HTTP ${res!.status}, not retryable)`,
      );
      return false;
    }
  }
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}
