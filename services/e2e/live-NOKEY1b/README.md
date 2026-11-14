# NOKEY1b live evidence (testnet only)
- frz3 escrow `praetorial-frz3-2611100414.praetorial-dev-1101.testnet`: same frozen escrow wasm caf134a4 (code hash EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q == frz2, `codehash.txt`), resolver 8791413f (record-f9c61ec).
- create 3Mwyg7cK6XCysD9oxAdKrWPYwLbdkFRWSDSz5ixxHvav, deploy HE9daBekRxBXcvTkSqWNSpPFjeXJPAeEDd7Zoncahxmj, new() 5rxmKJfGrRrB63rYHXwVgBooc6FbMmuaCGRx9pv5yD1k. report_pubkey jobs (D-KEY2): escrow 2F4fRUYeDNwTXfALrJrb3j72UvhxBPnXPGWas9ADFKuT, attest1 FsSh7BVuDdZknzmaXjzM3zhdbWnbVave3qqeCKPmwm9G. `verify-escrow.txt`: E1-E4 PASS.
- Key bound via `live-run16r/bind_secret.sh` (value never printed); `check_key_bound.txt`: OK for the full hash (exit 0), FAIL for a made-up hash (exit 1).
- Live proof: bet 1 (iana.org check, 1 USDC-style mock stake), request_resolution tx `Bk6om1XbndFEVazT4tKmDJQ1JSEcpbJ77Xs1TmGHHRHb`. `bet1_last_resolution_raw.json`: signed result (signature 128 hex under the pinned outcome key), judge_backend `near-ai`, http 200/200, no credit/quota hit. Outcome VOID (evidence is the backend + signature, as in FRZ2SEC1 bet 26). Bet left in Resolving.
- prove_live.mjs sourcecheck runs the same OutLayer job directly as attest1 because the deployed sourcecheck Worker pointed at frz2 until the step-8 redeploy.

## NOKEY1c merge + redeploy (2026-11-10, track A build agent)
- Merge to main: 23cdfcd0 (feat/nokey1b, incl. DR6 expected-escrow RED->GREEN 84f23c84, escrow record-84f23c8 cb52198d, stackCheck test pins 6e36e9f0). `git diff --stat 6e33faa HEAD -- contracts/escrow/src` empty.
- Escrow record `contracts/escrow/release/record-84f23c8.json`: 3 identical reproducible builds (docker run, docker run, fresh create/cp), sha256 caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f == frozen wasm; one earlier attempt died with the known QEMU linker SIGSEGV and was discarded.
- Testnet Workers redeployed from main with `services/workers/scripts/deploy-testnet.sh` (git_sha 23cdfcd0bbb4), all seven (indexer 7c50e732, notifier 492ec1a6, monitor 366b6b7b, relayer e1c4ee9f, keeper 3e5b2672, registry c81f8254, sourcecheck a1ec25d7); web via `npm run deploy:testnet` in apps/web (version 09984697).
- `check-deployed-stack.mjs`: 7/7 PASS, escrow = frz3. keeper wrangler ESCROW_CONTRACTS = frz3@v1,frz2@v1 (frz2 in-flight bets keep settling); indexer bets_cached 53.
- Live bundle index-CbgBC1UU.js contains the frz3 id and resolver hash 8791413f..2473 (no frz2 id); frz3 resolver_keys()[2] == 8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473 == apps/web/lib/release.json.
- keeper_credit_balance: frz2 0.5799 NEAR, frz3 0.5799 NEAR; keeper account 1.3046 NEAR, relayer 5.41, dev account 0.49. No top-up needed, none sent.
