// Shared NEAR RPC endpoint selection + client-side pacing (D-RPC1 /
// queue item 7b). ONE place that knows the default RPC URLs and the
// retry/backoff/failover policy -- every service, chaos script,
// e2e/g4 script and the privy-e2e/privy-web-e2e harnesses route
// through this module (or, for plain .mjs scripts that can't import
// TS, through chaos/rpcEnv.mjs, which mirrors just the env-var
// defaulting rule below) instead of hardcoding a URL of their own.
//
// Single provider for now: testnet https://test.rpc.fastnear.com,
// mainnet https://free.rpc.fastnear.com. NEAR_RPC_URL overrides the
// default outright; NEAR_RPC_FALLBACKS (comma list, empty by default)
// lets backup endpoints be added later with zero code change -- a
// fallback is only tried after retries are exhausted on the one
// before it in the list.

export const DEFAULT_TESTNET_RPC_URL = "https://test.rpc.fastnear.com";
export const DEFAULT_MAINNET_RPC_URL = "https://free.rpc.fastnear.com";

/** Client-side pacing ceilings (D-RPC1): a single shared public RPC
 * endpoint, so every caller through this module honors the same
 * budget regardless of which service process it runs in. */
export const RATE_LIMIT_PER_SEC = 3;
export const MAX_IN_FLIGHT = 4;
export const TX_POLL_INTERVAL_MS = 1500;
export const DEFAULT_MAX_RETRIES = 5;

export function defaultRpcUrlForNetwork(networkId: string): string {
  return networkId === "mainnet" ? DEFAULT_MAINNET_RPC_URL : DEFAULT_TESTNET_RPC_URL;
}

export interface RpcUrls {
  primary: string;
  fallbacks: string[];
  all: string[];
}

/** NEAR_RPC_URL overrides the default for `networkId`; NEAR_RPC_FALLBACKS
 * is a comma-separated list of additional endpoints tried in order
 * after the primary's retries are exhausted. Both read fresh from
 * process.env on every call (tests mutate env between cases). */
export function resolveRpcUrls(networkId: string): RpcUrls {
  const primary = (process.env.NEAR_RPC_URL ?? "").trim() || defaultRpcUrlForNetwork(networkId);
  const fallbacks = (process.env.NEAR_RPC_FALLBACKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { primary, fallbacks, all: [primary, ...fallbacks] };
}

// ---------------------------------------------------------------------
// 429 counter: process-wide so a full run (any number of PacedRpcClient
// instances / services sharing this module) can report sustained
// throttling at exit.
// ---------------------------------------------------------------------
let throttleCount = 0;
export function get429Count(): number {
  return throttleCount;
}
export function reset429Count(): void {
  throttleCount = 0;
}
function record429(): void {
  throttleCount++;
}

// Total-attempt counter (paired with throttleCount above) so a caller
// can compute an actual error RATE, not just a raw 429 count -- used by
// monitor/src/alerts.ts's sustained-RPC-error-rate check. One increment
// per HTTP attempt made (every retry counts), process-wide like
// throttleCount, so both counters stay on the same denominator.
let attemptCount = 0;
export function getAttemptCount(): number {
  return attemptCount;
}
function recordAttempt(): void {
  attemptCount++;
}

// ---------------------------------------------------------------------
// Rate limiter: at most RATE_LIMIT_PER_SEC request STARTS per rolling
// 1000ms window, and at most MAX_IN_FLIGHT concurrently outstanding.
// Event-driven (no polling loop): callers queue, and are released
// either when an in-flight slot frees up (release()) or when the
// oldest window entry ages out (a setTimeout scheduled for exactly
// that moment).
// ---------------------------------------------------------------------
export class RateLimiter {
  private inFlight = 0;
  private windowStarts: number[] = [];
  private queue: Array<() => void> = [];
  private pumpScheduled = false;

  constructor(
    private readonly perSec: number = RATE_LIMIT_PER_SEC,
    private readonly maxInFlight: number = MAX_IN_FLIGHT,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push(() => resolve(this.makeRelease()));
      this.pump();
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      this.pump();
    };
  }

  private pump(): void {
    const nowMs = this.now();
    this.windowStarts = this.windowStarts.filter((t) => nowMs - t < 1000);
    while (
      this.queue.length > 0 &&
      this.inFlight < this.maxInFlight &&
      this.windowStarts.length < this.perSec
    ) {
      const next = this.queue.shift()!;
      this.inFlight++;
      this.windowStarts.push(nowMs);
      next();
    }
    if (this.queue.length > 0 && !this.pumpScheduled) {
      this.pumpScheduled = true;
      const earliest = this.windowStarts[0];
      const delay = earliest !== undefined ? Math.max(1000 - (nowMs - earliest), 1) : 50;
      setTimeout(() => {
        this.pumpScheduled = false;
        this.pump();
      }, delay);
    }
  }
}

