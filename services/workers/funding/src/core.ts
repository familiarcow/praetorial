// F1 (FUND4 SPEC §7.1, D-FUND4/D-FUND4a): the funding Worker's HTTP core. Pure: 1Click, the record store / limiter, NEAR RPC,
// logging and the clock are injected. The Worker builds EVERY recipient/refund field itself from `account` and never takes
// them from the client:
//   Add money  (/fund/quote):     origin = any 1Click token, destination = one of the 6 bet tokens, recipient = refundTo = the
//                                 caller's intents account (INTENTS / INTENTS), one-time deposit address, appFees never sent (no fee).
//   Convert    (/withdraw/quote kind=convert): intents -> intents, destination one of the 6, recipient = refundTo = account.
//   Cash out   (/withdraw/quote kind=withdraw): intents -> any chain, recipient checked by the shared chainAddress rules,
//                                 refundTo = account (INTENTS).
//   Signing    (/withdraw/intent, /withdraw/submit): 1Click generate-intent -> exact payload check -> user signs NEP-413 ->
//                                 byte-equal payload + local signature check -> 1Click submit-intent. No relayer, no NEAR keys here.
// Non-dry quotes must carry a valid 1Click signature and echo exactly what we asked for, or nothing is stored (502).
// ONE exception (D-PM3, spikes/f1/NOTES.md finding 1): 1Click's signature fails for every BTC origin-chain quote, so those are
// accepted unsigned when the echo matches our request field by field (btcEchoMismatch) and the response came straight from
// https://1click.chaindefuser.com; logged as `quote_sig_btc_unverified` and stored with quoteSignature "btc_unverified".
import nacl from "tweetnacl";
import bs58 from "bs58";
import { ONE_CLICK_MANAGER_PUB_KEY, verifyQuoteSignature, stableStringify } from "../../../common/src/funding/quoteSignature.js";
import { checkSwapTransferIntent, hashNep413Payload } from "../../../common/src/funding/intentCheck.js";
import { isImplicitAccount, isNearAccountId, validateRecipient } from "../../../common/src/funding/chainAddress.js";
import type { OneClickQuoteRequest, OneClickQuoteResponse, OneClickToken, OneClickStatus, SignedNep413 } from "../../../common/src/funding/oneclickTypes.js";
import { ONECLICK_OFFICIAL_BASE_URL, OneClickError, type OneClickApi } from "./oneclick.js";
import { EXPIRE_GRACE_MS, isTerminal, type FundingState, type LimitRule, type SwapKind, type SwapRecord } from "./store.js";

export const LIMITS = {
  dryPerMinPerIp: 60,
  realPerHourPerIp: 10,
  realPerHourPerAccount: 10,
  maxOpenPerAccount: 5,
  statusPerMinPerIp: 120,
  intentPerHourPerAccount: 10,
  submitTxPerHourPerIp: 30,
} as const;
const MIN = 60_000, HOUR = 3_600_000;
export const TOKENS_TTL_MS = 5 * MIN;
/** Chains whose deposits confirm slowly: the address lives 3 h instead of 1 h (SPEC §7.1). */
export const SLOW_CHAINS = ["btc", "zec", "doge", "ltc", "bch", "dash"];
/** Origin chains whose 1Click deposit addresses need a memo (depositMode MEMO). XRP and TON reject MEMO today. */
export const MEMO_DEPOSIT_CHAINS = ["stellar"];
const STABLE = /^(usdc|usdt|usdt0|dai)(\.e)?$/i;

export interface FundingConfig {
  network: "mainnet" | "testnet";
  allowedOrigins: string[];
  /** the 6 bet tokens (intents ids), from BETTING_ASSET_IDS */
  bettingAssetIds: string[];
  referral: string;
  /** testnet: 1Click only exists on mainnet, so the testnet Worker never makes a real (dry:false) quote */
  dryOnly: boolean;
}
export type StoreApi = Pick<FundingState, "consume" | "get" | "insertCapped" | "patch" | "listAccount">;
export interface ChainApi { intentsBalance(account: string, tokenId: string): Promise<bigint> }
export interface FundingDeps {
  config: FundingConfig;
  oneclick: OneClickApi;
  store: StoreApi;
  chain: ChainApi;
  tokens: TokenCache;
  log(event: Record<string, unknown>): void;
  nowMs(): number;
  /** 1Click's quote-signing key; tests inject their own. Default ONE_CLICK_MANAGER_PUB_KEY. */
  quoteSigningKey?: string;
}

