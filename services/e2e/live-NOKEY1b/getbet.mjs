// NOKEY1b: read-only get_bet of frz3 bet 1 -> judge summary (never prints keys).
import fs from "node:fs";
import { resolveRpcUrls } from "../../common/src/rpc.ts";
const ESC = fs.readFileSync(new URL("./escrow_name.txt", import.meta.url), "utf8").trim();
const r = await (await fetch(resolveRpcUrls("testnet").primary, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: ESC, method_name: "get_bet", args_base64: Buffer.from(JSON.stringify({ bet_id: Number(process.argv[2] ?? 1) })).toString("base64") } }) })).json();
const b = JSON.parse(Buffer.from(r.result.result).toString());
console.log("status", b.status, "outcome", b.outcome);
if (b.last_resolution_raw) {
  fs.writeFileSync(new URL("./bet1_last_resolution_raw.json", import.meta.url), b.last_resolution_raw);
  const j = JSON.parse(b.last_resolution_raw), jb = j.judge ?? {};
  console.log("judge_backend", jb.judge_backend, "reason", jb.judge_backend_reason, "http", JSON.stringify((jb.run_diagnostics ?? []).map((d) => d.http_status)), "keys", Object.keys(j).join(","));
  console.log("credit-hit", JSON.stringify(jb.run_diagnostics ?? []).match(/402|insufficient|credit|quota|limit exceeded/i)?.[0] ?? null);
}
