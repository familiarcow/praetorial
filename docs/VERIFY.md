# Verifying a Praetorial bet (verify kit, D-VERIFY1)

Read-only by default: public NEAR RPC views, a public tx indexer, FastFS, NEAR AI's public attestation endpoint (live B4) and recorded run files. No keys, no transactions, except live E4 (without `--offline`), which runs the program on OutLayer from CLI accounts you log in and spends OutLayer credit.

## The mainnet deployment (what to verify)

| What | Value | Check |
|---|---|---|
| Escrow | `bets.praetorial.near` | https://nearblocks.io/address/bets.praetorial.near |
| Deploy + `new()` | tx `9gFoypqaFzHEnUmkecG6NarvzoH8fdg8Bn2TPfy34NpX` (2026-11-11 01:55 UTC) | https://nearblocks.io/txns/9gFoypqaFzHEnUmkecG6NarvzoH8fdg8Bn2TPfy34NpX |
| Last key deleted (locked) | tx `ACkj5srVv2nav4iUuszyefkEGtonjQJVfusbRAS36UT3` (01:57 UTC); `view_access_key_list` = `[]` | https://nearblocks.io/txns/ACkj5srVv2nav4iUuszyefkEGtonjQJVfusbRAS36UT3 |
| Escrow code (E1) | sha256 `caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f` = base58 `EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q` | `contracts/escrow/release/record-84f23c8.json` |
| `new()` args (E2) | `release/mainnet-night/args.mainnet.json`, sha256 `a9d7eeee52081ebe1cd76dd7d6cb39097a55db244b8e6330a445ef60c3bca17f` = the deploy tx's args bytes | `release/mainnet-night/release-mainnet.json` |
| Judge program (E2, E3) | `8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473`, served from `https://main.fastfs.io/ops.praetorial.near/outlayer.near/<hash>.wasm` | `resolver/release/record-f5695b9.json` |
| Pinned keys (E2, E4) | ruling `f67c1f8f0a7824810874ffd469c2034bf1e7723170ba61c0f3f265f3d3dfe440`, attest `27070cba98ca952f06b41305d34e0ee907bb3da8cc9b6c9de275c93e8c670712` | `view resolver_keys`; E4 txs below |
| Guardian and fee account | `praetorial.near` | `args.mainnet.json` |
| Keeper, operator, relayer, source-check signer, NEAR AI key owner | `keeper.praetorial.near`, `operator.praetorial.near`, `relayer.praetorial.near`, `attest.praetorial.near`, `aikey.praetorial.near` | `args.mainnet.json`; `services/workers/{relayer,sourcecheck}/wrangler.toml` mainnet sections |
| Bets so far | `bet_count` = 2 (2026-11-13 evening ET): bet 1 Settled (NO, conceded by the losing side in the challenge window), bet 2 Taken | `node scripts/verify-bet.mjs --network mainnet 1` = 12 PASS, 0 FAIL; bet 2 = 7 PASS, 2 SKIP (no ruling yet) |

The deployed escrow passed E1-E4 at deploy (`release/mainnet-night/logs/verify-escrow.txt`). The per-bet checks (B1-B6) were rehearsed on
testnet (`services/e2e/live-*`); mainnet bet 1 settled on 2026-11-13 and passes `scripts/verify-bet.mjs` (README, "Verify a ruling yourself").

```
services/verifier/verify-escrow --network mainnet --escrow bets.praetorial.near --expect-escrow-hash caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f --offline   # E1-E3; E4 see below
services/verifier/verify-bet    --network mainnet --escrow bets.praetorial.near --bet <id> --expect-escrow-hash caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f --offline [--terms terms.json] [--wasm-file f]   # without --offline E4 FAILs: the escrow has no keys, so no OutLayer home can run as it
services/verifier/verify-bet    --evidence-dir services/e2e/live-runR3e --expect-escrow-hash <h>   # offline, a recorded testnet rehearsal
# --network testnet --escrow <testnet escrow> for the testnet rehearsal escrow
# B4 extras: --judge-evidence <file> (source text + raw streams), --attestation <report.json[,report2.json]> (NEAR AI attestation report per model)
```

