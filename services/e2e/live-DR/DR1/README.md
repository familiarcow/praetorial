# DR1 (rehearsal-btc-touch-ai): STATUS DONE WITH LIMITATIONS: bet 18 Settled NO == ground truth, paid, verifier 0 FAIL (E4+B4 SKIP offline); harness balance-delta assertion FAILS from shared-account confounding (see Phase 3)

Target: https://praetorial-web-testnet.familiarcow.workers.dev. Escrow praetorial-frz2-2611091914.praetorial-dev-1101.testnet (the deployed bundle names it; resolver_keys()[2] = 6517a422f55639d5d... = apps/web/lib/release.json). `git diff 6e33faa HEAD -- contracts/escrow/src` is empty.
git_sha start == end: relayer 6984faf74f8c, sourcecheck ea9689f95c4a. NEAR AI calls so far: 0 (no request_resolution yet). Sourcechecks used: 2 (attempt 1 bet 17, run 2 bet 18), both HTTP 200, no 429.

## Bet 18 (btc_touch, built in the web builder)
- at_or_above **$75,200** (Coinbase spot at choice $74,588.82, +0.82%; Kraken 24h high was ~$75.47k, so the real price decides), 3 wNEAR per side (harness-minted via the mock intents mint, not the UI Move-NEAR flow), odds 1, settlement window 1h, invite-by-link.
- Window ~6 h: **T = 2026-11-10T10:48:00Z** (deadline_utc). Open ~04:48Z. 6 h > 5 h, so this proves D-SRCCHK3 live: the review-card sourcecheck read only the last closed minute and still said "The AI can read these sources."
- **Earliest request_resolution: 2026-11-10T10:50:00Z** (T + 2 min, the spec waits for the last window minute to close on every venue). The settlement window is 1 h after the judge result, so finalize ~12:00Z at the earliest.
- Maker: Privy test login (OTP never logged), `8941e607...81c7`. Taker: `dfb218d3...32ba`, took through the invite link (Node-side `__drSign`).

## Tx table (phase 1)
| Step | Tx | Signer |
|---|---|---|
| mint wNEAR to maker | ERyP5VGmBRT1FtVmiRHuLtLzXWD6wcDofFTxb4J3TKgU | harness faucet |
| mint wNEAR to taker | 6fdwiM3tE5mZRk4Hiw6EpnY2pwvzZJVk9xDVJ5agkVLn | harness faucet |
| cancel orphan bet 17 (web, maker) | HhH6cktSM5LuPRcdFqKXwX2wFG6GNj1guxQEpN1jZgr7 | relayer |
| open bet 18 (web, maker; relayed hash from the relay response) | GtURKaDMyR7q6DkhDG6LD3cQi3hCtT8cggvmVe9YsMvG | relayer |
| take bet 18 (web, taker, invite link) | 9a4F9pfPopervAJQehwvqXe3EiT1vnwXq2UL4sdtDPCs | relayer |

## Notes / findings
- Attempt 1 opened bet 17; the harness hung on an absent `open-tx` element (`textContent().catch` waits for the locator), the run died, and the maker's invite secret lives in the lost browser's localStorage, so bet 17 could not be taken. It was cancelled through the web (above) with the maker's stake returned. Spec fixed (`optText`, `DR1_CANCEL_ORPHAN`). Harness issue, not a product bug.
- Possible web gap (not confirmed as a bug): the invite link can only be made in the browser that opened the bet (secret in localStorage); a maker who logs in elsewhere cannot invite for an invite-by-link offer. Proposed TRACK: web item for the PM to triage.
- ground_truth.json now holds a PENDING record (window, claim). Phase 2 fetches Kraken, Coinbase and Bitstamp 1-minute candles itself, writes the verdict, and only then sends request_resolution.

## Resume (phase 2, after 2026-11-10T10:50:00Z)
```
cd ~/praetorial-wt/overnight/apps/web && ln -sfn ../../../apps/web/node_modules ../../services/e2e/live-DR/node_modules 2>/dev/null; set -a; . $PRAETORIAL_SECRETS_DIR/praetorial-privy.env; set +a
DR1_PHASE=finish PLAYWRIGHT_BASE_URL=https://praetorial-web-testnet.familiarcow.workers.dev npx playwright test -c ../../services/e2e/live-DR/harness/playwright.live.config.ts --project=maker DR1.live
```
Phase 2 runs ~1-2.5 h (the test timeout is 3 h): waits to T+2 min, truth, request_resolution via the web (taker wallet), polls for the judge result, finalizes via the web after the window, checks money from chain views. Then `services/verifier/final_step.sh <run-dir> <escrow-hash>` (expect 0 FAIL 0 SKIP, E4 only if offline), README completion, vault case-study addendum (append only), ./test.sh fast, merge under MERGE.lock.

## Proves / does not (so far)
Proves: the web builder produces an accepted btc_touch AI offer with a > 5 h window; sourcecheck passes for a long window; invite-link take works. Does not yet prove: the AI ending, payouts, verifier.


