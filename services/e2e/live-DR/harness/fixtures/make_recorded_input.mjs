// One-off (already run, output committed as recorded_run_input.json): turns the frozen R3e evidence dir into the
// harness recorder's INPUT shape (recorded tx results + get_bet snapshots + balances before/after). Offline, read-only.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const d = join(here, "..", "..", "..", "live-runR3e");
const rd = (f) => readFileSync(join(d, f), "utf8");
const res = JSON.parse(rd("results.json"));
const fin = JSON.parse(rd("results_finalize.json"));
const sc = rd("sourcecheck.log");
const scj = JSON.parse(sc.slice(sc.indexOf("\n{") + 1));
const out = {
  escrow: rd("escrow_name.txt").trim(),
  betId: res.bet_id,
  wasmSha256: res.recreated.wasm_sha256,
  newArgs: res.recreated.new_args,
  views: res.recreated.views,
  termsRaw: rd("terms.json"),
  sourcecheck: { spec_hash: scj.spec_hash, checked_at: sc.match(/"checked_at":\s*(\d+)/)[1], pubkey_hex: scj.signing.pubkey_hex, signature_hex: scj.signing.signature_hex, tx_hash: "9y4XD27M2s8gAKNczioJWaHpLEcwWnuUX7ZDxRFbpjUn" },
  rawResolution: JSON.parse(rd("raw_resolution.txt")),
  bets: { afterRequest: res.bet_after_request, afterSubmit: res.bet_after_submit },
  txs: res.txs,
  finalize: { txs: fin.txs, before: fin.before, after: { ts: fin.after.ts, status: fin.after.status, outcome: fin.after.outcome, balances: fin.after.balances, pending_not_done: fin.after.pending_not_done } },
};
writeFileSync(join(here, "recorded_run_input.json"), JSON.stringify(out, null, 1) + "\n");
