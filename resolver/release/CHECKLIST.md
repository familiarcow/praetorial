# Release-record checklist (resolver wasm)

Before a release record (`record-<sha>.json`, verified by `./test.sh` step "release record") is used for a live run:

1. Build with `build_reproducible.sh` three ways (run / run / fresh container); all three sha256 must equal `hash` in the record.
2. `python3 verify_release_record.py record-<sha>.json` exits 0.
2a. **EXP2: point `CURRENT` at it and stamp its source digests** (same for `contracts/escrow/release/`): `echo record-<sha>.json > CURRENT`,
   then `python3 -I ../../scripts/release/covers_source.py stamp resolver record-<sha>.json` (escrow: `... stamp escrow ../../contracts/escrow/release/record-<sha>.json`).
   The "release record" step picks the record from `CURRENT` (never git order, so a squashed clone works), fails if a newer record was added
   without moving `CURRENT`, and compares the record's per-file `source` digests with the working tree (plus `git diff <commit>` when the commit exists).
3. **The release wasm must be rebuilt from a commit >= 765b471 (V1b recording: `judge.run_diagnostics[].signature_proof`,
   `judge.sources`, `judge.element_evidence` in `last_resolution_raw`) before the next live run.** An older wasm leaves verify-bet
   B4 at SKIP, and without `signature_proof` the V1d signer binding to NEAR AI's attestation report has nothing to bind.
4. Pin the new wasm hash into the escrow `new()` args and re-check `verify-bet` E2.
5. **Key-bound preflight (NOKEY1/D-NOKEY1; launch gate).** Every resolver rebuild changes the wasm hash, so the OutLayer secret must be re-bound for
   (escrow, new hash) BEFORE the escrow is pointed at it: `bind_secret.sh <escrow> <64-char hash>` (services/e2e/live-run16r), then
   `OUTLAYER_HOME=<secrets-owner home> python3 -I check_key_bound.py --escrow <escrow> --hash <64-char hash>` must exit 0. Exit 1 = stop: an unbound
   real-http resolver emits no outcome (unsigned `no_live_judge_key` error; the bet sits in `Resolving` until `void_after_deadline`). Never print the key.