## Phase 2 diagnosis (2026-11-10 ~13:45-13:50Z; the Playwright finish phase was NOT run, see below)
Bet 18 sat in `Resolving` with a signed NO in `last_resolution_raw` and `outcome` null. Evidence:
- `request_resolution` was sent by the **keeper** (`keeper.praetorial-dev-1101.testnet`), tx `8Xh3N5dsZsNdKcP9bKuWhVWnuGe7a7zxcNgiDHtU9MDU` at 10:49:32Z (receipts: request_resolution, request_execution, on_execution_response, on_resolution). Before it the keeper's every-2-min attempts from 08:41Z failed with "too early to request resolution" (e.g. `Giroggyhnpb2WMENCBCW3zmsC4NGUPMCgHWyeXT3bbZx` 10:39:32Z), as designed. The harness had not run.
- The OutLayer callback worked: `on_resolution` stored the resolver output. Judge: `judge_backend near-ai`, judge_ran false (code-decided 1b: Coinbase/Bitstamp/Kraken complete coverage, none crossed X; the 17c5 audit call to deepseek returned `agree`, http 200). NEAR AI: 1 audit call, no 402/credit error.
- Signing key `daff356d...` = `resolver_keys()[0]` (the outcome key); `[2]` (6517a422...) is the resolver wasm hash, not a signing key, so my initial suspicion (key not bound) was wrong. checked_until 0 is not rejected.
- Why not applied: by contract design `on_resolution` is informational and **never settles** (lib.rs `submit_outcome` doc: "Anyone submits the resolver's signed outcome ... `on_resolution`'s stored raw payload ... never itself settles a bet"). `submit_outcome` is permissionless and nothing in production calls it: the keeper only runs the test-key `resolverSim` (`resolver_keys()[0]` != its test key -> skip), and the web has no submit call. State was the documented D-RESOLVE3 wait ("stays Resolving until submit_outcome"; backstop = void_after_deadline at resolve_deadline 2026-11-17T~10:48Z, refunds). `runs_used` 0 / `retry_count` 0 / `next_check_ns` null are consistent (no RETRY result).
- Funds were never stuck and no wrong winner was possible: the submit is validated on chain (signature under the pinned key, run_no, terms_hash), and the outcome equals ground truth.
- Process gap (not a contract bug): nobody relays the resolver's signed output in production. The DR1 web flow assumed the judge result would land by itself. PM triage item: a keeper step "submit_outcome from last_resolution_raw" (permissionless relay) or a web button. FINDING: no (no stuck funds, no wrong winner); gap noted.

