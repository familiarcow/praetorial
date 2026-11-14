// F2: mock fixtures for every funding task (F3 Account screen, F4 Add money, F5 Cash out / Convert) and the web unit tests.
// Shapes are lib/funding/types.ts. Numbers come from the recorded dry quotes in spikes/fund4/evidence and the live token list
// in spikes/fund3/evidence/oneclick/tokens.json (2026-11-11), so the mocks look like the real API.
//
// `createMockFundingWorker()` is a pure in-memory stand-in for the F1 Worker (SPEC §7.1 routes). Use it from node tests as a
// fetch (`mock.fetch`) and from Playwright with `page.route(FUNDING_ROUTE_GLOB, (r) => mock.route(r))`.
import type { Route } from "@playwright/test";
import type { OneClickStatus, QuoteView, StatusView, SwapRecord, TokenRef, FundingErrorCode, BalanceMap, StrayHolding } from "../../lib/funding/types";

// ---- accounts ----
/** A 64-hex implicit account id (the shape every Privy user has on mainnet). Not a real user. */
export const ACCOUNT = "a".repeat(64);
export const OTHER_ACCOUNT = "b".repeat(64);

// ---- 1Click /v0/tokens rows (raw API shape) ----
export interface RawToken { assetId: string; decimals: number; blockchain: string; symbol: string; price: number | null; priceUpdatedAt?: string; contractAddress?: string }
export const ID = {
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  USDT: "nep141:usdt.tether-token.near",
  NEAR: "nep141:wrap.near",
  BTC: "nep141:btc.omft.near",
  ETH: "nep141:eth.omft.near",
  ZEC: "nep141:zec.omft.near",
  TRON_USDT: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
  TRX: "nep141:tron.omft.near",
  BASE_USDC: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  SOL_USDC: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  ETH_USDC: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  ETH_USDT: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
  ARB_USDC: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  BASE_ETH: "nep141:base.omft.near",
  SOL: "nep141:sol.omft.near",
  XRP: "nep141:xrp.omft.near",
  /** A pseudo-asset the picker must hide. */
  PSEUDO: "1cs_v1:btc:native:coin",
  /** In nobody's token list: shows as "Unknown token". */
  UNKNOWN: "nep141:mystery.example.near",
} as const;