// ---------------------------------------------------------------------
// Paced, retrying, failing-over JSON-RPC client.
// ---------------------------------------------------------------------
export interface PacedRpcClientOptions {
  urls: string[];
  limiter?: RateLimiter;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  onThrottle?: () => void;
}

export class RpcExhaustedError extends Error {}

let nextRequestId = 1;

export class PacedRpcClient {
  private readonly urls: string[];
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly onThrottle: () => void;

  constructor(opts: PacedRpcClientOptions) {
    if (!opts.urls.length) throw new Error("PacedRpcClient requires at least one RPC URL");
    this.urls = opts.urls;
    this.limiter = opts.limiter ?? new RateLimiter();
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onThrottle = opts.onThrottle ?? record429;
  }

  /** Sends one JSON-RPC request, retrying with exponential backoff +
   * jitter on 429/5xx/network error (honoring Retry-After when the
   * server sends one), and failing over to the next configured URL
   * only after this URL's own retries are exhausted. Throws
   * RpcExhaustedError with a clear message if every URL is exhausted. */
  async sendJsonRpc(method: string, params: unknown): Promise<any> {
    const attemptsPerUrl: string[] = [];
    for (const url of this.urls) {
      try {
        return await this.sendToUrl(url, method, params);
      } catch (err: any) {
        attemptsPerUrl.push(`${url}: ${err?.message ?? err}`);
      }
    }
    throw new RpcExhaustedError(
      `all configured RPC endpoints exhausted for ${method}:\n  ${attemptsPerUrl.join("\n  ")}`,
    );
  }

  private async sendToUrl(url: string, method: string, params: unknown): Promise<any> {
    let attempt = 0;
    for (;;) {
      const release = await this.limiter.acquire();
      recordAttempt();
      let res: Response | undefined;
      let networkErr: unknown;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: nextRequestId++, method, params }),
        });
      } catch (err) {
        networkErr = err;
      } finally {
        release();
      }

      if (networkErr !== undefined) {
        attempt++;
        if (attempt > this.maxRetries) {
          throw new RpcExhaustedError(
            `${url} ${method}: giving up after ${this.maxRetries} retries (network error: ${(networkErr as Error)?.message ?? networkErr})`,
          );
        }
        await this.sleepImpl(backoffMs(attempt));
        continue;
      }

      if (res!.status === 429) {
        this.onThrottle();
        attempt++;
        if (attempt > this.maxRetries) {
          throw new RpcExhaustedError(`${url} ${method}: giving up after ${this.maxRetries} retries (HTTP 429)`);
        }
        const retryAfterMs = parseRetryAfterMs(res!.headers.get("retry-after"));
        await this.sleepImpl(retryAfterMs ?? backoffMs(attempt));
        continue;
      }

      if (res!.status >= 500) {
        attempt++;
        if (attempt > this.maxRetries) {
          throw new RpcExhaustedError(`${url} ${method}: giving up after ${this.maxRetries} retries (HTTP ${res!.status})`);
        }
        await this.sleepImpl(backoffMs(attempt));
        continue;
      }

      return res!.json();
    }
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 15000);
  const jitter = Math.floor(Math.random() * 300);
  return base + jitter;
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/** Builds the shared PacedRpcClient for a given network, reading
 * NEAR_RPC_URL / NEAR_RPC_FALLBACKS at call time. */
export function buildPacedRpcClient(networkId: string, overrides: Partial<PacedRpcClientOptions> = {}): PacedRpcClient {
  const { all } = resolveRpcUrls(networkId);
  return new PacedRpcClient({ urls: all, ...overrides });
}

/** Polls `checkFn` every TX_POLL_INTERVAL_MS until it returns a
 * non-null/non-undefined result or `timeoutMs` elapses. Shared by any
 * caller that needs to wait on tx status (keeper, e2e/g4, etc.)
 * instead of each picking its own interval. */
export async function pollTxStatus<T>(
  checkFn: () => Promise<T | null | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number; sleepImpl?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const intervalMs = opts.intervalMs ?? TX_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await checkFn();
    if (result !== null && result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`pollTxStatus: timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}
