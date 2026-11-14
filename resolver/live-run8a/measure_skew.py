#!/usr/bin/env python3
"""8a: enclave WASI clock vs chain time, from the 7g3 run (no new spend).
skew = checked_at - block timestamp of the receipt that delivered the result."""
import json, urllib.request, os
RPC = "https://rpc.testnet.fastnear.com"
TX, SIGNER = "DiTxKVAWamj6MFgMPLDGoerxADVFWQAUDYfPCAwaYJBs", "praetorial-dev-1101.testnet"
HERE = os.path.dirname(os.path.abspath(__file__))
def rpc(m, p):
    r = urllib.request.Request(RPC, json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(), {"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(r, timeout=30))["result"]
bt = lambda h: int(rpc("block", {"block_id": h})["header"]["timestamp"])
rec = json.load(open(os.path.join(HERE, "../live-run7g3/attest_record.json")))
checked_at = rec["output"]["checked_at"]
res = rpc("EXPERIMENTAL_tx_status", [TX, SIGNER])
req = bt(res["transaction_outcome"]["block_hash"])
# result-delivering receipt: outlayer.testnet receipt whose logs contain execution_completed
done = [o for o in res["receipts_outcome"] if any("execution_completed" in l for l in o["outcome"]["logs"])][0]
resb = bt(done["block_hash"])
st = rpc("status", [])["sync_info"]
lo, hi = req, resb
within = lo - 60e9 <= checked_at <= hi + 60e9
out = {"tx": TX, "wasm_sha256": rec["wasm_sha256"], "checked_at_ns": checked_at,
  "checked_at_utc_ns_rounding": "rounded to 2^12 ns",
  "request_block_ts_ns": req, "result_receipt": done["id"], "result_block_ts_ns": resb,
  "skew_vs_result_block_s": (checked_at - resb) / 1e9,
  "skew_vs_request_block_s": (checked_at - req) / 1e9,
  "outside_window_s": 0.0 if lo <= checked_at <= hi else min(abs(checked_at-lo), abs(checked_at-hi))/1e9,
  "rpc_latest_block": [st["latest_block_height"], st["latest_block_time"]],
  "verdict": "PASS" if abs(checked_at - resb) <= 60e9 and within else "FAIL"}
json.dump(out, open(os.path.join(HERE, "results.json"), "w"), indent=1)
print(json.dumps(out, indent=1))
