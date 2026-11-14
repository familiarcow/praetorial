import json
r = json.load(open("results_sources.json"))
H = "f9adbe6f631ea7e13cf77f651c8a8fff0c0a8876c5f3f9a0f44e72f7e383e5a2"
res = {
 "item": "17a tee-source-probes",
 "network": "testnet",
 "probe_wasm_sha256": H,
 "probe_wasm_bytes": 2888764,
 "build": {"commit": "261bdd2", "features": "probe-sources (real-http; NOT outlayer-sign)", "reproducible": "2 builds (docker run, fresh container) byte-identical"},
 "fastfs_url": f"https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet/{H}.wasm",
 "runs": 1,
 "run_note": "All 66 fetches fit one run (24.97 s in-wasm, 29.5 s wall, 1.05e9 instructions, 15,783 byte output). OutLayer's default on-chain limit is 10 s, so resource_limits (max_execution_seconds=90, max_instructions=5e9) were set via direct request_execution (run_probe.mjs); the outlayer CLI 'run' cannot raise the time limit.",
 "txs": [
  {"step": "upload_chunk1", "hash": "3ck8oqeR9MwwguViMx7B9Si2PNWS6c9KgF2wXeyyyEPr"},
  {"step": "upload_chunk2", "hash": "8gw6LLTvmGHb1SrDY8CqyTvGnGKwPb7LPD6VUmkSXwjs"},
  {"step": "upload_chunk3", "hash": "EyrcysaUYxjhjwroQF7wn3sZP2mVkwTmoUcJNYMCd42Z"},
  {"step": "cli_run_default_limits_timed_out_10s", "hash": "HJ5tvcFoyYd6FHwELdHyvGLLGnaXnd9QngXiVfvgYePL", "charged_yNEAR": "2000100000000000000000"},
  {"step": "cli_run_default_limits_rpc_timeout", "hash": "unknown (CLI aborted on RPC timeout before printing; likely also charged ~0.002 tNEAR)"},
  {"step": "request_execution_probe_all", "hash": "G9qGXUEjzKZvYsZXXcvNCDmRgwDATVyt6ftXatXm1rFa", "charged_yNEAR": "3950404500000000000000", "refunded_yNEAR": "26049595500000000000000", "success": True}
 ],
 "spend": {"dev_balance_before_tNEAR": 5.8781, "dev_balance_after_tNEAR": 5.8533, "net_tNEAR": 0.0248, "outlayer_payment_tNEAR": 0.00795, "note": "net includes FastFS upload gas and 2 wasted default-limit CLI attempts; no top-up used"},
 "safety": {"signed": r["probe_output"]["signed"], "near_ai_calls": r["probe_output"]["near_ai_calls"]},
 "probe_output_bytes": 15783,
 "now_unix": r["probe_output"]["now_unix"],
 "sources": r["sources"],
}
json.dump(res, open("results.json", "w"), indent=1)
print(len(res["sources"]))
