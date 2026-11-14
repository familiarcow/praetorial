# RTE2 — false-retraction flake rate (2026-11-09)
Case: mk_false_retraction_of_higher_tier_from_lower_tier (expect YES).
- Harness (claude:haiku, _resolve runs=1) x20: 20 YES / 0 NO (harness_haiku_before.json, harness_20x.py).
- Production dual-judge (DeepSeek-V4.1-Flash + GLM-5.3-flash, Rust prompt path, consensus; ../production_pair_20261109_rte2_before.json): 20 agree-correct, 0 agree-WRONG, 0 disagree/retry. Spend $0.1751 (this run).
- Also: full ./test.sh fast after measuring: redteam_evidence PASS (the RCFG1 flake, 2/3 failures, did not reproduce).
Conclusion: no production wrong-outcome agreement -> no resolver fix (wasm unchanged). Harness flake not reproduced in 20+1 runs, so no test change (nothing weakened; majority-of-3 not added without evidence).
Note: nearai_spend.jsonl is cumulative (was $9.54 > default NEAR_SPEND_CAP_USD=5, which made the harness abort silently with 0 runs); measured with NEAR_SPEND_CAP_USD=19.5.