/** Per-isolate /v0/tokens cache (5 min). A failed refresh keeps serving the last good list. */
export class TokenCache {
  private at = -Infinity; private list: OneClickToken[] | null = null; private inflight: Promise<OneClickToken[]> | null = null;
  constructor(private readonly ttlMs = TOKENS_TTL_MS) {}
  async get(fetchList: () => Promise<OneClickToken[]>, nowMs: number): Promise<OneClickToken[]> {
    if (this.list && nowMs - this.at < this.ttlMs) return this.list;
    this.inflight ??= (async () => {
      try {
        const l = await fetchList();
        if (!Array.isArray(l) || l.length === 0) throw new OneClickError("upstream_down", 200, "empty token list");
        this.list = l.filter((t) => t && typeof t.assetId === "string" && typeof t.blockchain === "string" && Number.isInteger(t.decimals));
        this.at = nowMs;
        return this.list;
      } catch (e) {
        if (this.list) return this.list;
        throw e;
      } finally { this.inflight = null; }
    })();
    return this.inflight;
  }
}

export function parseAllowedOrigins(s: string | undefined): string[] {
  return (s ?? "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter((x) => x && x !== "*" && /^https?:\/\//.test(x));
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}, readonly headers: Record<string, string> = {}) { super(message); }
}
const bad = (code: string, message: string, extra: Record<string, unknown> = {}) => new HttpError(400, code, message, extra);
const AMOUNT = /^[1-9]\d{0,38}$/;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function checkAccount(cfg: FundingConfig, a: unknown): string {
  if (typeof a !== "string") throw bad("bad_account", "account must be your intents account id");
  const okAcc = cfg.network === "mainnet" ? isImplicitAccount(a) : isImplicitAccount(a) || (isNearAccountId(a) && a.endsWith(".testnet"));
  if (!okAcc) throw bad("bad_account", cfg.network === "mainnet" ? "account must be a 64-hex implicit account id" : "account must be a 64-hex implicit or .testnet account id");
  return a;
}
function onlyFields(body: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad("unexpected_field", `unexpected field(s): ${extra.join(", ")} (the Worker sets recipients, refunds and fees itself)`);
}
const ceilPct = (units: string, pct: number) => ((BigInt(units) * BigInt(100 + pct) + 99n) / 100n).toString();

/** The echoed quoteRequest must match what we sent, field by field (appFees/depositMode etc. are 1Click's to fill). */
export function quoteMismatch(sent: OneClickQuoteRequest, resp: OneClickQuoteResponse): string[] {
  const q: any = resp?.quoteRequest ?? {};
  const out: string[] = [];
  for (const k of ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType"] as const) {
    if (q[k] !== sent[k]) out.push(k);
  }
  const x: any = resp?.quote ?? {};
  for (const k of ["amountIn", "minAmountIn", "amountOut", "minAmountOut"]) if (typeof x[k] !== "string" || !/^\d+$/.test(x[k])) out.push(`quote.${k}`);
  if (!sent.dry) {
    if (typeof x.depositAddress !== "string" || !x.depositAddress) out.push("quote.depositAddress");
    if (typeof x.deadline !== "string" || !Number.isFinite(Date.parse(x.deadline))) out.push("quote.deadline");
  }
  return out;
}

/** D-PM3: the BTC origin-chain quotes 1Click signs wrongly. Nothing else qualifies (INTENTS-deposit BTC verifies fine). */
export const BTC_ORIGIN_ASSET = "nep141:btc.omft.near";
export const isBtcOriginChain = (req: OneClickQuoteRequest) => req.depositType === "ORIGIN_CHAIN" && req.originAsset === BTC_ORIGIN_ASSET;
const feesOf = (v: unknown) => (v === undefined || (Array.isArray(v) && v.length === 0) ? "[]" : stableStringify(v));

/** D-PM3 stricter echo check for an UNSIGNED BTC quote, on top of quoteMismatch: also deadline and appFees (we send none, so the
 * echo must carry none: absent or []), and only for a real ORIGIN_CHAIN BTC request. Empty = acceptable. */
export function btcEchoMismatch(sent: OneClickQuoteRequest, resp: OneClickQuoteResponse): string[] {
  const q: any = resp?.quoteRequest ?? {};
  const out = quoteMismatch(sent, resp);
  if (!isBtcOriginChain(sent) || sent.dry) out.push("not_btc_origin_chain");
  if (typeof sent.deadline !== "string" || q.deadline !== sent.deadline) out.push("deadline");
  if (feesOf(q.appFees) !== feesOf(sent.appFees)) out.push("appFees");
  return out;
}