## Ground truth (honest order of events)
`run/ground_truth.json` was written at ~13:47Z, AFTER the signed NO was visible on chain (and after the keeper's request_resolution), so `outcome_read_before_this` is true. It was computed only from raw 1-minute candles (window 04:49Z-10:48Z): Coinbase 360 candles max high $74,902.89; Kraken 359, $74,888.80; Bitstamp 359, $74,904.03; none reaches $75,200, 0 of 3 venues confirm -> **NO** (>= 2 of 3 needed for YES). Chain outcome NO == truth. The prior 04:49Z PENDING record was replaced.

## Phase 2 as run (instead of the Playwright finish phase, which would have re-clicked request_resolution on a bet already Resolving)
| Step | Tx | By |
|---|---|---|
| request_resolution | 8Xh3N5dsZsNdKcP9bKuWhVWnuGe7a7zxcNgiDHtU9MDU | keeper (10:49:32Z, not the harness/web) |
| submit_outcome (relayed from stored `last_resolution_raw` via `relay.ts submitArgsFromRaw`, test-first) | ABdWDYZLvTxGWLfjB5fyAifxG5MGN7FBx8yUGoeyT7Vr | praetorial-dev-1101.testnet (permissionless; not an admin method) |
After it: status Proposed, outcome NO, proposed_at 1794318502234194700 (~13:48:22Z), runs_used 1, used_run_nos [1].
Not web-driven: the request and submit were not done through the web, so DR1's "through the web" claim does not hold for those two steps; finalize may still be done through the web.

## Phase 3: finalize, money, verifier (2026-11-10)
**Bet 18 final state (chain view, frz2):** status Settled, outcome NO (== ground truth NO), proposed_at ~13:48:22Z, `is_fully_paid` true, no undone `pending_payouts`. No wrong winner.

| Step | Tx | By |
|---|---|---|
| mint/cancel/open/take | see Phase 1 table above | web (maker/taker) |
| request_resolution | 8Xh3N5dsZsNdKcP9bKuWhVWnuGe7a7zxcNgiDHtU9MDU | keeper, NOT web |
| submit_outcome | ABdWDYZLvTxGWLfjB5fyAifxG5MGN7FBx8yUGoeyT7Vr | dev account relay, NOT web |
| finalize | EkMbnyrDyr6s6Nh3iz6JFYdZ7vyLTHeSCmPvx8Wn8Fxv | keeper.praetorial-dev-1101.testnet, 2026-11-10 17:55:32Z (12:55 EST), NOT web. Events: bet_finalized bet 18, payout_done [48,49], [50,51] |

The keeper finalized first (the web finalize button was never exercised; the web points at frz3, not frz2). Payout receipts of that tx (intents-mock `mt_transfer`): taker dfb218d3... **5728260869565217391304348** (= 2x3 NEAR - 2x side_fee 135869565217391304347826), fee account **306039130434782608695652** (2 side fees + 2x17.15 mNEAR storage). Maker (loser, YES) 0. Sum = 6034300000000000000000000 = deposits, so escrow residue for bet 18 = 0.

### Money assertions (`money.ts`, chain views; `run/money_check.json`)
Expected via `expectedDecisive(bet_taken.json, NO, feeBps)`: maker 0, taker +5728260869565217391304348, fee +306039130434782608695652, escrow 0.
Observed balance deltas vs `state.json` mid-balances:
- taker +5728260869565217391304348: MATCH.
- maker +14356566126270076178260873: MISMATCH (expected 0).
- fee +1229746521739130434782608: MISMATCH (expected 306039...).
- escrow vs before: +8.07125 NEAR: MISMATCH (expected 0).
**The strict balance-delta check FAILS and is not loosened.** Cause (diagnosed, not a contract defect): maker account, fee account and the frz2 escrow are shared with other bets/tracks (e.g. other frz2 bets, keeper/other test payouts and deposits during the ~8 h wait), so account-level deltas are confounded. The per-bet evidence is exact: the finalize tx receipts above, and verifier B5 (below, derived from the escrow's own tx receipts) reports winner taker +5728260869565217391304348, fee +306039130434782608695652, loser 0, escrow residue 0, pending 0. That is a harness-design finding: balance-delta money checks need isolated accounts (fresh escrow/maker/fee) or per-bet receipt accounting. Not fixed here.

### Verifier (`run/verify_bet18_offline.txt`; live attempt `run/verify_bet18_live_noE4.txt`)
`verify-bet --network testnet --escrow <frz2> --bet 18 --expect-escrow-hash caf134a4...450f2f --offline`: **8 PASS (E1 E2 E3 B1 B2 B3 B5 B6), 0 FAIL, 2 SKIP (E4 offline, allowed; B4 partial)**. B4 SKIP: decision rule re-applied gives NO == signed outcome, answer text hash matches and 1 NEAR AI signature re-verified, but the raw NEAR AI stream (judge_evidence.json) and attestation report were not supplied, so B4 is not a full PASS. This misses "0 SKIP except E4". Live (no --offline) gives the same plus E4 FAIL because no OutLayer homes are logged in here (environment, not a contract result). `final_step.sh <run-dir>` was NOT run: it needs a recorder evidence dir in live-runR3e layout, which DR1 did not record; verify-bet live/offline is the equivalent.

### Web-driven vs not
Web: wNEAR mint (maker/taker via relay), orphan cancel, open (builder), take (invite link). NOT web: request_resolution (keeper), submit_outcome (relay), finalize (keeper). DR1's "through the web" clause is therefore NOT met for these.

### Proves / does not
Proves: an AI-judged btc_touch bet on testnet resolves from real candles to NO (code-decided, 3 venues), signature validates on chain, finalize pays winner and fee exactly per spec, escrow bet residue 0, independent verifier replays 8 checks with 0 FAIL, and the keeper alone now carries it submit -> finalize (KEEPSUBMIT1c). Does not prove: web-driven request/submit/finalize; harness balance-delta assertion (fails on shared accounts); full B4/E4; a case where the judge model actually runs (code-decided here).

## Gaps (cross-reference: DR1b, branch feat/dr1b, `harness/README.md` "Money check")
- **Balance-delta on shared accounts (fixed by DR1b).** `money.ts` now computes each party's credit from the escrow's own finalize/payout receipts for bet 18 (`creditsFromReceipts`) and asserts them equal to `expectedDecisive` to the yocto (`run/money_check.json`: taker 5728260869565217391304348, fee 306039130434782608695652, maker 0, 0 mismatches). The old maker/fee/escrow deltas in this run were confounded by other bets and are not an assertion. Per-account deltas stay a hard assertion for maker/taker on FRESH per-run accounts (`freshBettorAccounts`); bet 18 used shared accounts, so it is a receipts-only (legacy) check.
- **B4 SKIP (partly fixed by DR1b).** The recorder now captures `judge_evidence.json` and the NEAR AI attestation reports when supplied and records the remaining gaps in `b4_evidence.json`. The raw NEAR AI stream is NOT exposed by the resolver/OutLayer result (only its sha256 and the answer text), so B4 stays a PARTIAL SKIP until the resolver records the stream: see the DR1b B4 evidence finding (internal notes). The attestation report can be fetched keyless.
- Money.ts was committed in DR1 without a RED test; DR1b added `harness/test/perBetMoney.test.ts` (bet 18 receipts fixture) and a source-level guard in `test/dr1.test.ts`.
