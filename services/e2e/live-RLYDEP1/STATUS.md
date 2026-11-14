# RLYDEP1 testnet proof (testnet only, $0 beyond testnet gas)
- Redeploy: `praetorial-relayer-testnet` from commit 6f5f4e9 (main 899d41f + RLYDEP1 helper tests; relayer code identical to 899d41f) with the unchanged toml vars. Worker Version ID **cf14de04-754d-40ff-95df-faa9c3a3e2e3**, https://praetorial-relayer-testnet.familiarcow.workers.dev. Secrets were not touched (persist across deploy).
- results.json (run 2, ok=true), bet 23 on the frz1b escrow, fresh implicit maker 9f70ae05...ccf7e, referee arbiter1 -> keeper (Human):
  - (a) open tx 5NZr54pE4BuYzgkpHjwfneXXr4arQUvCjfT8jC38eHTJ
  - (b) relayed amend_referee (deposit 0) via the Worker: 8PyMgfMh3qVT5fF3vkSzFoXE1cRkaM4Zyk1HpHiMmeMs; get_bet referee changed to keeper.
  - (c) extra-key amend_referee: HTTP 400 `amend_referee args contain unexpected field "extra"`, relayer key nonce unchanged (no broadcast), referee unchanged.
  - (d) relayed cancel B7q9EdHxgrCGF19KPQ1SwqbiroxPC7GwwSVjLah33qrv -> Cancelled; maker mock-USDC 0 -> 10062783 (= deposit); no undone payout line for the bet.
- FINDING: the keeper cron did NOT drain the cancel_expire_refund payout line within 3 min (attempts 0; also lines 10..21 of other bets undrained at 09:25Z). The script then calls the public `drain_payouts` (anyone may): tx FFZ5axcCHNhM6sJ2QVBJLf9m5PeiFY7F6i7UCgNUf3Yu, refund settled. Not a relayer bug; the keeper Worker's payout draining on testnet needs its own look (new item).
- run1_results.json: first run (bet 22): steps a-c and cancel passed; its refund check failed only because the script then did not wait/drain; bet 22 was drained manually afterwards (tx 4K9KFeL5yjRL3su7spFmjAKJvCjGovexhP8Z8pn3mThw), maker 10062783. Run-1 txs listed inside.
- Re-run: `cd services && NEAR_RPC_URL=<testnet rpc> node --import tsx relayer/scripts/relayref1_proof.ts`
