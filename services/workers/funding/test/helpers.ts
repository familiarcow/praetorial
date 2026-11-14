// F1 test harness: a mocked 1Click (signs its quotes with a test manager key, records every call) + an in-memory store.
// No test talks to the real 1Click.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { quoteHash } from "../../../common/src/funding/quoteSignature.js";
import type { OneClickQuoteRequest, OneClickQuoteResponse, OneClickToken } from "../../../common/src/funding/oneclickTypes.js";
import { handleFunding, TokenCache, type FundingConfig, type FundingDeps } from "../src/core.js";
import { ONECLICK_OFFICIAL_BASE_URL, OneClickError, mapOneClickError, type OneClickApi } from "../src/oneclick.js";
import { FundingState, memoryKv } from "../src/store.js";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", n), "utf8"));
export const TOKENS: OneClickToken[] = fixture("tokens.json");

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDT = "nep141:usdt.tether-token.near";
export const WNEAR = "nep141:wrap.near";
export const BTC = "nep141:btc.omft.near";
export const ETH = "nep141:eth.omft.near";
export const ZEC = "nep141:zec.omft.near";
export const BET = [USDC, USDT, WNEAR, BTC, ETH, ZEC];
export const TRON_USDT = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
export const BASE_USDC = TOKENS.find((t) => t.symbol === "USDC" && t.blockchain === "base")!.assetId;
export const STELLAR_USDC = TOKENS.find((t) => t.symbol === "USDC" && t.blockchain === "stellar")!.assetId;
export const ETH_USDC = TOKENS.find((t) => t.symbol === "USDC" && t.blockchain === "eth")!.assetId;

/** A user: implicit account id = hex of the ed25519 public key (as for Privy users). */
export const USER_KEYS = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
export const ACCOUNT = Buffer.from(USER_KEYS.publicKey).toString("hex");
export const OTHER = "b".repeat(64);
export const ORIGIN = "https://app.praetorial.test";
export const IP = "203.0.113.9";
export const NOW = Date.parse("2026-11-11T12:00:00.000Z");

const MANAGER = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
export const TEST_MANAGER_PUB = `ed25519:${bs58.encode(MANAGER.publicKey)}`;
export function signQuote(r: Omit<OneClickQuoteResponse, "signature">): OneClickQuoteResponse {
  const sig = nacl.sign.detached(new TextEncoder().encode(quoteHash(r)), MANAGER.secretKey);
  return { ...r, signature: `ed25519:${bs58.encode(sig)}` } as OneClickQuoteResponse;
}

export interface Fake extends OneClickApi {
  calls: { op: string; body: any }[];
  /** override the next quote response(s): (req) => response or throws */
  onQuote?: (req: OneClickQuoteRequest, def: OneClickQuoteResponse) => OneClickQuoteResponse;
  onGenerate?: (body: any, def: any) => any;
  statusOf: Map<string, any>;
  tokensFail?: boolean;
}

