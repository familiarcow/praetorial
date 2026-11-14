// F5: the mocked world for the Cash out / Convert specs (withdraw-cashout.spec.ts, convert.spec.ts). A stand-in for the funding
// Worker's /withdraw/* that behaves like services/workers/funding/src/core.ts: a real quote stores a record with a deadline, the
// intent is a real NEP-413 `swap_transfer` payload (one transfer of amountIn of originAsset to the deposit address, signed by the
// account), and submit verifies the ed25519 signature over the NEP-413 hash with the account's own key (its 64-hex id). The test
// wallet signs with a real key (tweetnacl, through page.exposeFunction), so a wrong hash or payload would fail exactly as live.
// Everything else (/fund/*) is F2's createMockFundingWorker. Nothing here talks to the network.
import { type Page } from "@playwright/test";
import nacl from "tweetnacl";
import { hashNep413Payload } from "../../lib/funding/intentCheck";
import { ONECLICK_TOKENS, ID, createMockFundingWorker, status, withdrawQuote } from "./fixtures";
import type { QuoteView, StatusView, SwapRecord } from "../../lib/funding/types";

export const KP = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
export const ME = Buffer.from(KP.publicKey).toString("hex");
export const RPC = "https://test.rpc.fastnear.com";
export const FUNDING = "https://praetorial-funding-testnet.familiarcow.workers.dev";
export const USDC_T = "nep141:usdc.testnet", WNEAR_T = "nep141:wrap.testnet";
export const TRON_ADDR = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9";
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

export interface WorkerOpts {
  /** Statuses after submit (the last repeats). Default: PROCESSING, then SUCCESS. */
  after?: StatusView[];
  tooLow?: string;
  down?: boolean;
  /** Mutate the generated message (payload-mismatch cases). */
  tamper?: (m: any) => void;
  /** Override amounts of the quote for a request body. */
  quote?: (body: any) => Partial<QuoteView>;
  /** Fail the submit (the answer is lost on the way). */
  submitDown?: boolean;
}
export interface Call { method: string; path: string; body: any }

