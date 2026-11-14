// F2: HTTP client for the F1 funding Worker (SPEC §7.1), base URL NETWORK.fundingUrl. Every failure becomes a typed FundingError
// (code -> copy in the UI), and every response is shape-checked before use: a half-shaped body is "upstream_down", never a
// quote with missing amounts. The client never sends a recipient or refund address for Add money / Convert; the Worker builds
// them from `account` (refunds land in the user's own intents account, familiarcow UX-37).
// 1Click is mainnet-only, so bet-token ids are checked against the MAINNET ids whatever network the build runs on.
import type {
  FundQuoteRequest, WithdrawQuoteRequest, QuoteView, StatusView, SwapRecord, IntentToSign, FundingHealth, FundingErrorCode, OneClickStatus, TxLink,
} from "./types";
import { isBetTokenId } from "./landing";
import { advance } from "./tracker";
import { NETWORK } from "../network";

export class FundingError extends Error {
  constructor(public code: FundingErrorCode, message: string, public minUnits?: string, public retryAfterSec?: number) {
    super(message);
    this.name = "FundingError";
  }
}

const KNOWN_CODES: FundingErrorCode[] = ["too_low", "no_route", "bad_recipient", "bad_refund", "deadline", "upstream_down", "rate_limited", "not_found", "bad_request", "not_configured", "network"];
const STATUSES: OneClickStatus[] = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"];
const UNITS = /^\d+$/;

const bad = (what: string): FundingError => new FundingError("upstream_down", `unexpected ${what} from the funding service`);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const units = (v: unknown, what: string): string => { if (typeof v !== "string" || !UNITS.test(v)) throw bad(what); return v; };
const unitsOrNull = (v: unknown): string | null => (typeof v === "string" && UNITS.test(v) ? v : null);

export function parseQuoteView(b: any): QuoteView {
  if (!b || typeof b !== "object") throw bad("quote");
  const est = Number(b.timeEstimateSec ?? b.timeEstimate);
  return {
    depositAddress: str(b.depositAddress), depositMemo: str(b.depositMemo),
    amountIn: units(b.amountIn, "quote"), minAmountIn: units(b.minAmountIn, "quote"),
    amountOut: units(b.amountOut, "quote"), minAmountOut: units(b.minAmountOut, "quote"),
    amountInUsd: str(b.amountInUsd), amountOutUsd: str(b.amountOutUsd),
    timeEstimateSec: Number.isFinite(est) && est >= 0 ? est : 0,
    deadline: str(b.deadline), withdrawFee: unitsOrNull(b.withdrawFee) ?? "0", refundFee: unitsOrNull(b.refundFee) ?? "0",
    correlationId: str(b.correlationId) ?? "",
  };
}

const txLinks = (v: unknown): TxLink[] =>
  Array.isArray(v) ? v.flatMap((t: any) => (t && typeof t.hash === "string" ? [{ hash: t.hash, explorerUrl: str(t.explorerUrl) }] : [])) : [];

export function parseStatusView(b: any): StatusView {
  if (!b || !STATUSES.includes(b.status)) throw bad("status");
  return {
    status: b.status, updatedAt: str(b.updatedAt), correlationId: str(b.correlationId),
    depositedAmount: unitsOrNull(b.depositedAmount), amountOut: unitsOrNull(b.amountOut), refundedAmount: unitsOrNull(b.refundedAmount),
    refundReason: str(b.refundReason), originTxs: txLinks(b.originTxs), destinationTxs: txLinks(b.destinationTxs),
  };
}

/** SM2 gap F4-2 (F4): the Worker's own `state` is ignored. The state is mapped from its raw 1Click `lastStatus` by
 * tracker.advance alone (the one mapping; a record never checked yet reads as PENDING_DEPOSIT, so it expires on the same rule). */
