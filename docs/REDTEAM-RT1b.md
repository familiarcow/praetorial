# RT1b — red-team of the escrow contract after the judge-chain work

Scope: `contracts/escrow/src/lib.rs` at main `6837b00` (post JC1/JC1x/JCB1/JCD1/JCD2/AS1/CAP3). Contract only; no mainnet/testnet/NEAR AI.
Tests: `contracts/escrow/src/rt1b.rs` (41 tests, registered in `tests.rs`). Each test is one attack; a pass pins a refusal.

**Result: no CRITICAL finding, no OPEN-red test.** No attack paid a wrong party, stranded funds, created/destroyed value, or let the guardian change a live bet's outcome. Two report-only residuals (R1, R2) and one Low observation (RT1b-3).

> **Superseded in part by SECREV1 SR-C1/SR-C2 (High)** (`docs/LIMITS.md`): no attack pays a stake to the wrong party, but a party can force a VOID refund and so take the winner's winnings away (SR-C1: using up the 3 paid runs early; SR-C2: bets without stored terms, where a challenger can also lose their bond).

## Attacks

| id | attack | result | test(s) | sev | money at risk |
|---|---|---|---|---|---|
| RT1b-1a | retire a model + walk to a friendlier pair inside ONE result (3 obs of one model) | refuted: one obs per model per result | `rt1b_a1_one_result_cannot_retire_a_model_three_observations_of_one_model_refused` | – | no |
| RT1b-1b | one result observing both models of pair 0, claim pair 1 | refuted: 1 obs each is not retirement; refusal is a no-op | `rt1b_a1_one_result_observing_both_models_of_pair0_does_not_unlock_pair1` | – | no |
| RT1b-1c | 3 results <24h apart | refuted: only observations >=24h after the last kept one count | `rt1b_a1_observations_less_than_24h_apart_do_not_accumulate_across_results` | – | no |
| RT1b-1d | speed record: how fast can 3 results retire a model | accepted by design at **47h**, not 48h (see RT1b-3); 46h59m59s refused | `rt1b_a1_minimum_time_to_retire_is_47h_over_three_results_not_less` | Low | no |
| RT1b-1e | future / stale observation timestamps to shortcut spacing | refuted (future; >1h old) | `rt1b_a1_future_or_stale_observation_cannot_shortcut_spacing` | – | no |
| RT1b-1f | provider blip (2 x 404 then success) leaves residue | refuted: clean success clears a non-retired model | `rt1b_a1_provider_blip_two_404s_then_a_success_resets_and_three_more_are_needed` | – | no |
| RT1b-1g | claim pair 1 with no observations / claim a retired pair 0 | refuted both ways | `rt1b_a1_a_resolver_cannot_claim_retirement_without_observations` | – | no |
| RT1b-1h | `no_live_judge` while a pair is live (with in-result observations) | refuted | `rt1b_a1_no_live_judge_refused_while_any_pair_is_live_even_with_in_result_observations` | – | no |
| RT1b-2a | loop paid runs via `RETRY:no_live_judge` (no `runs_used` bump), `next_check_ns = now+1` | refuted: JCB1 12h floor holds over 4 cycles; runs_used/retry_count/first_unavailable/used_run_nos untouched | `rt1b_b2_no_live_judge_cycles_do_not_bump_runs_used_and_request_gate_holds_12h` | – | no |
| RT1b-2b | no_live loop to keep a bet from `resolve_deadline` refund | refuted: 48h-horizon loop to the deadline, then `void_after_deadline` pays back exactly deposits | `rt1b_b4_a_no_live_loop_cannot_keep_a_bet_from_the_deadline_void_and_it_conserves` | – | no |
| RT1b-3a | replay an old signed no_live result (run_no not in `used_run_nos`) | refuted by strict `next_expected_run_no`, also after a fresh request; in-flight request untouched | `rt1b_b3_replay_of_an_old_signed_no_live_result_is_refused_strict_run_order` | – | no |
| RT1b-3b | no_live for a future run_no during an in-flight request | refuted | `rt1b_b5_no_live_judge_while_a_request_is_in_flight_for_a_different_run_no_is_refused` | – | no |
| RT1b-4 | signature replay across pair indexes; strip/inject observations; cross-bet; cross-run | refuted: pair index, observation list, bet_id, run_no are all signed | `rt1b_c1_signature_is_bound_to_judge_pair_index_and_observation_list`, `rt1b_c2_signature_for_one_bet_or_run_does_not_replay_on_another` | – | no |
| RT1b-5a | pending guardian acts before accept; old guardian after accept | refuted: pending has no power; old guardian keeps all power until accept and none after (11 methods checked) | `rt1b_d1_…`, `rt1b_d2_…` | – | no |
| RT1b-5b | rotation races: replace pending, cancel then accept, double cancel, double accept | refuted | `rt1b_d3_rotation_cancel_races_replace_and_stale_accept_are_refused` | – | no |
| RT1b-5c | proposals left pending by the old guardian | pinned: survive rotation and are cancellable by the new guardian | `rt1b_d2_…` | Info | no |
| RT1b-6a | chain append to sway a live bet while pair 0 is live | refuted: append goes to the END, claiming the new pair is refused; 7d delay; cancel+re-propose restarts the clock | `rt1b_d4_…`, `rt1b_d5_…` | – | no |
| RT1b-6b | params timing: apply early; change touches a live bet's fee copies | refuted | `rt1b_d6_params_change_never_touches_a_live_bets_fee_and_cannot_apply_early` | – | no |
| RT1b-7 | B2 snapshot: used for a different run_no, or after its run ended; pair applied between request and submit | refuted | `rt1b_i1_…`, `rt1b_i2_…` | – | no |
| RT1b-8a | shutdown races: submit / apply pair / apply asset / finalize / void / concede after shutdown; refund of a Resolving bet; double refund | refuted; refund == deposits exactly | `rt1b_e1_…` | – | no |
| RT1b-8b | pause freezes resolution; unpause after shutdown; proposal pre-dating a pause | pause does not block submit; unpause refused after shutdown; pre-pause proposal still applies | `rt1b_e2_…`, `rt1b_e3_…` | – | no |
| RT1b-9a | guardian disables an asset mid-bet to block challenge/finalize | refuted: bond in the disabled asset accepted, finalize conserves, limits unchanged | `rt1b_f1_…` | – | no |
| RT1b-9b | re-enable used to change limits | refuted: limits must equal stored; 24h delay | `rt1b_f2_…` | – | no |
| RT1b-10a | tip/fee/storage under every ending, cross-asset human referee (YES, NO, VOID, concede x2, deadline void, emergency) | I-2 holds per asset, referee paid only `referee_tip` lines | `rt1b_g1_cross_asset_human_tips_conserve_*` (7) | – | no |
| RT1b-10b | AI bet with bond + objection under concede / emergency / finalize | I-2 holds incl. bond and objection | `rt1b_g2_ai_bet_bond_and_objection_conserve_on_*` (3) | – | no |
| RT1b-10c | challenged bet past `resolve_deadline` (strand bond?) | `void_after_deadline` refused ("use finalize"); `finalize` releases stake, storage and bond | `rt1b_g3_…` | – | no |
| RT1b-11a | stale `pending_resolution_request` after a verdict; late failed `on_resolution` rolls status back | refuted (status Proposed / Challenged kept; replayed callback no-op) | `rt1b_h1_…`, `rt1b_h2_…` | – | no |
| RT1b-11b | concede while Resolving, then late result / callback | refuted: no second payout | `rt1b_i3_…` | – | no |

## Residual risks (report-only; not changed)

- **RT1b-3 (Low) — 47h not 48h.** Observations may be backdated 1h (`OBSERVATION_MAX_AGE_NS`), so 3 results can retire a model across 47h of results. Never <3 results, never <47h. Not fixed: shrinking the freshness window is a resolver-protocol change.
- **R1 — the signer is trusted for retirement claims.** The contract bounds spacing but cannot verify a 404. A captured signer could retire pairs 0..k (any in-chain model, 3 results over 47h) and so pick which pair judges a live bet. This grants nothing beyond what the same signer already has by signing any outcome directly, so it is not an added trust assumption; only the TEE attestation and pinned wasm hash protect it.
- **R2 — guardian + resolver collusion.** A guardian-appended pair only matters once earlier pairs are retired (needs the signer, R1) and is visible 7 days ahead via `judge_pair_proposed`. Live bets have no exit other than `concede`.
- **Design note.** Unsolicited RETRY results (no request) consume `runs_used`; once `runs_used >= max_paid_runs` a challenged bet becomes finalizable without a ruling. This is the existing "no ruling can ever happen" rule, reachable only with the signer key.
- Test-harness note: the near-sdk mock storage outlives a `Contract` value, so per-ending tests are separate `#[test]`s.
