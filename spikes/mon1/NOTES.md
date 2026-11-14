<!-- MISS1: salvaged 2026-11-13 from an uncommitted worktree leftover (fix/mon1). The code it describes is on main (7f3701b5, 099d1114). -->
# MON1 — stuck in-flight payout alert (2026-11-10)

Closes the detection gap in PREMAIN1 MAINNET-RISK #1 (`spikes/premain1/REDTEAM-STATUS.md`): the frozen escrow has no
timeout for a payout line left `in_flight=true` (if `on_payout_result` ever ran out of gas). Contract unchanged; this is
detection only. A new escrow version is the only real fix.

## What was built
- `services/monitor/src/stuckPayouts.ts` (shared core, node monitor + monitor Worker):
  - `scanUndonePayouts`: pages `pending_payouts_view` (500/page, at most 10 pages per tick) from the oldest line that was
    not done last time. Ids are dense and never pruned (lib.rs `pending_payouts_view`), and `done` is terminal, so a settled
    ledger costs one short page per tick. This also reads lines past id 500. The older invariant sweep only reads
    `{from:0,limit:500}` (see "Not changed").
  - `StuckPayoutTracker`: first-seen clock per entry (`id:attempts`, so a retried line that wedges again is a new entry).
    It raises ONE `payout_stuck_in_flight` CRITICAL per entry once the entry has been seen in flight >= threshold. The
    message has the bet id, amount and asset; the detail adds payout id, receiver, reason and attempts.
  - A read failure or a truncated scan raises `payout_stuck_in_flight_unchecked` (warning). Failure is never treated as OK.
- `runnerCore.runAlertTick`: optional provider hook `fetchUndonePayouts`. Wired in the node `buildLiveProvider` and in
  `MonitorDO`. The DO keeps the tracker state + scan cursor in SQLite, so restarts neither reset the clock nor re-send.
- Config: `ALERT_STUCK_PAYOUT_MS` (default 600000) in the testnet `[vars]` and `[env.mainnet.vars]` of
  `services/workers/monitor/wrangler.toml`, and in the `monitor:alerts` serviceEnv row. No mainnet deploy.
- Each Worker tick returns a `payouts` summary in the tick JSON and logs one JSON line (`msg: "monitor payout scan"`), so a
  live poll can be seen even when nothing is stuck.

## Threshold: 10 minutes
Measured on frz3 (9 real drain_payouts / finalize / concede txs, archival RPC): tx block -> `on_payout_result` block =
3 blocks, 1.5-2.0 s every time. 10 min is about 300x that, so delayed receipts under congestion or a slow RPC will not
fire it. A really wedged line is reported within ~11 min (1-minute dispatcher tick). Age counts from the monitor's first
sighting, so a monitor outage can delay an alert but cannot cause a false one.

## Tests (RED first)
- `services/monitor/test/stuckPayouts.test.ts`: the real-shape fixture `fixtures/pending_payouts_view.frz3.testnet.json`
  (keyless `pending_payouts_view({from:0,limit:500})` answer from frz3, block 277128728, 53 lines, all done), the same
  fixture with one line wedged, the threshold boundary, retry = new entry, export/import, paging past 500, the page
  budget, and runAlertTick (once across cooldowns, unchecked).
- `services/workers/monitor/test/stuckPayouts.test.ts`: DO end to end (Telegram delivery, restart, no repeat), override,
  unchecked, node/Worker parity, wrangler testnet+mainnet entries, tick summary.
- RED: core module missing (ERR_MODULE_NOT_FOUND); Worker 0/5 pass. GREEN after the implementation.

## Not changed (noted)
- The existing invariant sweep (I-1/I-2/I-4) still reads only `pending_payouts_view({from:0,limit:500})`. Once the
  ledger passes 500 lines, those invariants stop seeing newer lines. This is pre-existing and out of MON1 scope; it is a
  follow-up.

## Live (testnet only)
Deployed `praetorial-monitor-testnet` only, via `services/workers/scripts/deploy-testnet.sh monitor`:
first 41838195-990c-45f5-89b9-33a6b9437eda (git 7f3701b5), then 7ff04301-72ea-4a08-a3bd-7a18bdccfc36 (git_sha 099d11141670,
which adds the tick summary). `wrangler tail` captured 2 dispatcher ticks, both `outcome: ok` with no exceptions:
```
1794350011840 POST https://monitor.internal/tick ok {"msg":"monitor payout scan","escrow":"praetorial-frz3-2611100414.praetorial-dev-1101.testnet","payouts":{"scanned_from":54,"next_from":54,"undone":0,"in_flight":0,"complete":true}}
1794350070796 POST https://monitor.internal/tick ok  (same summary)
```
`scanned_from: 54`: an earlier tick on the new version had already read lines 1..53 (all done, matching the fixture) and moved
the cursor past them. frz3 has no line in flight now, so no alert was expected.
