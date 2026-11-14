# live-run8a: enclave clock skew (item 8a)
Derived from the existing 7g3 run (tx DiTxKVAWamj6MFgMPLDGoerxADVFWQAUDYfPCAwaYJBs); no new run, 0 NEAR spent, wasm unchanged (d6d884a6...82af).
skew = signed `checked_at` - timestamp of block containing the `execution_completed` receipt (result delivery).
Result: see results.json. checked_at lies inside [request block, result block]; skew vs result block ~ -2.17 s => PASS (<= 60 s).
Re-run: `python3 measure_skew.py` (queries testnet RPC).
