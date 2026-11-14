# CF1e: testnet deploy of the 5 Workers + FRZ1b rehearsal (PARTIAL, see "Remaining")

Account subdomain: familiarcow.workers.dev. Escrow: praetorial-frz1b-2611081810.praetorial-dev-1101.testnet. Testnet only.
Workers: praetorial-{keeper,relayer,monitor,notifier,indexer}-testnet (1 cron `* * * * *` on keeper, shared dispatcher; 1 of 5 account triggers).
URLs: https://praetorial-keeper-testnet.familiarcow.workers.dev, https://praetorial-relayer-testnet.familiarcow.workers.dev, https://praetorial-indexer-testnet.familiarcow.workers.dev (monitor/notifier: workers_dev=false, service-bound only).
D1: praetorial-indexer-testnet (75385cf1-de6a-4bcd-9b6a-e495cfb26d2c), migration 0001_init applied remote.
Secrets (names only, via `wrangler secret put` from stdin): KEEPER_PRIVATE_KEY, RELAYER_PRIVATE_KEY, NOTIFIER_CONTACT_KEY. New testnet account relayer.praetorial-dev-1101.testnet (create tx BGDjwsdAsacrPocdn2Pt2joWiDKv9U4phA2yZpfWcGUr).

## Rehearsal flow txs (open_bet.mjs / cancel.mjs): web-built envelope, bet 1 on the FRZ1b escrow
- sourcecheck attest: 624KTT8A1k6K1aUKoYu7xqEdT67FFcATrUgACjeTsNeC (earlier attempt 44do9N4NLaiZNQxowzaUhXvpn7uAV1y1HEXXnFrnz1Gn failed in makerDeposit, no value moved)
- mint mock USDC: 9BN3tBM294dT5Dng5CtGugWUF7nd2HKafgKUJH5uw1ur; open: 9wwTXGnFSAhDXGAvcXEk12xeWUXbxncjAqqvgtLZcKK1 (bet 1 Open)
- indexer (D1) served bet 1 on /offers after POST /tick; cancel: BJUfctqp6sQjDsTA787PTHdvEAUHEQzHhRVK77kN9xmL (Cancelled)

## CPU via single-worker wrangler tail (CF1e2; tail/summary.json, tail/<worker>.json, summarize_tail.py)
One worker tailed at a time (collect_one.mjs). Limit 10 ms free plan; nothing hidden:
- keeper: 6 cron ticks (12 events): cron handler p50 1 / max 3; KeeperDO POST /tick p50 3 / max 3. (The earlier single-tick 10 ms was a cold start.)
- relayer: 14 GET /budget/global: worker p50 0 / max 1; RelayerDO p50 1 / max 2.
- monitor: 5 ticks: MonitorDO POST /tick p50 6 / max 7; outer service-bound fetch event outcome "canceled" 5/5 (cpu 0, wall ~2.4 s; caller does not await the response; DO events ok).
- notifier: 5 ticks: NotifierDO POST /tick p50 4 / max 5; outer fetch "canceled" 5/5 likewise.
- indexer POST /tick 11 ms x2 (tail/indexer_multitail.json) = RED, left for item CF1e3, not optimised here.
- tail/keeper_cron.json: raw single keeper event from the earlier run.

## FRZ1b bet 1 refund check (refund_check.mjs, read-only)
get_bet(1).status = Cancelled; pending_payouts(1) = []; pending_payouts_view(0,100) = one entry id 1, reason cancel_expire_refund, amount 10062783, done=true, in_flight=false, attempts 1.
maker mock-USDC 3894751412 -> 3904814195 (+10062783 = stake 10000000 + storage 62783); escrow's own mock-USDC balance 0. No stuck funds, no RED test needed. (The earlier "unchanged" reading was taken before the payout settled.)

## CF1e3 (branch feat/cf1e3, NOT merged: indexer budget test still red)
- Deployed (testnet) from feat/cf1e3: indexer, keeper, monitor, notifier, relayer (relayer carries RELAYFUND1/2 + FUND_TOKEN_CONTRACTS="usdc.testnet,wrap.testnet", WNEAR_CONTRACT_ID="wrap.testnet" in [vars]). praetorial-dev-1101 topped up 5 NEAR from faucet-created cf1e3-topup account.
- Evidence tail/cf1e3_*.json, cf1e3_summary.json (single-worker tails, 5 ticks each). Max CPU: keeper 4, relayer 3, monitor 7 (DO), notifier 5 (DO), indexer POST /tick 7..25 ms (final run: 7,9,11,11,16; earlier run 19,22,10,25,15). INDEXER STILL > 8 ms.
- Indexer cost is NOT batch-driven on testnet (1 bet read/tick = 5 subrequests, written 0, still 7-16 ms): fixed per-invocation cost (isolate cold start/module load + ~5 subrequests + 3 D1 round trips). Temp /diag probes: 5 raw RPC fetches = 2-4 ms, 5 PacedRpc views = 3-7 ms, so subrequests ~1 ms each.
- "canceled" outer events (monitor/notifier service-bound POST /tick): the dispatcher job returned after r.ok without reading the response body, so the runtime cancelled the open subrequest when scheduled() ended. Fixed via common pokeService (drains body, surfaces callee error). After redeploy: outer worker POST /tick outcome ok on 5/5 (cpu 0-1).
- Conflict: node-parity test `desync parity across steps` needs the default batch >= ~10-12 bets; budget test needs <= 6 at the 6.92x calibration. Neither weakened -> indexer deployed-equiv test stays RED (7.59 vs 7).
