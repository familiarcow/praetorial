# live-KEEPSUBMIT1 (KEEPSUBMIT1b: merge + testnet keeper redeploy)

- Merge: feat/keepsubmit1 (c2aa07e5) + main merged in cleanly, then `--no-ff` into main = 81672313.
- Tests on the merged branch: services `npm test` 1393/1393 pass (includes keeper Worker tests), `tsc --noEmit` clean;
  `./test.sh fast`: escrow cargo, wasm-bin, services npm, tsc, web npm, web e2e (mocked), conformance, verifier fixture, release record all PASS.
  rte4b / redteam_evidence / rte4c steps FAILED in the harness ONLY because the harness python lacked `cryptography`
  (ModuleNotFoundError); run with the venv python3 they pass (rte4b parity PASS, redteam_evidence 26 pass 0 red, rte4c PASS).
  Environment issue, not a code red.
- Deploy: `scripts/deploy-testnet.sh keeper` -> praetorial-keeper-testnet, Version ID d07dba8b-a06c-4bb9-9b85-a24ff40d4e47, cron `* * * * *`.
- ESCROW_CONTRACTS (wrangler.toml): frz3-2611100414@v1, frz2-2611091914@v1 (current + frz2).
- Health: {"ok":true,"service":"keeper","network":"testnet","escrow_contract_id":"praetorial-frz3-2611100414...","git_sha":"81672313b79a","last_tick_at":"2026-11-10T15:16:27Z"} (ticking every minute).

## Live relay proof: NOT yet observed
frz2 bets 25 and 26 are Resolving with pending_run_no=1 and a stored SIGNED result (outcome VOID). The pure planner
(`planOutcomeRelay`) run on their on-chain state returns ok=true for both, yet after >=4 ticks post-deploy (~15:12-15:18 UTC) both are
still Resolving. Bet 18 (frz2, Proposed) was skipped as expected. wrangler tail showed only "Ok" ticks (no error logs; failures surface as notifier alerts).
OPEN: either the relay tx fails on-chain (e.g. resolver key / signature mismatch on frz2) or discovery is not reaching these ids. Needs investigation
(KEEPSUBMIT1c); proven path otherwise deferred to the next AI bet (DR3).

## KEEPSUBMIT1c (branch feat/keepsubmit1c): fair-share discovery fix, NOT yet merged/deployed
- Root cause confirmed in tick.ts: one shared maxViews=8 budget iterated contract by contract; frz3 consumed it (known reads + frontier probe re-reading the same missing id up to 3x), frz2 got ~1 view, so frz2 bets 25/26 were never read.
- Fix: per-contract fair share floor(viewsLeft/remaining contracts) (leftover flows to later contracts), 1 reserved frontier probe, probe stops at first miss.
- Tests: RED commit then GREEN; keeper Worker tests 30/30, keeper budget tests (cpuBudget + miniflare budget) 3/3, services npm 1406/1406, tsc clean, ./test.sh fast 12/12 PASS (on branch, main 3cc31f6a merged in).
- Merge BLOCKED: .queue/MERGE.lock held by the LAND1 build agent from 11:45 to past 12:17 EST (main moved to 44e03a7c meanwhile); 50-minute limit reached. Not merged, keeper not redeployed, live proof for frz2 bets 25/26 NOT done.


## KEEPSUBMIT1c LIVE PROOF (2026-11-10, track A) -- MERGED + DEPLOYED
- Merged feat/keepsubmit1c into main as 65707bf7 (b0nd, --no-ff) under MERGE.lock; main merged into branch first (89f611e4). contracts/escrow/src diff vs 6e33faa: empty.
- Tests on merged branch: keeper worker 30/30; budget files 10/10 (one first run showed `failed: 1`, a CPU-timing flake; reran 0 failed); services npm 1418/1418; tsc clean; ./test.sh fast 13/13 PASS.
- Deployed ONLY testnet keeper: praetorial-keeper-testnet version 00c524a3-81db-4a2e-ad6d-5d67cfb1f838.
- Live: within one cron tick after deploy the keeper relayed frz2 (praetorial-frz2-2611091914.praetorial-dev-1101.testnet) bets 25 and 26 (were Resolving with stored signed VOID):
  submit_outcome signer keeper.praetorial-dev-1101.testnet, success:
  - BW3gCsj3UJiMv1bejEh5WoDQ7qNXpMHPEXUoVVJe4QwD (12:54:32 EST)
  - 7cW7AZkg5PU4MhQPxk71LvEdKGiKvm7YWL4JGy6U5GvS (12:54:34 EST)
  get_bet 25 and 26 now: status Proposed, outcome VOID. (Per-tx bet id mapping not decoded.)
- Also observed keeper `finalize` tx EkMbnyrDyr6s6Nh3iz6JFYdZ7vyLTHeSCmPvx8Wn8Fxv at 12:55:32 on the same contract (bet id not decoded).
- No FINDING: no signature/key mismatch.

### KEEPSUBMIT1d: tx -> bet mapping (decoded via EXPERIMENTAL_tx_status, 2026-11-10)
- BW3gCsj3UJiMv1bejEh5WoDQ7qNXpMHPEXUoVVJe4QwD = `submit_outcome` bet **25** (VOID, run_no 1).
- 7cW7AZkg5PU4MhQPxk71LvEdKGiKvm7YWL4JGy6U5GvS = `submit_outcome` bet **26**.
- EkMbnyrDyr6s6Nh3iz6JFYdZ7vyLTHeSCmPvx8Wn8Fxv = `finalize` bet **18** (DR1 bet; events bet_finalized 18, payout_done [48,49],[50,51]; paid taker 5.728 NEAR, fee 0.306 NEAR). Keeper relay -> finalize is therefore proven end to end live.
