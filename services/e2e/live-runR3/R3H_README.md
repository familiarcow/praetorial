# R3h (D-E2E1b): reclaim R3c escrow NEAR

Testnet only. (Scripts write via live-run16a/lib.mjs DIR, so results land in live-run16a/; file was moved here after the run.) `praetorial-r3c-11061912.praetorial-dev-1101.testnet` wiped (reused `../live-run16a/state-wipe`, sandbox tests 2/2 green) and DeleteAccount'd to `praetorial-dev-1101.testnet`.
Precheck: bets 1,2 Settled/VOID, 0 open offers, 6/6 payouts done, escrow mt USDC/BTC 0 (`r3h_precheck.json`). 19 state keys snapshotted (key + value sha256) in `r3h_results.json`, re-gated immediately before the wipe.
Balances, tx hashes and the post-wipe `view_state` count (0) are in `r3h_results.json`. Scripts: `r3h_precheck.mjs`, `r3h_snapshot.mjs`, `r3h_wipe_delete.mjs` (need `NEAR_RPC_URL`; keys read from `~/.near-credentials`, never printed/stored).
The trailing "account doesn't exist" receipt failure printed by near-api-js is the gas refund to the already-deleted account; the beneficiary transfer receipt is SuccessValue.
