// Replay layer for live-mode tests: serves the RECORDED public RPC / tx-indexer responses
// (fixtures/v1c/r3e_live_rpc.json, produced by fixtures/v1c/record.mjs) through a fetch-compatible function.
// Deterministic and offline: test.sh never touches the network.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ESCROW = "praetorial-r3e-11062012.praetorial-dev-1101.testnet";
export const loadFixture = (): any => JSON.parse(readFileSync(join(here, "fixtures", "v1c", "r3e_live_rpc.json"), "utf8"));

/** L1b14: recorded live3 / live2 evidence (fixtures/l1b14/<name>.json, produced by fixtures/l1b14/record.mjs). */
export const loadL1b14 = (name: "live3_bet2" | "live2_bet1"): any => JSON.parse(readFileSync(join(here, "fixtures", "l1b14", `${name}.json`), "utf8"));

/** Visit every action object (tx level and receipt level) of the fixture's transactions; `edit` returns true when it changed one. */
export function editActions(fx: any, edit: (action: any, txHash: string) => boolean): number {
  let n = 0;
  for (const [h, t] of Object.entries<any>(fx.transactions)) {
    for (const a of t.transaction.actions ?? []) if (edit(a, h)) n++;
    for (const r of t.receipts) for (const a of r.receipt.receipt.Action?.actions ?? []) if (edit(a, h)) n++;
  }
  return n;
}

export interface Replay { fetch: typeof fetch; calls: string[]; }
/** `fx` may be mutated by a test before use (tampering). `fail429` makes the first N requests answer 429. */
export function replayFetch(fx: any, opts: { fail429?: number; pageSize?: number } = {}): Replay {
  let left = opts.fail429 ?? 0;
  const calls: string[] = [];
  const f = async (url: any, init?: any): Promise<Response> => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(u);
    if (left > 0) { left--; return new Response("slow down", { status: 429 }); }
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/v0/account")) {
      const size = opts.pageSize ?? 6;
      const off = body.resume_token ? Number(body.resume_token) : 0;
      const page = fx.accountTxs.slice(off, off + size);
      const next = off + size < fx.accountTxs.length ? String(off + size) : undefined;
      return json({ account_txs: page, ...(next ? { resume_token: next } : {}), txs_count: fx.accountTxs.length });
    }
    if (u.includes("/v0/transactions")) {
      return json({ transactions: (body.tx_hashes as string[]).filter((h) => fx.transactions[h]).map((h) => fx.transactions[h]) });
    }
    const p = body.params;
    const key = `${p.request_type}|${p.method_name ?? ""}|${p.args_base64 ? Buffer.from(p.args_base64, "base64").toString() : ""}`;
    // PA1b: the recorded fixtures predate PA1 (D-PARAMS1). A real node answers a view on a method the deployed wasm lacks with a
    // result-level MethodNotFound error, so an unrecorded PA1 view is served exactly that way (everything else stays UNRECORDED).
    if (!(key in fx.rpc) && ["protocol_fee_bps", "asset_limit", "pending_params"].includes(p.method_name)) {
      return json({ jsonrpc: "2.0", id: body.id, result: { block_hash: "x", block_height: 1, logs: [], error: "wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))" } });
    }
    if (!(key in fx.rpc)) return json({ jsonrpc: "2.0", id: body.id, error: { name: "UNRECORDED", cause: { name: key } } });
    return json({ jsonrpc: "2.0", id: body.id, result: fx.rpc[key] });
  };
  return { fetch: f as typeof fetch, calls };
}

/** Edit the JSON args of the (only) FunctionCall `method` inside every receipt/transaction of the fixture; base64 re-encoded. */
export function editCallArgs(fx: any, method: string, edit: (args: any) => void, only?: (txHash: string) => boolean): number {
  let n = 0;
  const visit = (actions: any[]) => {
    for (const a of actions ?? []) {
      const fc = a.FunctionCall;
      if (fc?.method_name === method) { const args = JSON.parse(Buffer.from(fc.args, "base64").toString()); edit(args); fc.args = Buffer.from(JSON.stringify(args)).toString("base64"); n++; }
    }
  };
  for (const [h, t] of Object.entries<any>(fx.transactions)) {
    if (only && !only(h)) continue;
    visit(t.transaction.actions);
    for (const r of t.receipts) visit(r.receipt.receipt.Action?.actions);
  }
  return n;
}