Each check prints `PASS`, `FAIL` or `SKIP` plus a reason. Exit 1 if any check FAILs; SKIPs never turn into PASS.
Code: `services/verifier/src/run.ts` (checks), reusing `services/common/src/resolverSign.ts` (`buildSubmitOutcomeMessage`,
the exact buffer the escrow verifies) and `sourceCheck.ts` (`buildSourceCheckMessage`, freshness window).
Tests: `services/verifier/test/` (recorded R3e evidence, plus one or more tampered copies per check). Offline fixture step in `./test.sh fast`.
Final step of a live run: `services/verifier/final_step.sh <run-dir> [escrow-hash]` (see `services/e2e/live-runR3e/99_verify.sh`);
a live run is not DONE unless it passes.

## Status on the recorded R3e run (offline)

| Check | Offline result | Why |
|---|---|---|
| E1 | PASS (with `--expect-escrow-hash`), else SKIP | needs an expected build hash |
| E2 | PASS (params replay: "not checked" unless `--params-file`) | pins vs release record + recorded `new()` args |
| E3 | SKIP | resolver wasm bytes (2.8 MB) not stored in the repo; pass `--wasm-file` |
| E4 | SKIP | needs a live OutLayer run (spends credit) |
| B1 | PASS | |
| B2 | PASS | |
| B3 | PASS | |
| B4 | PASS on a V1b-resolver record + `--judge-evidence`; SKIP (partial, names the missing material) otherwise | R3e (older resolver) has no signature proof / source hashes: SKIP; everything that can be checked still FAILs on mismatch |
| B5 | PASS | from recorded before/after balance views (not tx receipts) |
| B6 | PASS | |

## Live mode (V1c / D-VER2)

`--network testnet|mainnet` now covers E1, E2, E3, B1, **B2, B3, B5, B6** and B4 (when the on-chain `last_resolution_raw` is present and parseable).
Keyless and read-only. Two public sources:
- **Plain NEAR RPC** (`test.rpc.fastnear.com` / `free.rpc.fastnear.com`, `NEAR_RPC_URL` overrides): `get_bet`, `resolver_keys`, `outlayer_config`, `pending_payouts`, `is_shutdown`, `view_account` (code hash).
- **FastNEAR tx indexer** for history, because plain RPC cannot list an account's transactions: `POST <idx>/v0/account` (paged with `resume_token`) and `POST <idx>/v0/transactions` (tx + full receipt tree).
  `tx.test.fastnear.com` / `tx.main.fastnear.com`; `NEAR_TX_INDEXER_URL` overrides. Chosen over NearBlocks (FastNEAR is keyless and from the same provider as the default RPC). 429/5xx: exponential backoff, 20 s timeout per call.

Mapping into the same `Evidence` the offline checks read (`services/verifier/src/live.ts`, `mapHistory`):
| Check | Live source |
|---|---|
| B2 | the successful `mt_on_transfer` `Open` receipt for the bet (log `open bet_id=N`): `attestation.checked_at` (exact u64 digits) + signature, verified under the pinned `attest_pubkey`; freshness vs `get_bet.created_at` |
| B3 | every successful `submit_outcome` call for the bet, in block order, verified under the pinned `outcome_pubkey` |
| B5 | receipts: accepted Open/Take deposits (amount minus the refund returned by `mt_on_transfer`) in; `mt_transfer` receipts fired by the successful `finalize`/`drain_payouts`/`void_after_deadline`/`emergency_refund` for the bet out; maker/taker/fee account (fee account from the `new()` tx args) deltas; escrow residue = deposits - payouts; pending = `pending_payouts` view (+ any failed `mt_transfer` receipt) |
| B6 | `get_bet.proposed_at`/`taken_at` vs the envelope, finalize = block timestamp (ns) of the successful `finalize` receipt |
| B4 | `last_resolution_raw` from `get_bet` (older-resolver records SKIP exactly as offline) |
| E2 | additionally `new()` args from the escrow's `new` tx, and (PA1b) the `protocol_fee_bps` / `asset_limit` / `pending_params` views + every `params_*` event log from the escrow's tx history (same indexer) for the params replay |
| B1 | terms text from `envelope.terms` (`keep_terms`) when `--terms` is not given |

