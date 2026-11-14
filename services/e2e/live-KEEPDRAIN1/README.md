# KEEPDRAIN1 live proof (testnet only)
- Root cause: the keeper Worker WAS running every minute and WAS draining, but only ONE action per tick (`maxActions=1`, shared by drain_payouts and resolution/expire actions). A backlog of N undone refund lines therefore drained 1 per minute (keeper_txns.json: bets 10-23 drained 09:23:30..09:37:30Z, one keeper `drain_payouts` at :30 each minute; the 09:27:13 / 09:31:40 drains were RLYDEP1's manual calls). A fresh bet's line waited behind that queue => "attempts 0 for >3 min". Secondary latent bug: the payout scan read at most 3x200 lines from id 0 and ids are never pruned, so an undone line past id 600 would never be seen.
- Fix (services/workers/keeper/src/tick.ts): drain_payouts has its own per-tick budget (`maxDrains`, default 4, env KEEPER_MAX_DRAINS_PER_TICK); persisted `payoutFloor` so the scan starts after the all-done prefix.
- Deployed keeper Worker version: **f3c2932e-6503-4251-8a84-f3c40999d75d** (praetorial-keeper-testnet).
- results.json: fresh maker, bet 26, cancel tx 5c9ZDHY2GZ4DpBFjoYQ88C54FLGViLTrr26ce299vUNU (10:48:38Z); keeper drain tx F4dcggSUYuUb7Qtm9WmLfqkcshuXcPKkUxYtGLvtSPPS (10:49:31Z, next tick, no manual drain; the proof script never calls drain_payouts). Maker USDC 0 -> 10062783.
- prefix_run_*: same flow on the pre-fix Worker (bet 25; drained in 45 s since the backlog was empty - the miss needs a backlog).
- tail_after.json / tail_after_summary.txt: `wrangler tail --format json` across the proof (5 KeeperDO /tick events, all ok, each with its scheduled `* * * * *` event). keeper_txns.json: keeper account tx list.
- Bets 10-23: no undone lines remained (all drained earlier); `node verify.mjs` shows undone=0.
- `NEAR_RPC_URL=<testnet rpc> node verify.mjs [--samples 5 --interval-s 60]` exits 1 if any payout line stays undone at attempts 0 over >3 consecutive minute samples.
- Re-run proof: `cd services && NEAR_RPC_URL=https://rpc.testnet.near.org node --import tsx relayer/scripts/keepdrain1_proof.ts`