export const ONECLICK_TOKENS: RawToken[] = [
  { assetId: ID.NEAR, decimals: 24, blockchain: "near", symbol: "wNEAR", price: 3.65, contractAddress: "wrap.near" },
  { assetId: ID.USDC, decimals: 6, blockchain: "near", symbol: "USDC", price: 0.999527, contractAddress: ID.USDC.slice(7) },
  { assetId: ID.USDT, decimals: 6, blockchain: "near", symbol: "USDT", price: 0.9991, contractAddress: "usdt.tether-token.near" },
  { assetId: ID.ZEC, decimals: 8, blockchain: "zec", symbol: "ZEC", price: 1011.42 },
  { assetId: ID.ETH, decimals: 18, blockchain: "eth", symbol: "ETH", price: 2064.11 },
  { assetId: ID.BTC, decimals: 8, blockchain: "btc", symbol: "BTC", price: 73747 },
  { assetId: ID.TRON_USDT, decimals: 6, blockchain: "tron", symbol: "USDT", price: 0.9991, contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  { assetId: ID.TRX, decimals: 6, blockchain: "tron", symbol: "TRX", price: 0.317725 },
  { assetId: ID.BASE_USDC, decimals: 6, blockchain: "base", symbol: "USDC", price: 0.999527, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: ID.SOL_USDC, decimals: 6, blockchain: "sol", symbol: "USDC", price: 0.999527, contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { assetId: ID.ETH_USDC, decimals: 6, blockchain: "eth", symbol: "USDC", price: 0.999527, contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { assetId: ID.ETH_USDT, decimals: 6, blockchain: "eth", symbol: "USDT", price: 0.9991, contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
  { assetId: ID.ARB_USDC, decimals: 6, blockchain: "arb", symbol: "USDC", price: 0.999527, contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  { assetId: ID.BASE_ETH, decimals: 18, blockchain: "base", symbol: "ETH", price: 2064.11 },
  { assetId: ID.SOL, decimals: 9, blockchain: "sol", symbol: "SOL", price: 82.91 },
  { assetId: ID.XRP, decimals: 6, blockchain: "xrp", symbol: "XRP", price: 1.055 },
  { assetId: ID.PSEUDO, decimals: 8, blockchain: "btc", symbol: "BTC(OMNI)", price: 73747 },
];

export const ref = (assetId: string): TokenRef => {
  const t = ONECLICK_TOKENS.find((x) => x.assetId === assetId);
  if (!t) throw new Error(`fixture has no token ${assetId}`);
  return { assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals };
};

// ---- quotes (QuoteView) ----
export const DEPOSIT_ADDRESS = "TQx9cMHT8hNqMB4x1aP6YbkzjXtRUKk3Lm";
export const DEPOSIT_ADDRESS_2 = "TJb2r5Kv2aWQGkQ8Yb7y6W1n8ZzEoCwmVa";
export const XRP_DEPOSIT_ADDRESS = "rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y";
export const CORRELATION_ID = "077a240b-d050-4d09-aeeb-b9b9fa8d2a1a";

/** spikes/fund4/evidence/quote-fund-tron-usdt-refund-intents.json, as a real (non-dry) quote with an address. */
export function fundQuote(over: Partial<QuoteView> = {}): QuoteView {
  return {
    depositAddress: DEPOSIT_ADDRESS, depositMemo: null,
    amountIn: "20000000", minAmountIn: "19800000", amountOut: "19977493", minAmountOut: "19777718",
    amountInUsd: "19.982100000000", amountOutUsd: "19.968243420741", timeEstimateSec: 82,
    deadline: "2026-11-11T12:39:40.000Z", withdrawFee: "0", refundFee: "0", correlationId: CORRELATION_ID,
    ...over,
  };
}
export const fundQuoteDry = (over: Partial<QuoteView> = {}): QuoteView => fundQuote({ depositAddress: null, deadline: null, ...over });
/** spikes/fund4/evidence/quote-withdraw-usdc-to-tron-usdt.json. */
export function withdrawQuote(over: Partial<QuoteView> = {}): QuoteView {
  return {
    depositAddress: "9f2c1d0e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d", depositMemo: null,
    amountIn: "20000000", minAmountIn: "20000000", amountOut: "19807000", minAmountOut: "19608930",
    amountInUsd: "19.99", amountOutUsd: "19.79", timeEstimateSec: 65,
    deadline: "2026-11-11T12:09:40.000Z", withdrawFee: "207000", refundFee: "0", correlationId: "c0ffee00-0000-4000-8000-000000000001",
    ...over,
  };
}

// ---- statuses (StatusView), one per 1Click status ----
export function status(s: OneClickStatus, over: Partial<StatusView> = {}): StatusView {
  return {
    status: s, updatedAt: "2026-11-11T11:45:00.000Z", correlationId: CORRELATION_ID,
    depositedAmount: null, amountOut: null, refundedAmount: null, refundReason: null, originTxs: [], destinationTxs: [],
    ...over,
  };
}
export const STATUS = {
  waiting: status("PENDING_DEPOSIT"),
  confirming: status("KNOWN_DEPOSIT_TX", { originTxs: [{ hash: "abc123", explorerUrl: "https://tronscan.org/#/transaction/abc123" }] }),
  converting: status("PROCESSING", { depositedAmount: "20000000" }),
  short: status("INCOMPLETE_DEPOSIT", { depositedAmount: "15000000" }),
  credited: status("SUCCESS", { depositedAmount: "20000000", amountOut: "19977493" }),
  refunded: status("REFUNDED", { depositedAmount: "15000000", refundedAmount: "15000000", refundReason: "PARTIAL_DEPOSIT" }),
  failed: status("FAILED"),
} as const;

// ---- swap records ----
export const T0 = Date.parse("2026-11-11T11:39:40.000Z");
export function fundRecord(over: Partial<SwapRecord> = {}): SwapRecord {
  const q = fundQuote();
  return {
    id: q.depositAddress!, account: ACCOUNT, kind: "fund", origin: ref(ID.TRON_USDT), destination: ref(ID.USDC),
    amountIn: q.amountIn, minAmountIn: q.minAmountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut,
    depositAddress: q.depositAddress!, depositMemo: null, recipient: null, deadline: q.deadline, createdAt: T0, updatedAt: T0,
    state: "waiting", lastStatus: null, received: null, delivered: null, refunded: null, refundReason: null,
    correlationId: q.correlationId, signed: null, needReturn: null, checkFailures: 0,
    ...over,
  };
}
export function withdrawRecord(over: Partial<SwapRecord> = {}): SwapRecord {
  const q = withdrawQuote();
  return {
    id: q.depositAddress!, account: ACCOUNT, kind: "withdraw", origin: ref(ID.USDC), destination: ref(ID.TRON_USDT),
    amountIn: q.amountIn, minAmountIn: q.minAmountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut,
    depositAddress: q.depositAddress!, depositMemo: null, recipient: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9", deadline: q.deadline,
    createdAt: T0, updatedAt: T0, state: "waiting", lastStatus: null, received: null, delivered: null, refunded: null,
    refundReason: null, correlationId: q.correlationId, signed: false, needReturn: null, checkFailures: 0, createdHere: true, // as cashOutRecord writes it
    ...over,
  };
}

// ---- intents.near reads ----
/** Balances (base units) for mt_batch_balance_of, keyed by token id. */
export const BALANCES: Record<string, string> = {
  [ID.USDC]: "42100000", [ID.USDT]: "50000000", [ID.NEAR]: "5000000000000000000000000", [ID.BTC]: "98500", [ID.ETH]: "0", [ID.ZEC]: "0",
  [ID.ETH_USDC]: "1000000", [ID.UNKNOWN]: "7", [ID.TRON_USDT]: "0",
};
/** mt_tokens_for_owner rows (ids only, like the live sample in spikes/fund4/evidence). */
export const TOKENS_FOR_OWNER = [ID.USDC, ID.USDT, ID.NEAR, ID.BTC, ID.ETH_USDC, ID.UNKNOWN, ID.TRON_USDT].map((token_id) => ({ token_id }));

/** A NEAR view-call stub over BALANCES / TOKENS_FOR_OWNER (the `View` type the balance readers take). */
export function mockIntentsView(opts: { balances?: Record<string, string>; owned?: { token_id: string }[]; fail?: (method: string) => boolean } = {}) {
  const balances = opts.balances ?? BALANCES;
  const owned = opts.owned ?? TOKENS_FOR_OWNER;
  const calls: { contract: string; method: string; args: any }[] = [];
  const view = async (contract: string, method: string, args: any): Promise<any> => {
    calls.push({ contract, method, args });
    if (opts.fail?.(method)) throw new Error(`rpc ${method} down`);
    if (method === "mt_batch_balance_of") return (args.token_ids as string[]).map((id) => balances[id] ?? "0");
    if (method === "mt_balance_of") return balances[args.token_id] ?? "0";
    if (method === "mt_tokens_for_owner") {
      const from = Number(args.from_index ?? 0), limit = Number(args.limit ?? 100);
      return owned.slice(from, from + limit);
    }
    throw new Error(`unmocked ${method}`);
  };
  return { view, calls };
}

export const STRAY_ETH_USDC: StrayHolding = { assetId: ID.ETH_USDC, units: 1000000n, token: ref(ID.ETH_USDC), priceUsd: 0.999527, dust: false };
export const STRAY_UNKNOWN: StrayHolding = { assetId: ID.UNKNOWN, units: 7n, token: null, priceUsd: null, dust: false };
export function balanceMap(over: Partial<BalanceMap> = {}): BalanceMap {
  return {
    betting: { USDC: 42100000n, USDT: 50000000n, NEAR: 5000000000000000000000000n, BTC: 98500n, ETH: 0n, ZEC: 0n },
    stray: [STRAY_ETH_USDC], nearAccount: { NEAR: 5100000000000000000000000n }, inBets: { BTC: { units: 20000n, bets: 1 } },
    payouts: [], inFlight: [],
    ...over,
  };
}

// ---- the mock F1 Worker ----
export const FUNDING_URL = "http://localhost:8791";
export const FUNDING_ROUTE_GLOB = `${FUNDING_URL}/**`;

export interface MockReply { status: number; body: unknown; headers?: Record<string, string> }
export interface MockWorkerOpts {
  /** Status sequence per deposit address; the last one repeats. Default: waiting -> confirming -> converting -> credited. */
  statuses?: Record<string, StatusView[]>;
  /** Force an error code on a route ("POST /fund/quote" etc). */
  errors?: Record<string, { code: FundingErrorCode; minUnits?: string; status?: number }>;
  /** Override the quote returned by /fund/quote. */
  quote?: (body: any) => QuoteView;
  /** Records the server already holds (GET /fund/list). */
  records?: SwapRecord[];
  down?: boolean;
}

/** In-memory stand-in for the F1 Worker. `calls` records every request for assertions. */
export function createMockFundingWorker(opts: MockWorkerOpts = {}) {
  const calls: { method: string; path: string; query: Record<string, string>; body: any }[] = [];
  const records: SwapRecord[] = [...(opts.records ?? [])];
  const seq: Record<string, number> = {};
  const defaultStatuses = [STATUS.waiting, STATUS.confirming, STATUS.converting, STATUS.credited];
  const err = (code: FundingErrorCode, status: number, minUnits?: string): MockReply => ({
    status, body: { error: code, message: `mock ${code}`, ...(minUnits ? { minUnits } : {}) }, headers: code === "rate_limited" ? { "Retry-After": "30" } : undefined,
  });
  let addrN = 0;

  function handle(method: string, url: string, body: any): MockReply {
    const u = new URL(url);
    const query = Object.fromEntries(u.searchParams.entries());
    calls.push({ method, path: u.pathname, query, body });
    if (opts.down) return err("upstream_down", 503);
    const key = `${method} ${u.pathname}`;
    const forced = opts.errors?.[key];
    if (forced) return err(forced.code, forced.status ?? (forced.code === "rate_limited" ? 429 : forced.code === "upstream_down" ? 503 : 400), forced.minUnits);
    switch (key) {
      case "GET /health": return { status: 200, body: { ok: true, network: "mainnet", keyConfigured: true } };
      case "POST /fund/quote": {
        if (body.dry) return { status: 200, body: opts.quote ? { ...opts.quote(body), depositAddress: null, deadline: null } : fundQuoteDry() };
        const q = opts.quote ? opts.quote(body) : fundQuote({ depositAddress: addrN++ === 0 ? DEPOSIT_ADDRESS : `${DEPOSIT_ADDRESS_2}${addrN}` });
        records.push(fundRecord({ id: q.depositAddress!, depositAddress: q.depositAddress!, account: body.account }));
        return { status: 200, body: q };
      }
      case "POST /withdraw/quote": {
        const q = withdrawQuote(body.dry ? { depositAddress: null, deadline: null } : {});
        if (!body.dry) records.push(withdrawRecord({ account: body.account, kind: body.kind }));
        return { status: 200, body: q };
      }
      case "POST /withdraw/intent": return { status: 200, body: { intent: { mock: true }, hash: "00".repeat(32) } };
      case "POST /withdraw/submit": return { status: 200, body: { intentHash: "mockIntentHash" } };
      case "POST /fund/submit-tx": return { status: 200, body: { ok: true } };
      case "GET /fund/status": {
        const addr = query.depositAddress;
        if (!records.some((r) => r.depositAddress === addr) && !opts.statuses?.[addr]) return err("not_found", 404);
        const list = opts.statuses?.[addr] ?? defaultStatuses;
        const i = Math.min(seq[addr] ?? 0, list.length - 1);
        seq[addr] = i + 1;
        return { status: 200, body: list[i] };
      }
      case "GET /fund/list": return { status: 200, body: records.filter((r) => r.account === query.account).map(({ needReturn, ...r }) => r) };
      default: return err("not_found", 404);
    }
  }

  /** A fetch with the browser signature (node tests inject it into the funding client). */
  const fetchImpl = async (input: string | URL, init: { method?: string; body?: string } = {}) => {
    const r = handle(init.method ?? "GET", String(input), init.body ? JSON.parse(init.body) : undefined);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  };

  /** Playwright: `await page.route(FUNDING_ROUTE_GLOB, (route) => mock.route(route))`. */
  const route = async (rt: { request(): { method(): string; url(): string; postData(): string | null }; fulfill(o: { status: number; contentType: string; body: string; headers?: Record<string, string> }): Promise<void> }) => {
    const req = rt.request();
    if (req.method() === "OPTIONS") return rt.fulfill({ status: 204, contentType: "text/plain", body: "", headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
    const pd = req.postData();
    const r = handle(req.method(), req.url(), pd ? JSON.parse(pd) : undefined);
    return rt.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body), headers: { "access-control-allow-origin": "*", ...(r.headers ?? {}) } });
  };

  const pwRoute: (r: Route) => Promise<void> = route; // compile-time check: usable as a Playwright route handler
  return { handle, fetch: fetchImpl, route: pwRoute, calls, records };
}
