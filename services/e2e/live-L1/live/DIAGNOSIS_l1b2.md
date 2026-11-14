# L1b2 diagnosis: no resolver output on the Jason one-venue NO sheet (bets 2, 4)

Status: NOT reproduced offline; root cause SUSPECTED, not confirmed. No resolver code changed.

## Ruled out (evidence)
- Input shape: terms_jason_bitstamp_only_no.json differs from terms_jason_same_bucket_yes.json (bet 1, worked) ONLY in the
  threshold (75951 vs 75948: claim, element q, one custom_definition). Both are 4223 bytes; request input_len 9628 vs 9627/9634.
  Same wasm hash, same limits (128 MB, 500e9 instr, 150 s), same venues/sources. So no size/shape/field difference.
- Native resolver on the live sheet: new test `item_l1c_tests::l1b2_live_one_venue_no_sheet_yields_outcome` (live terms JSON,
  recorded candles, judge not_met, now=1794065826) returns NO, no panic. The L1a example `jason_bitstamp_only_no` and all l1c
  tests pass. So price_condition_gate / price_required_venues are not the cause: no unwrap/index/loop issue on one-venue data
  (the only unwrap, `common.iter().next().unwrap()`, is guarded by code_met=true).
- Gate code runs AFTER the judge, at the very end; a gate disagreement yields a signed VOID, never "no output".

## Observed live
- OutLayer: `Execution promise failed: Failed. Refunded ...`, only the 1e21 base fee, output null, and (unlike bets 1/3, which
  report `Resources: {instructions, time_ms}`) NO resource line: the worker never returned a completed execution. Bets 1/3 took
  55.7 s / 51.3 s wall for what is mostly model-call latency (instructions only 2.4e8).
- Direct `outlayer run` is capped at 10 s so manual attempts 4-9 timing out tells us nothing.

## Suspected cause (unconfirmed): wall-clock budget, via the two-model agreement rerun
`run_models_agreed` (main.rs ~801) makes 2 model calls, and on disagreement `two_model_agree` calls `rerun` = 2 MORE calls
(sequential). Bet 1 (clear YES) needs 2 calls ~= 55 s. A NO under "burden of proof is on YES" is the case where the two judges are
likelier to differ (e.g. one says insufficient/not_met), triggering the rerun: ~4 calls ~= 110 s+ plus fetches; with model-latency
variance this can exceed the 150 s max_execution_seconds, which OutLayer reports as a bare "Failed" with no output. This also fits
"fails on both bets 2 and 4 (same sheet), works on 1 and 3 (clear verdicts)". The tests cannot see this: the native harness uses
an instant canned judge.

## How to confirm / next steps (all need live or model access, so out of scope for this offline item)
1. Run the SAME wasm via OutLayer with a larger max_execution_seconds (or time it) and log per-model-call latency/ rerun flag
   (add a `notes` line / stderr timing around run_models_agreed).
2. If confirmed, fix = a wall-clock budget in the resolver: skip the rerun / return VOID(unavailable, retryable) when elapsed
   would exceed ~120 s, so a result is always emitted instead of a platform kill. Needs RED test with a ModelCaller that sleeps
   (fake clock) and a disagreeing pair -> expect a signed result under budget. That is a resolver change => new release record.
3. Alternative to check: the real judge returning output that makes the wasm trap (panic=abort) - would be visible only with the
   real judge's raw reply for this sheet; capture it with a local run against the NEAR AI judge (not allowed in this item).