let addrN = 0;
export function fakeOneClick(): Fake {
  const f: Fake = {
    calls: [], statusOf: new Map(), baseUrl: ONECLICK_OFFICIAL_BASE_URL,
    async tokens() { f.calls.push({ op: "tokens", body: null }); if (f.tokensFail) throw new OneClickError("upstream_down", 503, "down"); return structuredClone(TOKENS); },
    async quote(req) {
      f.calls.push({ op: "quote", body: structuredClone(req) });
      const amt = req.amount;
      const q: any = { amountIn: amt, amountInFormatted: "1", amountInUsd: "1.0", minAmountIn: (BigInt(amt) * 99n / 100n).toString(), amountOut: (BigInt(amt) * 999n / 1000n).toString(), amountOutFormatted: "1", amountOutUsd: "1.0", minAmountOut: (BigInt(amt) * 98n / 100n).toString(), timeEstimate: 80, refundFee: "0", withdrawFee: "0" };
      if (req.swapType === "EXACT_OUTPUT") { q.amountIn = (BigInt(amt) * 102n / 100n).toString(); q.amountOut = amt; }
      if (!req.dry) { q.depositAddress = `dep${++addrN}`.padEnd(64, "0").slice(0, 64); q.deadline = req.deadline; q.timeWhenInactive = req.deadline; if (req.depositMode === "MEMO") q.depositMemo = "123456"; }
      const def = signQuote({ quote: q, quoteRequest: { ...structuredClone(req), depositMode: req.depositMode ?? "SIMPLE", confidentiality: "public", insured: false, appFees: [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 1 }] } as any, timestamp: new Date(NOW).toISOString(), correlationId: `corr-${addrN}` });
      return f.onQuote ? f.onQuote(req, def) : def;
    },
    async status(a) {
      f.calls.push({ op: "status", body: a });
      const s = f.statusOf.get(a);
      if (s instanceof Error) throw s;
      return s ?? { correlationId: "c", quoteResponse: {} as any, status: "PENDING_DEPOSIT", updatedAt: new Date(NOW).toISOString(), swapDetails: {} };
    },
    async submitDeposit(b) { f.calls.push({ op: "submitDeposit", body: b }); return { status: "KNOWN_DEPOSIT_TX" }; },
    async generateIntent(b) {
      f.calls.push({ op: "generateIntent", body: b });
      const rec = genFor.get(b.depositAddress);
      const msg = { signer_id: b.signerId, deadline: new Date(NOW + 10 * 60_000).toISOString(), intents: [{ intent: "transfer", receiver_id: b.depositAddress, tokens: { [rec?.originAsset ?? USDC]: rec?.amountIn ?? "0" } }] };
      const def = { intent: { standard: "nep413", payload: { message: JSON.stringify(msg), nonce: Buffer.alloc(32, 3).toString("base64"), recipient: "intents.near" } }, correlationId: "gen-1" };
      return f.onGenerate ? f.onGenerate(b, def) : def;
    },
    async submitIntent(b) { f.calls.push({ op: "submitIntent", body: b }); return { intentHash: "IntentHash111", correlationId: "sub-1" }; },
  };
  return f;
}
/** generateIntent's mock needs the record's asset/amount: tests register them here. */
export const genFor = new Map<string, { originAsset: string; amountIn: string }>();

export const throwing = (status: number, message: string) => { throw mapOneClickError(status, message); };

export interface Harness { deps: FundingDeps; fake: Fake; state: FundingState; kv: ReturnType<typeof memoryKv>; logs: Record<string, unknown>[]; balances: Map<string, bigint>; setNow(ms: number): void; rpcDown: { v: boolean } }
export function harness(cfg: Partial<FundingConfig> = {}): Harness {
  const kv = memoryKv(), state = new FundingState(kv), fake = fakeOneClick(), logs: Record<string, unknown>[] = [], balances = new Map<string, bigint>();
  let now = NOW; const rpcDown = { v: false };
  const deps: FundingDeps = {
    config: { network: "mainnet", allowedOrigins: [ORIGIN], bettingAssetIds: BET, referral: "praetorial", dryOnly: false, ...cfg },
    oneclick: fake, store: state,
    chain: { async intentsBalance(a, t) { if (rpcDown.v) throw new Error("rpc down"); return balances.get(`${a}|${t}`) ?? 0n; } },
    tokens: new TokenCache(), log: (e) => logs.push(e), nowMs: () => now, quoteSigningKey: TEST_MANAGER_PUB,
  };
  return { deps, fake, state, kv, logs, balances, setNow: (ms) => { now = ms; }, rpcDown };
}

export async function call(h: Harness, method: string, pathQ: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { origin: ORIGIN, "cf-connecting-ip": IP, ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const r = await handleFunding(new Request(`https://funding.test${pathQ}`, init), h.deps);
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, json: text ? JSON.parse(text) : null };
}

export const fundBody = (o: Record<string, unknown> = {}) => ({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "50000000", dry: true, ...o });
export const lastQuote = (h: Harness) => [...h.fake.calls].reverse().find((c) => c.op === "quote")!.body as OneClickQuoteRequest;
