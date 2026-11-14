# L1b13: why the Jason one-venue NO sheet gave no OutLayer output after ~120-126 s

## Result
Root cause CONFIRMED on the resolver side (not a stall): the judge itself is slow on this sheet. The two sequential
model calls (DeepSeek-V4.1-Flash, then GLM-5.3-flash, ~12.6 KB prompt, thinking ON, 170 KB / 124 KB SSE streams) take
40-90 s EACH. Fetches are ~1 s. The pair alone reaches 88-127 s; D-BUDGET1 only guards the *rerun*, so nothing stops a first
pair that already runs into the platform kill (~120-126 s after request, bare "Failed", no output).

The "one stalled stream = 2 x 60 s idle" hypothesis is NOT supported: max idle gap between SSE chunks was 0.5-0.6 s in every run.

## Native runs (real NEAR AI, same prompts/models/params, curl transport; probe = `src/item_l1b13_probe.rs`, `L1B13_LIVE=1`)
Fetch (all runs): Coinbase 149 ms, Bitstamp 663 ms, Kraken 245 ms.

| run | sheet | DeepSeek call | GLM call | total | outcome | note |
|---|---|---|---|---|---|---|
| 1 | Jason NO | 46.6 s (698 chunks, TTFB 0.64 s, max gap 0.53 s) | 40.5 s (584 chunks, TTFB 1.4 s, max gap 0.59 s) | 88.2 s | NO | alone |
| 2 | Jason NO | 88.4 s | 38.0 s | 127.3 s | NO | 3 runs concurrent |
| 3 | Jason NO | 56.4 s | 61.6 s | 119.0 s | NO | 3 runs concurrent |
| ctl | live2 BTC breaks (messy) | 25.2 s | 23.5 s | 49.7 s | YES | concurrent |

All calls finished with finish_reason=stop and a valid signature; no HTTP errors, no 402/quota messages. Native totals of
119-127 s match the observed on-chain 120-126 s kills. (Runs 2-3 were concurrent with each other and the control, so they
are slower than run 1; the wasm on OutLayer also adds TEE/host overhead. The spread 88-127 s is the finding: it straddles
the platform limit.) The control being 25 s/call natively vs 7 s in the wasm (D-BUDGET1 calls_ms) shows native timing is
the more pessimistic of the two; the Jason prompt's per-call time still dwarfs the control's.

NEAR AI calls made by this item: 8 streamed completions (4 runs x 2 models), 0 errors.

## OutLayer limit
The escrow requests `max_execution_seconds` 150 for tier 1 (`live3/*.log`: `"max_execution_seconds":150`; tier 0 = 120 s).
OutLayer source is not vendored locally; `spikes/r1-stream/README.md` (worker `wasi_p2.rs:753`) says the guest is wrapped in a
wall-clock `timeout(max_execution_seconds + 2)`. The observed kills at 120-126 s are therefore NOT explained by the
requested 150 s; whether the platform applies a lower effective cap (the R1 spike ran with a 120 s limit) is UNCONFIRMED.
Either way the fix below keeps the resolver finishing well under 120 s.

## Fix (L1b13)
Every model stream (including the retry attempt) is capped by what is left of a 100 s model deadline
(`budget::MODEL_DEADLINE_NS`); no stream is opened with < 5 s left. A call cut short or refused gives no usable verdict ->
existing fail-safe: signed VOID (never YES/NO). The run therefore emits a signed result before ~100 s + sign/print time.
Consequence to be aware of: on this sheet a slow judge now gives a signed VOID (refund) instead of a platform kill.

## Open design question (not decided here)
The Jason sheet's judge time (40-90 s per model) makes the two-model, sequential panel unreliable inside 100 s. Options:
1. Accept VOID-on-slow (this fix) and retry later via the escrow. Cheap; the bet may VOID repeatedly.
2. Shorten the judge workload for sheets the code can fully decide (code-checked reader result + model only audits, as lanes A/B), cutting the 12.6 KB prompt.
3. Run the second model only when the first returns a non-NO/non-final verdict, or cap thinking per model.
Recommendation: 2 (the one-venue NO sheet is fully decidable from the fetched candles), after familiarcow confirms; this is a prompt/pipeline redesign and was out of scope.

## L1b15 (2026-11-07): D-JUDGETIME1 (A) — a judge cut by the model deadline emits NO signed outcome

Ruling reverses the L1b13 "capped call -> signed VOID" rule. Changes (commits RED 2d94304, GREEN fbbfa52):
- `model_capped` is now set only when a stream was actually CUT by the shortened limit (stall/total timeout, truncated) or the call was REFUSED (<5 s left). A call that merely received a shortened limit and finished with a usable verdict is normal.
- No usable pair verdict + `model_capped` -> `run_models_agreed` returns `budget_skip` (the D-BUDGET1 / D-EARLYREQ1 clean no-output exit); `budget::report` logs `D-JUDGETIME1: model deadline, no outcome`. A disagreeing first pair whose rerun was cut by the deadline also exits with no output. OutLayer then reports null output; the escrow counts a failed run (D-RESOLVE4a, bet back to Taken, retry allowed); the retry cap / `void_after_deadline` remains the backstop.
- Two complete (uncapped) disagreeing verdicts keep the existing rule (rerun, then signed VOID).
- 100 s cap and 5 s minimum unchanged. Part B (short audit prompt) is L1b16, not done here.
- L1b13 tests `a_silent_first_stream_...` and `two_70s_models_...` asserted capped -> signed VOID; changed by ruling to assert no signed outcome (spec change, not weakening). New `item_l1b15_tests.rs` (6 tests).
- Reproducible wasm sha256 `691cd1a2e7ced17185188e75adea79b1ea50d26cac094260ac11ed778d02b764` (`resolver/release/record-fbbfa52.json`); not uploaded.

## L1b16 (2026-11-07, D-JUDGETIME1 B) -- status: code on branch feat/l1b16, NOT merged
- `build_submission_inner` now routes a custom price sheet that `price_condition_gate`'s decision (new `price_gate_decision`) fully decides (tolerance + threshold, all named venues complete and gap-free, one element, reading defined) through the typed-lane audit (`audit_gate` / `template_audit`): ONE model call, prompt = rule + code result + candle facts. agree -> code result; flag -> one re-run -> VOID "audit disagreed". Cut call -> no signed outcome (D-JUDGETIME1 A).
- Jason live3 sheet prompt: 14955 B (full judge, 2 sequential models) -> short audit prompt < 3 KB (1 model call). Live NEAR AI timing NOT measured (no NEAR_AI_API_KEY in this environment).
- BLOCKED on 10 existing tests that replay a verdict-shaped mock judge reply for gate-decided sheets (they encode the old full-judge behaviour): item_l1a l1a_examples_expected_equals_actual, item_l1c (3), item_l1b9 (1), item16h d_resolve6b_fine_evidence..., item16e2 d_resolve6_c_day3_touch..., item_l1b13 fast_models_are_unaffected..., item_l1b15 (2). Not edited, per the TEST POLICY; PM decision needed.