Does NOT prove / limits: the indexer is trusted for completeness and content of the history (B2/B3 are self-authenticating by signature, B5/B6 are not): a hidden
tx usually makes a check SKIP or FAIL (a hidden payout breaks the residue, a hidden finalize SKIPs B5), but a hidden later `submit_outcome` leaves B3 PASS on the visible runs, and a forged indexer response for B5/B6 would not be detected; cross-check the tx hashes in an explorer. Challenge bonds /
objection deposits are not mapped: B5 SKIPs for such bets. Check a bond by hand: it must equal
`max(min_bond, 10% of pot_for_challenger) * 2^(round-1) + run_price` (`contracts/escrow/src/lib.rs:2408-2411`; `pot * 1_000 / BPS_DENOM`
with `BPS_DENOM` = 10_000). Known doc-comment error: `lib.rs:1560` (and the inline comment at `:2393`) say 5% of the pot; the code is 10%.
The contract is frozen on mainnet, so the comments are not edited. `retry_payout` (keyed by line id, not bet id) is not followed. Fee account is taken from the `new()` args, so
a bet whose escrow `new` tx is missing from the history attributes every non-maker/taker payee to the fee account. Tests use recorded responses
(`services/verifier/test/fixtures/v1c/r3e_live_rpc.json`, re-record with `fixtures/v1c/record.mjs`); the verifier tests never touch the network.
First real run: R3e on testnet (B4 older resolver, E4 SKIP); its escrow account no longer exists, so it can't be re-run live.

## Checks

### E1 deployed escrow code == reproducible build of a named commit
- Proves: the code hash on the escrow account equals the hash of a build you made from a named commit.
- By hand: `cd contracts/escrow && cargo near build reproducible-wasm` (or `non-reproducible-wasm` plus the same toolchain),
  `shasum -a 256 <escrow.wasm>`; deployed hash: `near state bets.praetorial.near --networkId mainnet` (base58) or the RPC `view_account` `code_hash`.
  Pass the hex as `--expect-escrow-hash`.
  **Reproducible reference (ESR1):** `contracts/escrow/release/record-<sha>.json` holds the escrow wasm built 3x in the pinned
  `sourcescan/cargo-near` image (pulled by digest from `contracts/escrow/Cargo.toml`); repeat with
  `contracts/escrow/release/build_reproducible.sh <commit> run|cp <outdir>` (prints sha256 of `escrow.wasm`).
  E1 compares the deployed `code_hash` (RPC `view_account`, base58 -> hex) with the record's `hash` (`hash_bs58` is also given); they must be equal.
  Current record `record-84f23c8.json` (the code deployed on mainnet `bets.praetorial.near`, deploy tx `9gFoypqaFzHEnUmkecG6NarvzoH8fdg8Bn2TPfy34NpX`): `caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f` (base58 `EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q`). `record-1f223ec.json` and `record-c40e5fa.json` record the same hash for earlier commits with the same escrow source (84f23c8 re-issued the record; tests-only diff).
  Rebuild: `contracts/escrow/release/build_reproducible.sh 84f23c8 run <outdir>` prints that sha256.
  Superseded: `record-8580ca7.json` (ESR2, main 8580ca7 after FM1/MS1/RA1/CMT1/TKH1/STG1/CMT2; same image `sourcescan/cargo-near:0.22.0-rust-1.97.1`): `6b59b3350ebd20b4bd5c7684d5a97d6c45e96d61241fca69fd9427cd1618362c`.
  Superseded: `record-6944916.json` (TC1, escrow source before those fixes): `f62c4843ff7f2d33734cb8bc07c6e3da57199efd8440592c430975f090ef4b1b`.
  Superseded: `record-9662db8.json` (rustc 1.96.0 image): `72f16b48792cf39d65537f1b7014e996287cfbf159e557f7e7ba134dc4711743`.
  Toolchain: tested compiler == shipping compiler; `contracts/escrow/release/check_toolchain_align.py` (run by `./test.sh` "release record") fails if the rust-toolchain.toml channels and the Cargo.toml image's rust version differ.
  `./test.sh` step "release record" validates the record's shape (>= 3 identical builds, pinned digest, linux/amd64) with the resolver's
  `verify_release_record.py`; it does not rebuild. Older note: R3e deployed the `CARGO_PROFILE_RELEASE_STRIP=symbols` build (`f5074235...`) of the
  same source as the plain build (`d8d2a870...`); expect the stripped hash for that build.
