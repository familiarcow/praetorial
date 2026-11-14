// Shared miniflare harness for keeper worker tests (functional: worker.miniflare.test.ts; wall budget: test-budget/).
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { KeyPair } from "near-api-js";
import bs58 from "bs58";
import { dueBet } from "../../../keeper/test/helpers/dueBet.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KEY = (KeyPair.fromRandom("ed25519") as any).toString() as string;

export async function bundle(): Promise<string> {
  const r = await build({ entryPoints: [path.join(HERE, "../src/index.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent" });
  return r.outputFiles[0].text;
}

/** An Open bet whose funding deadline passed an hour ago: the keeper must `expire` it. */
export function expiredOpenBet() {
  const b: any = dueBet();
  b.status = "Open"; b.taker = null; b.taken_at = null;
  const past = (Date.now() - 3600_000) * 1_000_000;
  b.envelope = { ...b.envelope, funding_deadline: past, resolve_deadline: past };
  return b;
}

export interface Mock { bets: Record<number, any>; txs: { method: string; sig: boolean }[]; telegram: string[]; rpcCalls: number }
export function mockWorld(): Mock { return { bets: {}, txs: [], telegram: [], rpcCalls: 0 }; }

function outbound(w: Mock) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.hostname === "api.telegram.org") { w.telegram.push(JSON.parse(await req.text()).text); return Response.json({ ok: true }); }
    assert.equal(url.hostname, "test.rpc.fastnear.com", `unexpected outbound ${url.hostname}`);
    w.rpcCalls++;
    const body: any = JSON.parse(await req.text());
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "query" && body.params.request_type === "call_function") {
      const args = JSON.parse(atob(body.params.args_base64));
      const val = body.params.method_name === "get_bet" ? (w.bets[args.bet_id] ?? null)
        : body.params.method_name === "pending_payouts_view" ? [] : body.params.method_name === "is_shutdown" ? false : null;
      return ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(val))) });
    }
    if (body.method === "query" && body.params.request_type === "view_access_key") return ok({ nonce: 100, permission: "FullAccess" });
    if (body.method === "block") return ok({ header: { hash: bs58.encode(new Uint8Array(32).fill(7)) } });
    if (body.method === "send_tx") { w.txs.push({ method: "send_tx", sig: typeof body.params.signed_tx_base64 === "string" }); return ok({ status: { SuccessValue: "" }, transaction: { hash: "TXHASH" } }); }
    throw new Error(`unmocked rpc ${body.method}`);
  };
}

const baseBindings = (extra: Record<string, string> = {}) => ({
  NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: "escrow.testnet", INTENTS_CONTRACT_ID: "intents.testnet",
  KEEPER_ACCOUNT_ID: "keeper.testnet", KEEPER_PRIVATE_KEY: KEY, KEEPER_RPC_PER_SEC: "1000",
  TELEGRAM_BOT_TOKEN: "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOK", KEEPER_ALERT_TELEGRAM_CHAT_ID: "42", ...extra,
});

export async function startMf(script: string, w: Mock, persist: string, extra: Record<string, string> = {}) {
  return new Miniflare({
    modules: true, script, compatibilityDate: "2026-01-01",
    durableObjects: { KEEPER: { className: "KeeperDO", useSQLite: true } },
    durableObjectsPersist: persist,
    bindings: baseBindings(extra),
    outboundService: outbound(w),
  });
}

