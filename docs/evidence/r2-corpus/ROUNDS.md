# Improvement rounds (Addendum 2: max 3). All numbers: production pair D+G, N=1 round-1 outcome unless stated; labels as corrected in `truth/label_fixes.json`.

Starting point (baseline = D-JUDGE4 as specified: lane C thinking on, 8k budget, exact-quote rule, lane A/B audit with thinking off, 1024 tokens). Causes grouped from the baseline run:

| cause | cases | wrong winners | unneeded VOIDs |
|---|---|---|---|
| wording (relative date / missing unit / ambiguous name / unspecified spread or scope) | 62-case wording set | 16 | 3% |
| live-only page used to answer a past moment (inferred from a 7-day range) | 1 | 1 | 0 |
| **my own wrong labels** (page legitimately answers: 2025 Wimbledon x2, BBC page text) | 3 | 3 (not model faults, relabelled with evidence) | 0 |
| edited live page, only the archive snapshot proves the original (out of judge scope) | 3 | 3 | 0 |
| lane A/B audit (thinking off) flags a correct proposal after mis-reading a threshold in its own reason | ~45 | 0 | BTC 15%, B settled 18% |
| quote check rejects a correct answer whose quote was cleaned up (dropped `@` cell, `[65]` marker, PDF hyphen) | 15 rejects of 719 decisive answers | 0 | ~2% |

## Round 1: lane C prompt v2 (strict "claim must be exactly answerable" rules a–f)
Fix = prompt text only. Re-ran wording 62 + live 23 + adversarial 54 + the 30 clean-page sample (172 cases) with the pair.

| segment | v1 pair-agreed WRONG | v2 pair-agreed WRONG | v1 truth-decisive-but-VOID at round 1 | v2 |
|---|---|---|---|---|
| wording | 16 | **4** | 4 | **11** |
| live-only | 0 (1 after re-run) | 0 | 1 | 1 |
| adversarial | 0 | 0 | 1 | 2 |
| clean pages (regression) | 0 | 0 | 2 | 2 |

Verdict: cuts wrong winners but over-VOIDs. Cause: rule (a) demanded an exact date AND time zone, so "bet placed Oct 29, Lakers lose their next game" (decidable) VOIDs; and (f) fired on "Jaguars cover -3.5" where the line is stated.

## Round 2: lane A/B audit with thinking ON, 4096 tokens (models flag far less after reasoning)
Re-ran every previously flagged/disagreeing real case (BTC 40 incl. regression, B settled 17, games 5, wording 3) + all 26 planted-bug proposals + 20 random previously-passing cases.

| segment | baseline (no thinking) unneeded VOID | thinking ON | planted bugs paid |
|---|---|---|---|
| A btc (40: 30 flagged + 10 passing) | 75% | **0%** | – |
| B settled (17) | 65% | **24%** (4/17) | – |
| planted-bug proposals (26) | 26 caught | 26 caught | **0** |
| 20 random previously-passing | pass | pass | – |

Cost: thinking-on audit p50 8.8 s / p95 33 s / $0.0004 per call vs 2.5 s / 5.5 s / ~$0.0002.

**Late finding that changes the recommendation:** the no-thinking audit is also a safety problem. `lane_b_gov_bls_cpiu_nsa_2026_09_gt_99p5__bug` (code proposes not_met for 336.940 > 99.5 with an inverted comparison string) was agreed by DeepSeek 3/3 and glm-5.3-flash 1/3 without thinking, so the retired N=3 pair paid it in 2 of 13 trials; with thinking on both flag it. An "escalate only on disagreement" design would miss exactly this (both agree), so the recommendation is thinking ON for all lane A/B audits, not escalation.

## Round 3: lane C prompt v3 (rule (a) anchored dates OK, time zone only if it changes the answer; (f) only when no line is stated). Same 172 cases.
| segment | v1 WRONG | v2 | **v3** | v1 truth-decisive-but-VOID | v2 | **v3** |
|---|---|---|---|---|---|---|
| wording | 16 | 4 | **6** (7 after N=3 re-runs) | 4 | 11 | **5** |
| live-only | 0 | 0 | **0** | 1 | 1 | 1 |
| adversarial | 0 | 0 | **0** | 1 | 2 | 1 |
| clean pages | 0 | 0 | **0** | 2 | 2 | 1 |
| edited-live (out of judge) | 3 | 3 | 2 (1 VOIDed on disagreement) | | | |

After the adaptive N=3 re-run (39 flagged cases): wording 7 wrong, 6% unneeded VOID; adversarial 0/0; clean 0 wrong, 3% unneeded VOID (quote reject on a PDF hyphen); live-only 0/0.

## Stop condition
Round 3 reached. **Not met**: the pair still pays 7 wrong winners on the imperfect-wording set and 2–3 on the edited-live-page set. Both are outside what a prompt can fix (see README "What is left"). Judge-scope sets (clean, adversarial, live-only, lane A, lane B, planted bugs): **0 wrong**.

## Offline fix (no API): quote rule
`quote_rescore.py` re-scores all 1,274 stored decisive lane-C answers. The exact rule rejects 31 (2.4%); an alphanumeric-only substring rule (strip `[12]`-style markers, `&amp;`, punctuation, case, whitespace) recovers 26 of 31 and cannot accept a quote that is not on the page; the 5 left are multi-row quotes stitched with "…". See `results/quote_rescore.json`.
