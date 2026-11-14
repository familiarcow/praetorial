import json
raw = json.load(open("raw_resolution.txt"))
r = json.load(open("results.json"))
d = raw["judge"]["run_diagnostics"]
r["summary"] = {
  "escrow": "praetorial-r3e-11062012.praetorial-dev-1101.testnet",
  "escrow_wasm_deployed_sha256_stripped": "f50742358b404ccc7b9a80f9da86e5cd7591e32ccf7371f9e970fbe94ad0b9ed",
  "escrow_wasm_plain_sha256": "d8d2a87016b37fec7f4ac2fcc63a6990da37eb2e686feeccb24e88e05183717b",
  "escrow_wasm_note": "deployed the CARGO_PROFILE_RELEASE_STRIP=symbols build (516 KB) of the same source to fit storage; plain build (889 KB) reproduces d8d2a870",
  "resolver_wasm_sha256": "0b3f9f080b0088990d50ba5c7501d0549b504be20c4bfb9790bf91da9318ba74",
  "upload_txs": ["F75dxRb8mVB5mBHPw7zCrrPc1JvhH5Ur9p349YkksdQH", "DqpJuwUX2JGXmYs9CJrRPWyrYim63r8naYs3zasV5zCc", "HnLioncxLvb9FX4LB3RjRZoGGyebt8Qa4nrWb1pAoqd3"],
  "report_pubkey_outcome_tx": "74Z5pDnVZznxCetjzS3PBWTTjoU1RazT7eo2rQMprvac (attempts 1-2 timed out client-side)",
  "report_pubkey_attest_tx": "AeMBKrM9P4vuL12AWQbn6pMCKbZWRs9LrTq6HWLtDvpC",
  "bet_id": 1, "request_resolution_tx": "Cc9de2MwGHthBaMoBpSRN1yNoty5WfQJhRvRa6Ao5Quq",
  "request_resolution_first_attempt": "tx 23khKvNVWRQ7Q2zFakEXfAPftqbrSrooWZkg2f6pHrNq trapped (unreachable) because called before funding_deadline (open+150s); contract require-failure surfaces as wasm trap in this build; no OutLayer job created, no credit spent",
  "outlayer_request_id": 11333, "outlayer_jobs": 1, "near_ai_calls": 2,
  "outcome": "YES", "judge_backend": raw["judge"]["judge_backend"], "elements": raw["judge"]["elements"],
  "models": [{k: x[k] for k in ("model","http_status","error_body_head","first_byte_ms","total_ms","idle_timeout_hit","total_timeout_hit","signature_verified","finish_reason","verify_result","response_bytes","content_head")} for x in d],
  "submit_outcome_tx": "6MDRMMho5N18xGHFAH1nVrzzjUXe7SWEHL343mbPv3r4", "status_after_submit": "Proposed YES",
  "finalize_not_before_utc": "2026-11-07T02:29:20Z (21:29:20 ET)",
  "signing_pubkey": raw["signing"]["pubkey_hex"], "notes": raw["notes"],
}
json.dump(r, open("results.json", "w"), indent=1)
print(json.dumps(r["summary"]["models"], indent=1)[:1500])
