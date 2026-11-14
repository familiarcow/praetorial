// RFRZ2 live proof: btc_touch sourcecheck through the deployed Worker, 30-day and 4-hour windows (D-SRCCHK3).
// Verifies each signature under the NEW escrow's pinned attest key (resolver_keys[1]). Never prints keys.
import fs from "node:fs";
import { resolveRpcUrls } from "../../common/src/rpc.ts";
import { verifySourceCheckAttestationPinned } from "../../common/src/sourceCheck.ts";
const URL_ = "https://praetorial-sourcecheck-testnet.familiarcow.workers.dev/sourcecheck";
const ESC = fs.readFileSync(new URL("./escrow_name.txt", import.meta.url), "utf8").trim();
const rpc = await (await fetch(resolveRpcUrls("testnet").primary, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: ESC, method_name: "resolver_keys", args_base64: Buffer.from("{}").toString("base64") } }) })).json();
const keys = JSON.parse(Buffer.from(rpc.result.result).toString());
const attestPub = keys[1];
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
const open = new Date(Math.floor(Date.now() / 60000) * 60000);
const out = [];
for (const [name, ms] of [["30d", 30 * 86400e3], ["4h", 4 * 3600e3]]) {
  const sheet = JSON.stringify({ fields: { deadline_utc: iso(new Date(open.getTime() + ms)), direction: "at_or_above", open_utc: iso(open), x_usd: 76000 }, template: { id: "btc_touch", version: 1 } });
  const t0 = Date.now();
  const r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "sourcecheck", terms: sheet }) });
  const text = await r.text();
  let j; try { j = JSON.parse(text.replace(/"checked_at":\s*(\d{16,})/, '"checked_at":"$1"')); } catch { j = { raw: text.slice(0, 300) }; }
  const valid = j.ok === true && verifySourceCheckAttestationPinned({ specHash: j.spec_hash, checkedAt: String(j.checked_at), resolverPubkeyHex: j.signing.pubkey_hex, signatureHex: j.signing.signature_hex }, attestPub);
  const row = { window: name, http: r.status, ok: j.ok, unreachable: j.unreachable, spec_hash: j.spec_hash, checked_at: j.checked_at, signing_pubkey_equals_pinned_attest: j.signing?.pubkey_hex === attestPub, signature_valid_under_pinned_attest_key: valid, secs: Math.round((Date.now() - t0) / 1000), sheet_open: iso(open), error: j.error };
  console.log(JSON.stringify(row)); out.push(row);
}
fs.writeFileSync(new URL("./sourcecheck_live.json", import.meta.url), JSON.stringify({ escrow: ESC, attest_pubkey_pinned: attestPub, results: out }, null, 2));
if (!out.every((x) => x.http === 200 && x.ok === true && x.signature_valid_under_pinned_attest_key)) process.exit(1);
