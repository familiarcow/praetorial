# RFRZ2 live evidence (testnet only)
- Escrow praetorial-frz2-2611091914.praetorial-dev-1101.testnet, wasm caf134a4 (unchanged), resolver 6517a422 (SRCCHK3 record-b67b3d7). Deploy tx 32XrRrWxfeoNs5M3SEJJt8dmLDF174EfZ9bAqsPXabuH; fund tx 6D9VZnvGLqsG4VrsZ2ZoW87mF22xJynmcHC6qQRPUHaK.
- verify-escrow.txt: E1-E4 PASS. sourcecheck_live.json: btc_touch 30d + 4h ok, signature valid under the pinned attest key.
- Human-mode (referee) bet 1: human_bet_results.json (txs, nearblocks links), Settled YES. final_step_bet1.txt = verify-bet 7 PASS / 0 FAIL / 3 SKIP (B3-B5 skip: Human mode has no resolver run).
- RFRZ2c (AI btc_touch >5h bet + wrap.testnet AI bet) = HOLD until WEBSRC1 is DONE (D-RFRZ2b).
- human_bet.mjs was cut by a tool timeout while waiting for funding_deadline; human_finish.mjs completed it (same bet).
