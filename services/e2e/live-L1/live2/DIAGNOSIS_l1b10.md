# L1b10 — verifier B3 "run_no 1 out of order (expected 2)" on live2 bet 1

Escrow `praetorial-l1b5-11071226.praetorial-dev-1101.testnet`, bet 1. Read-only views / indexer only (`v_l1b10.mjs`; no keys, no txs).

## Verdict
- **Escrow: correct.** **Resolver: correct.** **Verifier: B3 false FAIL**, from the same signed result being counted twice (indexer receipt delivered twice). Fixed in `services/verifier/src/live.ts` (dedupe by `receipt_id`). Escrow and resolver code and wasm unchanged (no release record needed).
- **B4: correct detection, separate from B3.** Unchanged; regression test added.

## On-chain evidence (bet 1, `get_bet` view)
`status Proposed, outcome VOID, runs_used 1, used_run_nos [1], next_expected_run_no 2, next_run_no 2, pending_run_no null, max_paid_runs 2`.
- The escrow's whole tx history has exactly ONE `request_resolution` for bet 1 (request_id 5, tx 9jAeCBxW…) and ONE `submit_outcome` for bet 1 (tx 6HZKRKjm…, result run_no 1, VOID). Bet 2's submit (run_no 1, YES) and bet 3's requests (ids 1,2,4; no result, no run consumed) are other bets.
- Escrow run numbering: `request_resolution` assigns `run_no = max(next_run_no, next_expected_run_no)` (=1 for a fresh bet), puts it in the job input and in `pending_run_no`; `submit_outcome` requires `result.run_no == next_expected_run_no` (and == pending) then sets `runs_used += 1`, `next_expected_run_no = run_no + 1`. So runs_used is incremented on accept (0 -> 1) and the accepted run_no is runs_used-after (1-based). Stored `next_expected_run_no 2` is the NEXT run, not the one submitted.
- Resolver signs the `run_no` it was handed in the job input from the escrow (signed result: run_no 1); consistent with the above. The README's "run consumed by an earlier attempt" guess is wrong: earlier attempts were on bet 3, and failed runs consume nothing (D-RESOLVE4a).

## Verifier
`checkB3` starts `expectRun = 1` and advances to `run_no + 1` per submitted result. "expected 2" therefore requires two entries with run_no 1 in `ev.submitted` — i.e. the same signed result twice. `mapHistory` appended one entry per `submit_outcome` FunctionCall in every receipt returned by the indexer, with no receipt de-duplication. Re-running `verify-bet` live today on the same bet gives `PASS B3 1 submitted result(s) ... run_no order 1..1`, so the duplicate was a transient indexer delivery at the time (taken right after the submit). I could not reproduce the duplicate itself; the inference is from the arithmetic of B3 + the single on-chain submit. Fix: `fetchEscrowHistory` keeps one entry per `receipt_id`. A real replay is a different tx/receipt and still FAILs.

## B4
Bet 1 was a too-early request (T+1:27 < T+5min). The pre-a646d02 resolver refused it (`REQ_BEFORE_T_PLUS_5MIN`, `judge_ran=false`, zero elements) but still signed VOID. The terms' rule over zero verdicts = NO, so B4 flags "decision rule gives NO, signed VOID". That is the D-EARLYREQ1 bug seen from the verifier (a signed outcome unsupported by any judge work); the resolver side was fixed by a646d02 (no signed outcome for an early request). B4 is left strict.

## Tests (services/verifier/test)
- live.test.ts: duplicate receipt -> B3 PASS (RED before fix); second distinct tx with run_no 1 -> B3 FAIL (guard).
- b4.test.ts: live2 bet 1 recorded raw + terms -> B4 FAIL stays.
