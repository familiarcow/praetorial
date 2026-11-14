// F1: the 1Click HTTP client (base https://1click.chaindefuser.com). Every request carries
//   User-Agent: praetorial-funding/<GIT_SHA>   (1Click's Cloudflare WAF answers 403 "error code: 1010" to requests without one)
//   Accept: application/json
//   X-API-Key: <ONECLICK_API_KEY>              (only when configured; the key is never logged, returned or put in an error)
// 1Click 4xx/5xx bodies are mapped to the stable codes the web turns into copy (SPEC §7.1 Errors).
import type {
  OneClickGenerateIntentResponse, OneClickQuoteRequest, OneClickQuoteResponse, OneClickStatusResponse, OneClickSubmitIntentResponse,
  OneClickToken, SignedNep413,
} from "../../../common/src/funding/oneclickTypes.js";

export type ErrorCode =
  | "too_low" | "no_route" | "bad_recipient" | "bad_refund" | "deadline" | "not_found" | "upstream_down" | "upstream_auth"
  | "upstream_rejected";

export class OneClickError extends Error {
  constructor(readonly code: ErrorCode, readonly httpStatus: number, readonly upstreamMessage: string, readonly minUnits?: string) {
    super(`1click ${code} (${httpStatus})`);
    this.name = "OneClickError";
  }
}

/** Maps a 1Click HTTP status + `message` to a code (texts from FUND3/FUND4/F1 evidence). */
export function mapOneClickError(status: number, message: string): OneClickError {
  const m = String(message ?? "");
  if (status === 401 || status === 403) return new OneClickError("upstream_auth", status, m);
  if (status === 404) return new OneClickError("not_found", status, m);
  if (status === 429 || status >= 500) return new OneClickError("upstream_down", status, m);
  const low = /try at least (\d+)/i.exec(m);
  if (low) return new OneClickError("too_low", status, m, low[1]);
  if (/recipient is not valid/i.test(m)) return new OneClickError("bad_recipient", status, m);
  if (/refundTo is not valid/i.test(m)) return new OneClickError("bad_refund", status, m);
  if (/deadline/i.test(m)) return new OneClickError("deadline", status, m);
  if (/not available|internal server error|no route|not supported|no liquidity|incorrect depositmode/i.test(m)) return new OneClickError("no_route", status, m);
  return new OneClickError("upstream_rejected", status, m);
}

/** 1Click's own API origin. D-PM3: only a quote fetched from exactly here (https) may use the BTC unsigned-quote exception. */
export const ONECLICK_OFFICIAL_BASE_URL = "https://1click.chaindefuser.com";

export interface OneClickApi {
  /** the origin quotes are fetched from (normalised, no trailing slash) */
  readonly baseUrl?: string;
  tokens(): Promise<OneClickToken[]>;
  quote(body: OneClickQuoteRequest): Promise<OneClickQuoteResponse>;
  status(depositAddress: string, depositMemo?: string): Promise<OneClickStatusResponse>;
  submitDeposit(body: { txHash: string; depositAddress: string; memo?: string }): Promise<unknown>;
  generateIntent(body: { type: "swap_transfer"; standard: "nep413"; signerId: string; depositAddress: string }): Promise<OneClickGenerateIntentResponse>;
  submitIntent(body: { type: "swap_transfer"; signedData: SignedNep413 }): Promise<OneClickSubmitIntentResponse>;
}

export interface OneClickOptions {
  baseUrl: string;
  apiKey?: string;
  gitSha?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export const userAgent = (gitSha: string | undefined) => `praetorial-funding/${gitSha && /^[\w.-]{1,64}$/.test(gitSha) ? gitSha : "unknown"}`;

export function oneClickClient(o: OneClickOptions): OneClickApi {
  const base = o.baseUrl.replace(/\/+$/, "");
  const f = o.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  const headers = (post: boolean): Record<string, string> => {
    const h: Record<string, string> = { accept: "application/json", "user-agent": userAgent(o.gitSha) };
    if (post) h["content-type"] = "application/json";
    if (o.apiKey) h["x-api-key"] = o.apiKey;
    return h;
  };
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await f(`${base}${path}`, { method, headers: headers(method === "POST"), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
    } catch (e: any) {
      throw new OneClickError("upstream_down", 0, e?.name === "TimeoutError" ? "timeout" : "network error");
    }
    const text = await r.text();
    let json: any = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON (e.g. the WAF's "error code: 1010") */ }
    if (!r.ok) throw mapOneClickError(r.status, typeof json?.message === "string" ? json.message : text.slice(0, 200));
    if (json === undefined) throw new OneClickError("upstream_down", r.status, "non-JSON body");
    return json as T;
  }
  return {
    baseUrl: base,
    tokens: () => call("GET", "/v0/tokens"),
    quote: (b) => call("POST", "/v0/quote", b),
    status: (a, memo) => call("GET", `/v0/status?depositAddress=${encodeURIComponent(a)}${memo ? `&depositMemo=${encodeURIComponent(memo)}` : ""}`),
    submitDeposit: (b) => call("POST", "/v0/deposit/submit", b),
    generateIntent: (b) => call("POST", "/v0/generate-intent", b),
    submitIntent: (b) => call("POST", "/v0/submit-intent", b),
  };
}