function parseRecord(r: any, now: number): SwapRecord | null {
  if (!r || typeof r.depositAddress !== "string" || typeof r.account !== "string" || !["fund", "withdraw", "convert"].includes(r.kind)) return null;
  const rec = { ...r, depositMemo: r.depositMemo ?? null, needReturn: null, createdHere: false, checkFailures: Number(r.checkFailures) || 0 } as SwapRecord;
  const lastStatus: OneClickStatus | null = STATUSES.includes(r.lastStatus) ? r.lastStatus : null;
  const seen: StatusView = { status: lastStatus ?? "PENDING_DEPOSIT", updatedAt: null, correlationId: null, depositedAmount: null, amountOut: null, refundedAmount: null, refundReason: rec.refundReason ?? null, originTxs: [], destinationTxs: [] };
  return { ...rec, lastStatus, state: advance({ ...rec, state: "waiting" }, seen, now).state };
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface FundingClient {
  health(): Promise<FundingHealth>;
  fundQuote(req: FundQuoteRequest, signal?: AbortSignal): Promise<QuoteView>;
  submitTx(depositAddress: string, txHash: string, memo: string | null): Promise<void>;
  status(depositAddress: string, memo: string | null): Promise<StatusView>;
  list(account: string): Promise<SwapRecord[]>;
  withdrawQuote(req: WithdrawQuoteRequest, signal?: AbortSignal): Promise<QuoteView>;
  withdrawIntent(account: string, depositAddress: string): Promise<IntentToSign>;
  withdrawSubmit(depositAddress: string, signedData: unknown): Promise<{ intentHash: string }>;
}

export function createFundingClient(o: { baseUrl?: string; fetch?: FetchLike; now?: () => number } = {}): FundingClient {
  const now = o.now ?? Date.now;
  const base = (o.baseUrl ?? NETWORK.fundingUrl).replace(/\/+$/, "");
  const doFetch: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));

  async function call(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    if (!base) throw new FundingError("not_configured", `funding service not configured (${NETWORK.networkId})`);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method, signal,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      throw new FundingError("network", `funding service unreachable: ${(e as Error)?.message ?? e}`);
    }
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON: handled below */ }
    if (res.ok && json !== null) return json;
    const retry = Number(res.headers.get("retry-after"));
    const retryAfterSec = Number.isFinite(retry) && retry > 0 ? retry : undefined;
    const raw = json && typeof json.error === "string" ? json.error : null;
    let code: FundingErrorCode;
    if (res.status === 429) code = "rate_limited";
    else if (raw && (KNOWN_CODES as string[]).includes(raw)) code = raw as FundingErrorCode;
    else if (res.status >= 500 || json === null) code = "upstream_down";
    else if (res.status === 404) code = "not_found";
    else code = "bad_request";
    throw new FundingError(code, (json && typeof json.message === "string" && json.message) || `funding service HTTP ${res.status}`, unitsOrNull(json?.minUnits) ?? undefined, retryAfterSec);
  }

  const q = (params: Record<string, string | null>) =>
    Object.entries(params).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  const reject = (msg: string) => Promise.reject(new FundingError("bad_request", msg));

  return {
    async health() {
      const b = await call("GET", "/health");
      return { ok: b.ok === true, network: String(b.network ?? ""), keyConfigured: b.keyConfigured === true };
    },
    async fundQuote(req, signal) {
      // familiarcow UX-37: the landing token is ALWAYS one of the 6. Refuse before any request.
      if (!isBetTokenId(req.betWith, "mainnet")) return reject("betWith must be one of the 6 bet tokens");
      if ((req.amountIn === undefined) === (req.needOut === undefined)) return reject("exactly one of amountIn / needOut");
      const amt = req.amountIn ?? req.needOut!;
      if (!UNITS.test(amt) || BigInt(amt) <= 0n) return reject("amount must be positive base units");
      const body: Record<string, unknown> = { account: req.account, originAsset: req.originAsset, betWith: req.betWith, dry: req.dry };
      if (req.amountIn !== undefined) body.amountIn = req.amountIn; else body.needOut = req.needOut;
      return parseQuoteView(await call("POST", "/fund/quote", body, signal));
    },
    async submitTx(depositAddress, txHash, memo) {
      await call("POST", "/fund/submit-tx", memo ? { depositAddress, txHash, memo } : { depositAddress, txHash });
    },
    async status(depositAddress, memo) {
      return parseStatusView(await call("GET", `/fund/status?${q({ depositAddress, memo })}`));
    },
    async list(account) {
      const b = await call("GET", `/fund/list?${q({ account })}`);
      if (!Array.isArray(b)) throw bad("list");
      return b.map((r) => parseRecord(r, now())).filter((r): r is SwapRecord => r !== null);
    },
    async withdrawQuote(req, signal) {
      if (req.kind === "convert") {
        if (!isBetTokenId(req.destinationAsset, "mainnet")) return reject("convert lands only in the 6 bet tokens");
        if (req.recipient !== undefined) return reject("convert has no recipient (it is always the user's own balance)");
      } else if (!req.recipient) return reject("cash out needs the user's address");
      if (!UNITS.test(req.amountIn) || BigInt(req.amountIn) <= 0n) return reject("amount must be positive base units");
      const body: Record<string, unknown> = { account: req.account, kind: req.kind, originAsset: req.originAsset, amountIn: req.amountIn, destinationAsset: req.destinationAsset, dry: req.dry };
      if (req.kind === "withdraw") body.recipient = req.recipient;
      return parseQuoteView(await call("POST", "/withdraw/quote", body, signal));
    },
    async withdrawIntent(account, depositAddress) {
      const b = await call("POST", "/withdraw/intent", { account, depositAddress });
      if (!b || b.intent === undefined || typeof b.hash !== "string") throw bad("intent");
      return { intent: b.intent, hash: b.hash };
    },
    async withdrawSubmit(depositAddress, signedData) {
      const b = await call("POST", "/withdraw/submit", { depositAddress, signedData });
      if (!b || typeof b.intentHash !== "string") throw bad("submit");
      return { intentHash: b.intentHash };
    },
  };
}