export function quoteView(kind: SwapKind, r: OneClickQuoteResponse) {
  const q = r.quote;
  return {
    ok: true, kind, dry: r.quoteRequest.dry, originAsset: r.quoteRequest.originAsset, destinationAsset: r.quoteRequest.destinationAsset,
    depositAddress: q.depositAddress ?? null, depositMemo: q.depositMemo ?? null,
    amountIn: q.amountIn, minAmountIn: q.minAmountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut,
    amountInUsd: q.amountInUsd ?? null, amountOutUsd: q.amountOutUsd ?? null, timeEstimateSec: q.timeEstimate ?? null,
    deadline: q.deadline ?? null, timeWhenInactive: q.timeWhenInactive ?? null,
    refundFee: q.refundFee ?? "0", withdrawFee: q.withdrawFee ?? "0", correlationId: r.correlationId,
  };
}

/** 1Click status -> the web tracker state (apps/web/lib/funding/types.ts TrackState; SPEC §4.6). */
export function trackState(r: Pick<SwapRecord, "status" | "deadline">, nowMs: number): string {
  switch (r.status) {
    case "KNOWN_DEPOSIT_TX": return "confirming";
    case "PROCESSING": return "converting";
    case "INCOMPLETE_DEPOSIT": return "short";
    case "SUCCESS": return "credited";
    case "REFUNDED": return "refunded";
    case "FAILED": return "failed";
    default: return Date.parse(r.deadline) + EXPIRE_GRACE_MS <= nowMs ? "expired" : "waiting";
  }
}

/** What /fund/list returns per record, in the web's SwapRecord shape (F2 apps/web/lib/funding/types.ts). Never the signed quote
 * or the intent payload. */
export function recordView(r: SwapRecord, tokens: OneClickToken[], nowMs: number) {
  const ref = (id: string) => { const t = tokens.find((x) => x.assetId === id); return { assetId: id, symbol: t?.symbol ?? "", blockchain: t?.blockchain ?? "", decimals: t?.decimals ?? 0 }; };
  return {
    id: r.depositMemo ? `${r.depositAddress}#${r.depositMemo}` : r.depositAddress, account: r.account, kind: r.kind,
    origin: ref(r.originAsset), destination: ref(r.destinationAsset),
    amountIn: r.amountIn, minAmountIn: r.minAmountIn, amountOut: r.amountOut, minAmountOut: r.minAmountOut,
    depositAddress: r.depositAddress, depositMemo: r.depositMemo, recipient: r.kind === "withdraw" ? r.recipient : null,
    deadline: r.deadline, createdAt: r.createdAt, updatedAt: r.updatedAt, state: trackState(r, nowMs), lastStatus: r.status,
    received: r.received ?? null, delivered: r.delivered ?? null, refunded: r.refunded ?? null, refundReason: r.refundReason ?? null,
    correlationId: r.correlationId, signed: r.kind === "fund" ? null : r.intentHash !== null, intentHash: r.intentHash, checkFailures: 0,
  };
}