export function f5Worker(o: WorkerOpts = {}) {
  const base = createMockFundingWorker();
  const calls: Call[] = [];
  const recs = new Map<string, { body: any; quote: QuoteView; payload: any; submitted: boolean; seq: number }>();
  let n = 0;
  const reply = (status: number, body: unknown) => ({ status, body });
  function handle(method: string, url: string, body: any): { status: number; body: unknown } {
    const u = new URL(url);
    calls.push({ method, path: u.pathname, body });
    if (o.down) return reply(503, { error: "upstream_down", message: "down" });
    switch (`${method} ${u.pathname}`) {
      case "POST /withdraw/quote": {
        if (o.tooLow) return reply(400, { error: "too_low", minUnits: o.tooLow, message: "Amount is too low" });
        const q = withdrawQuote({ amountIn: body.amountIn, minAmountIn: body.amountIn, ...(o.quote?.(body) ?? {}), depositAddress: null, deadline: null });
        if (body.dry) return reply(200, q);
        const addr = (++n).toString(16).padStart(64, "d");
        const real = { ...q, depositAddress: addr, deadline: new Date(Date.now() + 30 * 60_000).toISOString() };
        recs.set(addr, { body, quote: real, payload: null, submitted: false, seq: 0 });
        return reply(200, real);
      }
      case "POST /withdraw/intent": {
        const r = recs.get(body.depositAddress);
        if (!r || body.account !== r.body.account) return reply(404, { error: "not_found" });
        const m: any = {
          signer_id: body.account, deadline: new Date(Date.parse(r.quote.deadline!) - 60_000).toISOString(),
          intents: [{ intent: "transfer", receiver_id: body.depositAddress, tokens: { [r.body.originAsset]: r.body.amountIn } }],
        };
        o.tamper?.(m);
        r.payload = { message: JSON.stringify(m), nonce: Buffer.alloc(32, n).toString("base64"), recipient: "intents.near" };
        return reply(200, { ok: true, intent: { standard: "nep413", payload: r.payload }, hash: hex(hashNep413Payload(r.payload)) });
      }
      case "POST /withdraw/submit": {
        const r = recs.get(body.depositAddress);
        const s = body.signedData;
        if (!r || !r.payload || JSON.stringify(s.payload) !== JSON.stringify(r.payload)) return reply(400, { error: "payload_mismatch" });
        const b58 = (x: string) => Uint8Array.from(require58(x.replace(/^ed25519:/, "")));
        const pub = b58(s.public_key), sig = b58(s.signature);
        if (hex(pub) !== r.body.account || !nacl.sign.detached.verify(hashNep413Payload(s.payload), sig, pub)) return reply(400, { error: "bad_signature" });
        if (o.submitDown) return reply(502, { error: "upstream_rejected" });
        r.submitted = true;
        return reply(200, { ok: true, intentHash: `IntentHash${n}` });
      }
      case "GET /fund/status": {
        const r = recs.get(u.searchParams.get("depositAddress") ?? "");
        if (!r) return base.handle(method, url, body);
        if (!r.submitted) return reply(200, status("PENDING_DEPOSIT"));
        const list = o.after ?? [status("PROCESSING", { depositedAmount: r.quote.amountIn }), status("SUCCESS", { depositedAmount: r.quote.amountIn, amountOut: r.quote.amountOut })];
        return reply(200, list[Math.min(r.seq++, list.length - 1)]);
      }
      case "GET /fund/list": return reply(200, []);
      default: return base.handle(method, url, body);
    }
  }
  const route = async (rt: any) => {
    const req = rt.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" };
    if (req.method() === "OPTIONS") return rt.fulfill({ status: 204, contentType: "text/plain", body: "", headers: cors });
    const pd = req.postData();
    const r = handle(req.method(), req.url(), pd ? JSON.parse(pd) : undefined);
    return rt.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body), headers: cors });
  };
  return { calls, recs, route, signedSubmits: () => calls.filter((c) => c.path === "/withdraw/submit").length };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function require58(s: string): number[] {
  let x = 0n;
  for (const c of s) x = x * 58n + BigInt(B58.indexOf(c));
  const out: number[] = [];
  while (x > 0n) { out.unshift(Number(x & 0xffn)); x >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return out;
}

export interface World { usdc?: string; wnear?: string; nearUsdc?: string; stray?: Record<string, string>; local?: SwapRecord[]; refuse?: boolean }

/** Wallet (real key), the deposit-API seam, 1Click tokens, the mocked Worker, NEAR RPC. Returns the Worker and the sign log. */
export async function mockF5(page: Page, w: World = {}, o: WorkerOpts = {}) {
  const worker = f5Worker(o);
  const signs: string[] = [];
  await page.exposeFunction("__f5Sign", (hashHex: string) => {
    signs.push(hashHex);
    return hex(nacl.sign.detached(Buffer.from(hashHex, "hex"), KP.secretKey));
  });
  await page.addInitScript(({ me, local, refuse }) => {
    (window as any).__e2eTestWallet = {
      nearAddress: me,
      signRawHash: async (_a: string, h: string) => {
        if (refuse || (window as any).__f5Refuse) throw new Error("User rejected the request");
        return (window as any).__f5Sign(h);
      },
    };
    (window as any).__e2eDepositApi = true;
    (window as any).__e2eFundingWorker = true;
    if (local.length && !sessionStorage.getItem("f5-seeded")) {
      localStorage.setItem(`praetorial:funding:v1:${me}`, JSON.stringify(local));
      sessionStorage.setItem("f5-seeded", "1");
    }
  }, { me: ME, local: w.local ?? [], refuse: !!w.refuse });
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ONECLICK_TOKENS) }));
  await page.route(`${FUNDING}/**`, (r) => worker.route(r));
  await page.route("https://bridge.chaindefuser.com/rpc", (r) => r.fulfill({ status: 500, body: "{}" }));
  await page.route("**/praetorial-indexer-testnet.familiarcow.workers.dev/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("http://localhost:8787/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  const stray = w.stray ?? {};
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const p = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (p.request_type === "view_access_key") return ok({ nonce: 1 });
    if (p.request_type === "view_account") return ok({ amount: "0" });
    if (p.request_type !== "call_function") return ok({});
    const args = JSON.parse(Buffer.from(p.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
    const m = p.method_name as string;
    const bal = (id: string) => (id === USDC_T ? w.usdc ?? "42100000" : id === WNEAR_T ? w.wnear ?? "0" : stray[id] ?? "0");
    let r: unknown = null;
    if (m === "mt_batch_balance_of") r = (args.token_ids as string[]).map(bal);
    else if (m === "mt_balance_of") r = bal(args.token_id);
    else if (m === "mt_tokens_for_owner") r = Number(args.from_index) > 0 ? [] : Object.keys(stray).map((token_id) => ({ token_id }));
    else if (m === "ft_balance_of") r = p.account_id === "usdc.testnet" ? w.nearUsdc ?? "0" : "0";
    else if (m === "storage_balance_of") r = { total: "1250000000000000000000", available: "0" };
    else if (m === "is_paused" || m === "is_shutdown") r = false;
    else if (m === "open_offers") r = [];
    else if (m === "pending_payouts") r = [];
    return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
  });
  return { worker, signs };
}

export const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
export { ID };