- Does NOT prove: that the named commit is the one the docs say, that the source is free of bugs, or that the build is bit-reproducible
  across toolchains. The verifier does not build for you.

### E2 `new()` pins match the release record
- Proves: `resolver_keys()` = (outcome_pubkey, attest_pubkey, resolver_wasm_hash) as pinned; the pinned wasm hash appears as `hash` in a
  `resolver/release/record-*.json` (E2 does not re-check the record's builds or image digest; `verify_release_record.py` does); `outlayer_config` and recorded `new()` args agree; escrow is not shut down.
- By hand: `near view bets.praetorial.near resolver_keys`, `near view bets.praetorial.near outlayer_config`, `near view bets.praetorial.near is_shutdown` (mainnet);
  `grep <hash> resolver/release/record-*.json`; `python3 resolver/release/verify_release_record.py <record>`.
- Params (D-PARAMS1, PA1): the fee rate and each asset's min fee / min / max stake are NOT fixed by `new()` any more: the guardian
  can change them for NEW bets after a 24h delay. Check the CURRENT values against the event log:
  `near view bets.praetorial.near protocol_fee_bps`, `near view bets.praetorial.near asset_limit '{"asset_id":"nep141:usdt.tether-token.near"}'`, `near view bets.praetorial.near pending_params`;
  then replay the contract's `params_applied` events (EVENT_JSON `praetorial-escrow`, in tx order, on top of the `new()` args) and
  confirm they reproduce the viewed values; any `pending_params` shows what takes effect and when (`effective_at_ns`). Hard caps in
  code: fee <= 200 bps, min fee <= the per-asset cap pinned at `new()` (`min_fee_cap_per_side`), min <= max, min fee <= min/20. At launch each asset's `max_per_side` is 10^34 raw (D-CAP3: no stake cap, the largest overflow-safe value); never raise it above that (the bond floor does `pot*1000` in checked u128).
  An open bet is unaffected by a later change: each bet copies the min fee at open (`fee_min_maker`/`fee_min_taker`, plus `fee_min_taker_options` for each taker-option asset; a take through an option uses that option's copy, FM1) and `fee_bps` is in its envelope.
  **Automated (PA1b, `services/verifier/src/params.ts`):** E2 FAILs unless (1) the viewed `protocol_fee_bps` and each asset's
  `asset_limit` (min fee / min / max / pinned cap) equal `new()` args + the `params_applied` events replayed in order (starting fee
  100 bps), (2) every applied change took effect >= 24h after its proposal (block time of the apply >= proposal + 24h and >= `effective_at_ns`,
  and the event itself claims >= 24h), (3) every proposed/applied value respects the hard caps above (fee <= 200, min fee > 0 and <=
  pinned cap, min <= max, min fee <= min/20, no unknown asset), (4) the log is coherent (apply/cancel payload equals the pending
  proposal, no proposal while one is pending, no apply/cancel with nothing pending) and (5) the `pending_params` view equals the
  outstanding proposal in the log (or is null). Only successful receipts' `EVENT_JSON` lines count (a failed `apply_params` logs nothing).
  `--network` runs fetch the views over RPC and the events from the FastNEAR tx history (current account incarnation only); a
  contract without the PA1 views (`MethodNotFound`) prints "params replay not checked: contract predates PA1" and any other view
  failure aborts instead of skipping. Offline: pass a recorded input with `--params-file` (format in the CLI usage; `services/verifier/test/fixtures/pa1b/`).
  **Still manual / not covered:** (a) completeness of the log depends on the tx indexer returning the escrow's whole history; a
  hidden apply shows up as a view/log mismatch (FAIL) but a hidden propose+cancel pair is invisible and harmless; (b) offline
  `--evidence-dir` without `--params-file` has no chain, so the replay is "not checked" (E2 still PASS on the pins); (c) per-bet values
  are not re-derived here (`fee_min_maker`/`fee_min_taker` and envelope `fee_bps` are bet-time copies, covered by the B-checks).
- Does NOT prove (beyond the params replay above): guardian, limits, fee and fee account are what the docs say (offline checks the recorded args only);
  that the release record's build is reproducible (re-run `resolver/release/build_reproducible.sh`).

### E3 resolver wasm on FastFS hashes to the pin
- Proves: the bytes OutLayer would fetch from `outlayer_config.wasm_base_url/<hash>.wasm` hash to `resolver_wasm_hash`.
- By hand: `curl -s <wasm_base_url>/<hash>.wasm | shasum -a 256`; on mainnet
  `curl -s https://main.fastfs.io/ops.praetorial.near/outlayer.near/8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473.wasm | shasum -a 256`.
- Does NOT prove: that the wasm does what its source says (that is the release record) or that FastFS serves the same bytes to the TEE.

### E4 outcome/attest pubkeys reproducible (live; SKIP only with --offline or recorded evidence)
- On mainnet, E4 is checked by reading the 4 recorded report-pubkey txs; a live re-run is testnet-only. The mainnet escrow has no keys, so nobody can run report-pubkey as it again (see the last bullets).
- FRZ1b: live `verify-escrow` runs the pinned wasm in report-pubkey mode itself (`--outlayer-home-escrow`, `--outlayer-home-attest`; spends OutLayer credit). Without the homes E4 FAILs; `--offline` SKIPs E4 and exits 3.
- Proves (when run): the pinned keys are the ones the pinned wasm derives inside OutLayer for this escrow (the TEE binds key to wasm hash + caller).
- By hand: run the resolver wasm with `{"mode":"report-pubkey"}` as the escrow-bound caller (see `services/e2e/live-runR3e/job_report_pubkey.json`
  and `report_pubkey_*.log`); compare `pubkey_hex` with `resolver_keys()`. Spends OutLayer credit.
- Mainnet, on chain (no OutLayer account needed to READ them): the four report-pubkey runs of the pinned program are public txs to
  `outlayer.near`, each with the program hash in its request (`source.WasmUrl.hash` = `8791413f…`) and the keys in its result:
  as `bets.praetorial.near` before deploy `68bixJNEftXehdSjrSfF9r6VSa5diPAMnFEkLFATeCAB` and after `Dbp3M7nfrNKfyoyMunmnS5kHjacuU18NfVEqBRwgYw9m`
  (`public_key` = `f67c1f8f…` = the pinned ruling key); as `attest.praetorial.near` before `FF7ta6qDfBEN4ivby1VQ5Nyyfj9qgxvjxuveFWgUH3bP` and
  after `GSeXpea6crnGu1BtZDQKwyfo63YFg5j6HBADrAYvjHoF` (`attest_public_key` = `27070cba…` = the pinned attest key). Read them with the RPC
  `tx` method on an archival node (the Docs' Trust page, step 4, has the exact command). Re-running them needs the escrow's own account,
  which has no keys any more.
- Does NOT prove: anything about TEE integrity itself; it trusts OutLayer's attestation model.

### B1 `sha256(terms) == envelope.terms_hash`
- Proves: the terms file you hold is the one the bet was opened with.
- By hand: `shasum -a 256 terms.json`; `near view bets.praetorial.near get_bet '{"bet_id":N}'` -> `envelope.terms_hash` (mainnet bet ids start at 1).
- Does NOT prove: the terms are fair, unambiguous, or that the sources named in them are trustworthy.

### B2 sourcecheck attestation
- Proves: the ed25519 signature over `praetorial:sourcecheck:v1:<spec_hash>:<checked_at>` verifies under the pinned `attest_pubkey`,
  `spec_hash == terms_hash`, and `checked_at` was <= 1 h before the bet was opened.
- By hand: rebuild the message, verify with any ed25519 tool against `attest_pubkey`.
- Does NOT prove: that the sources stay reachable or unchanged after open.

### B3 submitted results
- Proves: each result's ed25519 signature verifies under the pinned `outcome_pubkey` over the escrow's own buffer
  (`escrow ++ bet_id ++ terms_hash ++ outcome ++ element_results_hash ++ run_no ++ checked_until ++ judge_pair_index` (u32), plus `next_check_ns` and any `model_not_found` observations for RETRY, borsh; records from before JC1s use the 7-field layout), run_no increases with no replay (offline 1..n; live, gaps allowed),
  `terms_hash` and `bet_id` match the bet.
- By hand: fetch the `submit_outcome` tx args, rebuild the buffer (`services/common/src/resolverSign.ts`), verify.
- Does NOT prove: the outcome is the truthful one (that is B4 and the dispute process), only that the pinned resolver signed it.

### B4 judge record (V1b / D-VER2: independent when the record is from a V1b+ resolver; V1d / D-VER2a: signer binding)
The resolver now records, inside `last_resolution_raw` (opaque to the escrow; the contract keeps at most `MAX_RESOLUTION_RAW_BYTES` = 16 KiB of it; resolver budget < 16 KiB, test-enforced):
`judge.run_diagnostics[].signature_proof` (`signing_algo`, `signing_address`, `signature`, signed `text`, `response_sha256`, `request_sha256`),
`raw_sha256` (sha256 of the string the judge scored), `content` (answer text, capped at 4096 chars, `content_complete`),
`judge.sources[]` (`id`, `url`, `publisher`, `sha256` of the exact reader text, `party_controlled`, `curated`, optional `final_url`/`origin`/`snapshot_id`),
`judge.element_evidence[]` (`id`, `rule` = `curated` | `D-ORIGIN1`, `answers` = raw_sha256 list). Signed outcome, element_results_hash,
FIXED_SYSTEM and J4 settings are unchanged. Page bodies and raw streams are NOT on-chain.
- Proves (checked, FAIL on mismatch): decision rule on recorded verdicts == signed outcome (ESCALATE maps to VOID like the resolver);
  every NEAR AI ed25519 signature re-verified offline with the resolver's own test (signed text contains sha256(stream) AND ed25519
  verifies under `signing_address`); answer text hashes to `content_sha256`/`raw_sha256`; element verdicts re-derived from the recorded
  answers (schema check, origin groups, D-ORIGIN1/D-EXH1 >= 2 distinct derived origins for a decisive verdict, party-controlled rule) and
  compared with the record, then `decide()`.
- **Signer binding (V1d).** A signature checked only under the *recorded* `signing_address` proves nothing against a forged record that
  carries its own keypair, so each signature-verified `(model, signing_address)` is bound to NEAR AI's public attestation report
  (`GET https://cloud-api.near.ai/v1/attestation/report?model=<m>&signing_address=<a>`; **keyless**, no completion, no spend). **As of 13 Nov 2026 this binding does not work:** the endpoint answers HTTP 503 (`Signing address not found on this provider`) whenever `signing_address` is given, and its reports name models in `model_attestations[].model_name`, which `services/verifier/src/attest.ts` rejects; live B4 binding ends in SKIP or FAIL until the verifier is updated. Binding rule, exactly: the report must contain a `model_attestations[].model` equal to the
  recorded model AND `gateway_attestation.signing_address` equal to the recorded `signing_address` (the ed25519 key that signs NEAR AI
  responses, `signature_kind: gateway`). Supply reports with `--attestation <file>[,<file>]` (offline mode never fetches); live mode
  fetches one per distinct (model, signer) when the flag is absent. B4's reason prints the first 16 hex characters of the sha256 of each report used; the full sha256 is in the check's
  `evidence.attestation_reports[]` / `evidence.bound[]` (library result, not printed by the CLI).
  Result: PASS only if all signatures verify AND every signer is bound. No report for a signer -> SKIP naming `model signer <address>`.
  A report for that model that does not list the signer, a report that lists the signer only for a different model, or a file that is
  not a NEAR AI report -> FAIL. A report that concerns neither the model nor the signer is not evidence about it -> SKIP.
  The endpoint's reply depends on `signing_address` (an unknown address returns HTTP 503), but the check is on the
  report's *content*, never on the query.
- With `--judge-evidence <file>` ({"sources": {id: reader text}, "responses": {sha256: raw NEAR AI SSE stream}}), additionally: each source text
  hashes to its recorded sha256; every quote (also `also[]`) occurs in it under the J4 normalisation (`judgeport.ts` == core `quote_in`; 3.5 != 35, -5 != 5);
  each raw stream hashes to the signed `response_sha256` and its content equals the recorded answer (answer bound to the signature).
- SKIP (partial) only for absent optional input, and the reason lists exactly what: source text (quote-in-source not run), raw stream
  (answer <-> signature binding not run), or, for older-resolver records such as R3e, `signature_proof` / `judge.sources` / `judge.element_evidence`.
- Does NOT prove (signer binding): **the attestation quote chain itself is NOT verified by verify-bet.** The report's Intel TDX quote
  (`gateway_attestation.intel_quote`, event log, `report_data`), NVIDIA GPU evidence and the model-provider (e.g. Tinfoil SEV-SNP)
  entries are only matched on model and address, not checked against Intel/NVIDIA/AMD roots, nor that `report_data` commits to the
  address. So a report that merely *says* the address is attested is accepted. To verify the chain by hand: take the same report
  (`curl -s 'https://cloud-api.near.ai/v1/attestation/report?model=<m>&signing_address=<a>' > report.json`) and run NEAR AI's documented
  attestation verifier (https://docs.near.ai/cloud/verification/, the model/gateway attestation verification guides there) on it; the
  repo's judge-proto/attest/verify_attest.py + verify_full.py do the SEV-SNP/VCEK part for one recorded report. Also not proven: key
  rotation / time of attestation (a fresh report shows today's key; a record from an earlier key can SKIP/FAIL against it, and a
  stale saved report proves nothing about now), and the resolver itself does not check binding (it verifies the signature under the
  address the signature endpoint returns), so this is a verifier-side check only. The resolver wasm must be from a commit >= 765b471
  (see resolver/release/CHECKLIST.md) for `signature_proof` to exist at all.
- Does NOT prove: that NEAR AI's signing address belongs to NEAR AI beyond the above (the address is taken from the record and matched to the report),
  that the reader text is what the live page said (only that the judge saw text with that sha256; snapshot/archive id is recorded when the
  resolver has one), or that the models read the sources correctly. The element rule is recorded as `D-ORIGIN1` for every non-curated element
  (exhibits share the same quorum function), so D-EXH1 is applied via that same rule.

### B5 payout arithmetic
- Proves: winner delta = pot - fee (per side: min(stake, max(floor(stake*fee_bps/10000), that asset's min fee)); D-FEEMIN1), loser 0, fee account = fee + both sides' storage charges,
  escrow residue 0, no pending payouts. Only YES/NO is checked (VOID refunds: SKIP).
- By hand: balance views of maker, taker, fee account, escrow before and after `finalize`.
- Does NOT prove: that the right side won (B3/B4) or that no other bet shares the balances (on a busy escrow use tx receipts).
  Offline it uses recorded snapshots, not receipts.

### B6 timeline
- Proves: taken before `funding_deadline`; outcome proposed after it and before `resolve_deadline`; finalize happened after
  `proposed_at + settlement_period`.
- By hand: `get_bet` timestamps (ns) and the finalize tx timestamp.
- Does NOT prove: that nobody could have challenged in the window (see dispute docs).

## Person-decided bets (referee-v1, D-REFUI4)
- A bet whose envelope names a `referee` (mode `Human`) is decided by that person, not the AI: `get_bet` shows `envelope.referee`,
  and `status` goes `Taken` -> `Finalized` in the single `referee_rule` call (no `Proposed`/settlement window, no bonds).
- Check: the `referee_rule` tx signer equals `envelope.referee.account`, its block time is within `[funding_deadline, resolve_deadline]`,
  and the payout lines match: winner gets both stakes minus protocol fee minus that bettor's tip; `referee_tip` lines (one per opted-in
  bettor, in that bettor's own asset) go to the referee; VOID refunds stakes minus tips.
- No ruling by `resolve_deadline` -> anyone calls `void_after_deadline`; both are refunded (a tip, if opted in, still goes to the referee).
- Does NOT prove: that the referee ruled honestly. You trusted that person by taking the bet. Both parties can switch to AI with a
  both-signed `amend_referee("null")` until the referee has ruled.