export async function handleFunding(request: Request, d: FundingDeps): Promise<Response> {
  const cfg = d.config;
  const origin = request.headers.get("origin");
  const originOk = origin !== null && cfg.allowedOrigins.includes(origin.replace(/\/+$/, ""));
  const baseHeaders: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store", vary: "Origin" };
  if (originOk) { baseHeaders["access-control-allow-origin"] = origin!; baseHeaders["access-control-expose-headers"] = "retry-after"; }
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, ...extra } });

  if (origin !== null && !originOk) return json(403, { ok: false, code: "origin_not_allowed", error: "origin_not_allowed", message: "origin not allowed" });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...baseHeaders, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" } });
  }
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
  const ip = request.headers.get("cf-connecting-ip")?.trim() || null;
  const now = d.nowMs();
  const limit = async (rules: LimitRule[]) => {
    const r = await d.store.consume(rules, now);
    if (!r.ok) throw new HttpError(429, "rate_limited", "too many requests; try again later", { retryAfterS: r.retryAfterS }, { "retry-after": String(r.retryAfterS) });
  };
  const needIp = () => { if (!ip) throw bad("no_client_ip", "client address unavailable (fail closed)"); return ip; };
  const readBody = async (): Promise<Record<string, any>> => {
    const raw = await request.text();
    if (raw.length > 32_000) throw new HttpError(413, "too_large", "request too large");
    let b: unknown; try { b = JSON.parse(raw); } catch { throw bad("bad_json", "request body must be JSON"); }
    if (!isObj(b)) throw bad("bad_json", "request body must be a JSON object");
    return b;
  };
  const tokens = () => d.tokens.get(() => d.oneclick.tokens(), now);
  const tokenOf = (list: OneClickToken[], id: unknown) => (typeof id === "string" ? list.find((t) => t.assetId === id) : undefined);

  try {
    switch (route) {
      case "GET /tokens": {
        const list = await tokens();
        return json(200, { ok: true, bettingAssetIds: cfg.bettingAssetIds, tokens: list }, { "cache-control": "public, max-age=60" });
      }
      case "POST /fund/quote": return json(200, await fundQuote(await readBody()));
      case "POST /withdraw/quote": return json(200, await withdrawQuote(await readBody()));
      case "POST /withdraw/intent": return json(200, await withdrawIntent(await readBody()));
      case "POST /withdraw/submit": return json(200, await withdrawSubmit(await readBody()));
      case "POST /fund/submit-tx": return json(200, await submitTx(await readBody()));
      case "GET /fund/status": return json(200, await status());
      case "GET /fund/list": {
        await limit([{ key: `status:ip:${needIp()}`, limit: LIMITS.statusPerMinPerIp, windowMs: MIN }]);
        const account = checkAccount(cfg, url.searchParams.get("account"));
        // SECREV1 SR-1: anyone can create a cash out / convert quote for any account (no ownership proof yet), so an unsigned one is
        // never listed: the web would merge it and offer "Confirm" to the victim. Only the device that asked for it holds it locally.
        const recs = (await d.store.listAccount(account, now)).filter((r) => r.kind === "fund" || r.intentHash !== null);
        const list = recs.length ? await tokens().catch(() => [] as OneClickToken[]) : [];
        return json(200, recs.map((r) => recordView(r, list, now)));
      }
      default:
        return json(404, { ok: false, code: "no_route_here", error: "no_route_here", message: "unknown endpoint" });
    }
  } catch (e: any) {
    if (e instanceof HttpError) {
      d.log({ evt: "refused", route, code: e.code, status: e.status });
      return json(e.status, { ok: false, code: e.code, error: e.code, message: e.message, ...e.extra }, e.headers);
    }
    if (e instanceof OneClickError) {
      const status = e.code === "upstream_down" || e.code === "upstream_auth" ? 503 : e.code === "not_found" ? 404 : 422;
      d.log({ evt: "upstream_error", route, code: e.code, upstreamStatus: e.httpStatus });
      const code = e.code === "upstream_auth" ? "upstream_down" : e.code;
      const body: Record<string, unknown> = { ok: false, code, error: code, message: e.code === "upstream_auth" || e.code === "upstream_down" ? "the conversion service is unavailable right now" : e.upstreamMessage.slice(0, 200) };
      if (e.minUnits) body.minUnits = e.minUnits;
      return json(status, body);
    }
    d.log({ evt: "internal_error", route, name: String(e?.name ?? "Error") });
    return json(500, { ok: false, code: "internal", error: "internal", message: "internal error" });
  }

  // ------------------------------------------------------------------ handlers
  async function quoteLimits(dry: boolean, account: string) {
    const ipv = needIp();
    if (dry) await limit([{ key: `dry:ip:${ipv}`, limit: LIMITS.dryPerMinPerIp, windowMs: MIN }]);
    else {
      if (cfg.dryOnly) throw new HttpError(403, "dry_only", `real quotes are disabled on ${cfg.network} (1Click is mainnet-only)`);
      await limit([
        { key: `real:ip:${ipv}`, limit: LIMITS.realPerHourPerIp, windowMs: HOUR },
        { key: `real:acct:${account}`, limit: LIMITS.realPerHourPerAccount, windowMs: HOUR },
      ]);
    }
  }

  /** Sends a quote; a real one must be signed by 1Click and echo our request, then it is stored before the address is returned. */
  async function runQuote(kind: SwapKind, account: string, req: OneClickQuoteRequest) {
    const resp = await d.oneclick.quote(req);
    const mism = quoteMismatch(req, resp);
    if (mism.length) {
      d.log({ evt: "quote_mismatch", kind, fields: mism, correlationId: resp?.correlationId ?? null });
      throw new HttpError(502, "quote_mismatch", "the conversion service returned a quote that does not match the request");
    }
    if (!req.dry) {
      let quoteSignature: SwapRecord["quoteSignature"] = "verified";
      if (!verifyQuoteSignature(resp, d.quoteSigningKey ?? ONE_CLICK_MANAGER_PUB_KEY)) {
        const direct = d.oneclick.baseUrl === ONECLICK_OFFICIAL_BASE_URL; // https, 1Click's own origin, no proxy in between
        if (kind !== "fund" || !isBtcOriginChain(req) || !direct || btcEchoMismatch(req, resp).length) {
          d.log({ evt: "bad_signature", kind, correlationId: resp.correlationId, originAsset: req.originAsset });
          throw new HttpError(502, "bad_signature", "the quote signature does not verify; nothing was stored");
        }
        quoteSignature = "btc_unverified";
      }
      const q = resp.quote;
      const rec: SwapRecord = {
        depositAddress: q.depositAddress!, depositMemo: q.depositMemo ?? null, account, kind, originAsset: req.originAsset, destinationAsset: req.destinationAsset,
        amountIn: q.amountIn, minAmountIn: q.minAmountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut, recipient: req.recipient,
        deadline: q.deadline!, createdAt: now, updatedAt: now, status: "PENDING_DEPOSIT", correlationId: resp.correlationId, signedQuote: resp, quoteSignature,
        intentPayload: null, intentHash: null, submittedAt: null, lastError: null,
      };
      const ins = await d.store.insertCapped(rec, LIMITS.maxOpenPerAccount, now);
      if (ins === "too_many_open") throw new HttpError(429, "too_many_open", `at most ${LIMITS.maxOpenPerAccount} transfers can be in progress at once`);
      if (ins === "exists") throw new HttpError(502, "duplicate_address", "the conversion service reused a deposit address");
      if (quoteSignature === "btc_unverified") {
        d.log({ evt: "quote_sig_btc_unverified", level: "warn", kind, correlationId: resp.correlationId, depositAddress: rec.depositAddress, originAsset: req.originAsset, destinationAsset: req.destinationAsset, amount: req.amount, deadline: req.deadline });
      }
      d.log({ evt: "quote_stored", kind, correlationId: resp.correlationId, depositAddress: rec.depositAddress });
    } else d.log({ evt: "quote_dry", kind, correlationId: resp.correlationId });
    return quoteView(kind, resp);
  }

  async function fundQuote(b: Record<string, any>) {
    onlyFields(b, ["account", "originAsset", "betWith", "amountIn", "needOut", "dry"]);
    const account = checkAccount(cfg, b.account);
    if (typeof b.dry !== "boolean") throw bad("bad_dry", "dry must be true or false");
    if (typeof b.betWith !== "string" || !cfg.bettingAssetIds.includes(b.betWith)) throw bad("not_bet_token", "betWith must be one of the bet tokens");
    if ((b.amountIn === undefined) === (b.needOut === undefined)) throw bad("bad_amount", "send exactly one of amountIn or needOut");
    const amt = b.amountIn ?? b.needOut;
    if (typeof amt !== "string" || !AMOUNT.test(amt)) throw bad("bad_amount", "amount must be a positive integer string in base units");
    await quoteLimits(b.dry, account);
    const list = await tokens();
    const origin = tokenOf(list, b.originAsset);
    if (!origin) throw bad("unknown_origin", "originAsset is not a token the conversion service accepts");
    const dest = tokenOf(list, b.betWith);
    const slow = SLOW_CHAINS.includes(origin.blockchain);
    const base = {
      slippageTolerance: STABLE.test(origin.symbol) && dest && STABLE.test(dest.symbol) ? 50 : 100,
      originAsset: origin.assetId, depositType: "ORIGIN_CHAIN" as const, destinationAsset: b.betWith,
      refundTo: account, refundType: "INTENTS" as const, recipient: account, recipientType: "INTENTS" as const,
      deadline: new Date(now + (slow ? 3 : 1) * HOUR).toISOString(), referral: cfg.referral,
      // 1Click: "Incorrect depositMode for originAsset from stellar chain" unless MEMO (FUND3 evidence); others reject MEMO
      ...(MEMO_DEPOSIT_CHAINS.includes(origin.blockchain) ? { depositMode: "MEMO" as const } : {}),
    };
    let amountIn = b.amountIn as string | undefined;
    if (amountIn === undefined) {
      const sizing: OneClickQuoteRequest = { ...base, dry: true, swapType: "EXACT_OUTPUT", amount: b.needOut, quoteWaitingTimeMs: 0 };
      const s = await d.oneclick.quote(sizing);
      if (quoteMismatch(sizing, s).length) throw new HttpError(502, "quote_mismatch", "the conversion service returned a quote that does not match the request");
      amountIn = ceilPct(s.quote.amountIn, 1);
    }
    return runQuote("fund", account, { ...base, dry: b.dry, swapType: "FLEX_INPUT", amount: amountIn, quoteWaitingTimeMs: b.dry ? 0 : 3000 });
  }

  async function withdrawQuote(b: Record<string, any>) {
    onlyFields(b, ["account", "kind", "originAsset", "amountIn", "destinationAsset", "recipient", "dry"]);
    const account = checkAccount(cfg, b.account);
    if (b.kind !== "withdraw" && b.kind !== "convert") throw bad("bad_kind", 'kind must be "withdraw" or "convert"');
    if (typeof b.dry !== "boolean") throw bad("bad_dry", "dry must be true or false");
    if (typeof b.amountIn !== "string" || !AMOUNT.test(b.amountIn)) throw bad("bad_amount", "amountIn must be a positive integer string in base units");
    if (b.kind === "convert") {
      if (b.recipient !== undefined) throw bad("unexpected_field", "convert always lands in your own account; do not send a recipient");
      if (typeof b.destinationAsset !== "string" || !cfg.bettingAssetIds.includes(b.destinationAsset)) throw bad("not_bet_token", "convert only into a bet token");
      if (b.destinationAsset === b.originAsset) throw bad("same_asset", "origin and destination are the same token");
    }
    await quoteLimits(b.dry, account);
    const list = await tokens();
    const origin = tokenOf(list, b.originAsset);
    if (!origin) throw bad("unknown_origin", "originAsset is not a token the conversion service accepts");
    const dest = tokenOf(list, b.destinationAsset);
    if (!dest) throw bad("unknown_destination", "destinationAsset is not a token the conversion service delivers");
    let recipient = account;
    if (b.kind === "withdraw") {
      const own = (await d.store.listAccount(account, now)).filter((r) => !isTerminal(r.status)).map((r) => r.depositAddress);
      // a token's own contract is never a wallet (1Click answers "Internal server error" for it, FUND3; on some chains funds would be lost)
      const contracts = list.filter((t) => t.blockchain === dest.blockchain && t.contractAddress).map((t) => t.contractAddress!);
      const chk = validateRecipient(dest.blockchain, b.recipient, { account, refused: [...own, ...contracts] });
      if (!chk.ok) throw bad("bad_recipient", chk.detail, { reason: chk.reason });
      recipient = b.recipient;
    }
    if (!b.dry) {
      let bal: bigint;
      try { bal = await d.chain.intentsBalance(account, origin.assetId); } catch { throw new HttpError(503, "rpc_down", "could not read your balance right now"); }
      if (bal < BigInt(b.amountIn)) throw bad("insufficient_balance", "your balance is lower than this amount");
    }
    return runQuote(b.kind, account, {
      dry: b.dry, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: origin.assetId, depositType: "INTENTS",
      destinationAsset: dest.assetId, amount: b.amountIn, refundTo: account, refundType: "INTENTS", recipient,
      recipientType: b.kind === "withdraw" ? "DESTINATION_CHAIN" : "INTENTS", deadline: new Date(now + 30 * MIN).toISOString(),
      referral: cfg.referral, quoteWaitingTimeMs: b.dry ? 0 : 3000,
    });
  }

  async function ownedRecord(account: string, depositAddress: unknown): Promise<SwapRecord> {
    if (typeof depositAddress !== "string" || !depositAddress) throw bad("bad_address", "depositAddress is required");
    const r = await d.store.get(depositAddress);
    if (!r || r.account !== account) throw new HttpError(404, "not_found", "no transfer with this address for this account");
    if (r.kind === "fund") throw bad("wrong_kind", "this is a deposit, not a cash out or convert");
    return r;
  }

  async function withdrawIntent(b: Record<string, any>) {
    onlyFields(b, ["account", "depositAddress"]);
    const account = checkAccount(cfg, b.account);
    const r = await ownedRecord(account, b.depositAddress);
    if (r.submittedAt !== null) throw new HttpError(409, "already_submitted", "this transfer was already confirmed");
    if (Date.parse(r.deadline) <= now) throw new HttpError(410, "expired", "this quote expired; get a new one");
    // SECREV1 SR-6: once issued, the payload is fixed until submit (deadline <= the quote's): asking again returns it, costs no 1Click
    // call and no quota, so nobody can overwrite the payload the user is signing or use up the owner's allowance.
    const stored = r.intentPayload ? JSON.parse(r.intentPayload) : null;
    const storedDeadline = (() => { try { return Date.parse(JSON.parse(stored?.message ?? "null")?.deadline); } catch { return NaN; } })();
    if (stored && Number.isFinite(storedDeadline) && storedDeadline - now > 2 * MIN) { // enough time left to sign and submit
      const payload = stored;
      return { ok: true, intent: { standard: "nep413", payload }, hash: [...hashNep413Payload(payload)].map((x) => x.toString(16).padStart(2, "0")).join("") };
    }
    await limit([{ key: `intent:acct:${account}`, limit: LIMITS.intentPerHourPerAccount, windowMs: HOUR }]);
    const g = await d.oneclick.generateIntent({ type: "swap_transfer", standard: "nep413", signerId: account, depositAddress: r.depositAddress });
    const chk = checkSwapTransferIntent(g?.intent, { signerId: account, depositAddress: r.depositAddress, originAsset: r.originAsset, amountIn: r.amountIn, maxDeadlineMs: Date.parse(r.deadline), nowMs: now });
    if (!chk.ok) {
      d.log({ evt: "intent_mismatch", depositAddress: r.depositAddress, problems: chk.problems });
      await d.store.patch(r.depositAddress, { lastError: `intent_mismatch: ${chk.problems.join("; ")}`.slice(0, 500), updatedAt: now });
      throw new HttpError(502, "intent_mismatch", "the transfer to sign does not match the quote; nothing was signed");
    }
    await d.store.patch(r.depositAddress, { intentPayload: stableStringify(chk.payload), updatedAt: now });
    const hash = hashNep413Payload(chk.payload);
    return { ok: true, intent: { standard: "nep413", payload: chk.payload }, hash: [...hash].map((x) => x.toString(16).padStart(2, "0")).join("") };
  }

  async function withdrawSubmit(b: Record<string, any>) {
    onlyFields(b, ["account", "depositAddress", "signedData"]);
    // account is optional (the F2 client sends only depositAddress + signedData): the record names its owner, and the signature
    // must be that owner's key. If an account is sent it must match.
    if (typeof b.depositAddress !== "string" || !b.depositAddress) throw bad("bad_address", "depositAddress is required");
    const owner = (await d.store.get(b.depositAddress))?.account;
    if (!owner) throw new HttpError(404, "not_found", "no transfer with this address for this account");
    const account = b.account === undefined ? owner : checkAccount(cfg, b.account);
    const r = await ownedRecord(account, b.depositAddress);
    if (r.submittedAt !== null) throw new HttpError(409, "already_submitted", "this transfer was already confirmed");
    if (!r.intentPayload) throw new HttpError(409, "no_intent", "ask for the transfer to sign first");
    if (Date.parse(r.deadline) <= now) throw new HttpError(410, "expired", "this quote expired; get a new one");
    const s = b.signedData as SignedNep413;
    if (!isObj(s) || s.standard !== "nep413" || !isObj(s.payload)) throw bad("bad_signed_data", "signedData must be a NEP-413 signed payload");
    const extra = Object.keys(s).filter((k) => !["standard", "payload", "public_key", "signature"].includes(k));
    if (extra.length) throw bad("bad_signed_data", `unexpected signedData field(s): ${extra.join(", ")}`);
    if (stableStringify(s.payload) !== r.intentPayload) throw bad("payload_mismatch", "the signed payload is not the one that was issued");
    let pub: Uint8Array, sig: Uint8Array;
    try {
      pub = bs58.decode(String(s.public_key).replace(/^ed25519:/, "")); sig = bs58.decode(String(s.signature).replace(/^ed25519:/, ""));
    } catch { throw bad("bad_signature", "public_key/signature must be ed25519:<base58>"); }
    if (!String(s.public_key).startsWith("ed25519:") || !String(s.signature).startsWith("ed25519:") || pub.length !== 32 || sig.length !== 64) throw bad("bad_signature", "public_key/signature must be ed25519:<base58>");
    const pubHex = [...pub].map((x) => x.toString(16).padStart(2, "0")).join("");
    if (isImplicitAccount(account) && pubHex !== account) throw bad("wrong_signer", "the signing key is not this account's key");
    if (!nacl.sign.detached.verify(hashNep413Payload(s.payload as any), sig, pub)) throw bad("bad_signature", "the signature does not verify");
    // SECREV1 SR-6: counted only once the owner's signature verified (junk submits cannot use up the owner's allowance)
    await limit([{ key: `intent:acct:${account}`, limit: LIMITS.intentPerHourPerAccount, windowMs: HOUR }]);
    const res = await d.oneclick.submitIntent({ type: "swap_transfer", signedData: { standard: "nep413", payload: s.payload, public_key: s.public_key, signature: s.signature } });
    if (!res || typeof res.intentHash !== "string") throw new HttpError(502, "upstream_rejected", "the conversion service did not accept the transfer");
    await d.store.patch(r.depositAddress, { intentHash: res.intentHash, submittedAt: now, updatedAt: now });
    d.log({ evt: "intent_submitted", depositAddress: r.depositAddress, correlationId: res.correlationId ?? null });
    return { ok: true, intentHash: res.intentHash, correlationId: res.correlationId ?? null };
  }

  async function submitTx(b: Record<string, any>) {
    onlyFields(b, ["depositAddress", "txHash", "memo"]);
    await limit([{ key: `submittx:ip:${needIp()}`, limit: LIMITS.submitTxPerHourPerIp, windowMs: HOUR }]);
    if (typeof b.txHash !== "string" || !/^[\w:-]{8,128}$/.test(b.txHash)) throw bad("bad_tx_hash", "txHash looks wrong");
    if (b.memo !== undefined && (typeof b.memo !== "string" || b.memo.length > 64)) throw bad("bad_memo", "memo looks wrong");
    const r = typeof b.depositAddress === "string" ? await d.store.get(b.depositAddress) : null;
    if (!r || r.kind !== "fund") throw new HttpError(404, "not_found", "no deposit with this address");
    await d.oneclick.submitDeposit({ txHash: b.txHash, depositAddress: r.depositAddress, ...(b.memo ? { memo: b.memo } : r.depositMemo ? { memo: r.depositMemo } : {}) });
    d.log({ evt: "deposit_tx_submitted", depositAddress: r.depositAddress });
    return { ok: true };
  }

  async function status() {
    await limit([{ key: `status:ip:${needIp()}`, limit: LIMITS.statusPerMinPerIp, windowMs: MIN }]);
    const addr = url.searchParams.get("depositAddress");
    const r = addr ? await d.store.get(addr) : null;
    if (!r) throw new HttpError(404, "not_found", "no transfer with this address"); // never an open proxy to 1Click
    const s = await d.oneclick.status(r.depositAddress, r.depositMemo ?? undefined);
    const st = s?.status as OneClickStatus;
    if (!["KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"].includes(st)) throw new OneClickError("upstream_down", 200, "unknown status");
    const sd = s.swapDetails ?? {};
    const units = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? v : null);
    const details = { received: units(sd.depositedAmount), delivered: st === "SUCCESS" ? units(sd.amountOut) : null, refunded: units(sd.refundedAmount), refundReason: typeof sd.refundReason === "string" ? sd.refundReason : null };
    const changed = st !== r.status || details.received !== (r.received ?? null) || details.refunded !== (r.refunded ?? null) || details.delivered !== (r.delivered ?? null);
    const next = changed ? (await d.store.patch(r.depositAddress, { status: st, updatedAt: now, ...details })) ?? r : r;
    if (st !== r.status) d.log({ evt: "status", depositAddress: r.depositAddress, status: st });
    const links = (v: unknown) => (Array.isArray(v) ? v.filter((t: any) => t && typeof t.hash === "string").map((t: any) => ({ hash: t.hash, explorerUrl: typeof t.explorerUrl === "string" ? t.explorerUrl : null })) : []);
    // flat StatusView (F2 apps/web/lib/funding/types.ts) + the record in the web shape
    return {
      ok: true, status: st, updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : null, correlationId: r.correlationId,
      depositedAmount: details.received, amountOut: units(sd.amountOut), refundedAmount: details.refunded, refundReason: details.refundReason,
      originTxs: links(sd.originChainTxHashes), destinationTxs: links(sd.destinationChainTxHashes), nearTxHashes: Array.isArray(sd.nearTxHashes) ? sd.nearTxHashes.filter((h: unknown) => typeof h === "string") : [],
      record: recordView(next, await tokens().catch(() => [] as OneClickToken[]), now),
    };
  }
}
