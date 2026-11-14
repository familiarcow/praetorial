# DR9 rehearsal runbook drills (testnet only, D-DR1/D-DR1b)
Branch feat/dr9, escrow wasm = freeze-candidate-2 (caf134a4, `git diff freeze-candidate-2 HEAD -- contracts/escrow/src` empty). No contract/resolver/web change, no new escrow method, no NEAR AI spend. Full tx table: `run/txs_recovered.md`.
Offline tests (written first): `test/dr9.test.ts` (expected refunds per party, verdict rules, pause window, README rule), `test/alertOffline.test.ts` (MON4 alert generation with a fake token).

Drill 1: PASS tx BPL13JHThjQYpSJxEv7ZSsAxKWEnvGNQhqjw9waf4s3P (pause) / GY2ZbMcXPPMRoodMVK5ueBiXomYN4f6XG1r4ERykHpvh (unpause)
Drill 2: NOT-DRILLED (missing ALERT_TELEGRAM_BOT_TOKEN in $PRAETORIAL_SECRETS_DIR/praetorial-alerts.env; ALRT1, familiarcow step)
Drill 3: PASS tx 6pcNsR5sQgKdqzgqeRR2eBk4BnTQGBkq7yBgT8DNR7YY (retry_payout) / BDMLYRCUA6LUmuQy37ZicqEWp3ESGMs6GLHDffC7wgor (drain_payouts)
Drill 4: PASS tx CnEg1hPXuKCX7ajzSD7CQ2V5V9BY4iK7ETxrKqNCSVt2 (emergency_shutdown) / 9eFCzZfAkG1gKBiuYDGiZhstWitgkuZuFtBurKtoQXpW (emergency_refund); verifier 0-FAIL gate NOT MET (see below)

ACTION NEEDED: alert bot token (drill 2).

## Drill 1: guardian pause_new_offers while a bet is Taken (frz3 praetorial-frz3-2611100414)
Script `drill1.mjs` (all attestations prepared before the pause; unpause in `finally`). Bet 44 (created for the drill, maker1/taker1, 10 USDC mock each) was Taken, then guardian arbiter1 paused (`is_new_offers_paused` true by view).
- Paused banner on the deployed web (`banner-paused`, screenshot `run/drill1_paused_banner.png`): "New bets are paused. You can't make or take a bet right now; bets that are already live carry on as normal."
- A new Open deposit while paused was refused by the contract: bet_count 44 -> 44, maker and escrow intents balances unchanged (silent full refund). The web Make-bet button is `disabled={paused||shutdown}` (App.tsx) and covered by the banner.
- The Taken bet settled while paused: maker conceded (free, no NEAR AI); taker +19000000 and fee account +1145144, both exactly the offline `concedeCredits` expectation; status Settled.
- Unpaused: window 26.5 s (< 10 min), `is_new_offers_paused` false by view after the unpause tx. Bets 33/35/42 untouched.
Proves: pause refuses new Opens (UI + contract) while a Taken bet still settles; unpause restores. Does not prove: that an AI-judged Taken bet resolves while paused (would spend NEAR AI; concede is the contract's free ending).

## Drill 2: monitor Telegram alert (NOT-DRILLED)
`$PRAETORIAL_SECRETS_DIR/praetorial-alerts.env` does not exist, so there is no ALERT_TELEGRAM_BOT_TOKEN: no real delivery was attempted. Offline only: `test/alertOffline.test.ts` shows a 402 run result from a fake TEST key produces the MON4 `nearai_credit_exhausted` alert and `TelegramAlertChannel` posts it to `api.telegram.org/bot<token>/sendMessage` for the operator chat (mock fetch, fake token). That proves generation and request shape, not delivery. No real NEAR AI key was touched.
Finding F-DR9-1: a REVOKED key normally returns HTTP 401 "invalid api key"; MON4's rule (402, or a 4xx body naming insufficient/credit/quota) gives NO alert for that (pinned by a test). When ALRT1 lands, force the drill with a 402-shaped failure or widen the rule (monitor change, out of scope here).

## Drill 3: stuck payout, retry_payout / drain_payouts (throwaway escrow)
`emergency_refund` only SCHEDULES payout lines (attempts 0, not done, not in flight); money moves when a keeper drain runs. The throwaway escrow had no keeper loop, so the three refund lines sat unpaid: a genuinely delayed payout with no contract change and no failure injection. `finish_d34.mjs`: `retry_payout(line 1)`, then `drain_payouts(bet 1)` and `drain_payouts(bet 2)`; afterwards `pending_payouts` empty and `is_fully_paid` true for both bets.
Proves: the runbook's retry_payout and drain_payouts commands work on delayed lines. Does not prove: recovery from a FAILED in-flight transfer (needs `set_fail_mt_transfer` on a private mock-intents; a private mock was built but the testnet funder ran out of NEAR before deploying it; that path is covered by chaos/scenarios/drain_payouts.mjs).

## Drill 4: emergency_shutdown + emergency_refund (throwaway praetorial-drill9-2611102218.praetorial-dev-1101.testnet, NOT frz3)
`setup_d4.mjs` / `drill4.mjs` / `finish_d34.mjs` / `reclaim.mjs`. Deployed the freeze-candidate-2 wasm (sha checked against release/freeze-candidate-2.json), init args = frz3's except guardian = fresh throwaway account. Bet 1 Taken (m2/t2), bet 2 Open (m3), 10 USDC mock per side.
- Refused as expected: non-guardian shutdown ("only guardian"), emergency_refund before the shutdown, unpause after the shutdown, second shutdown ("already shut down").
- `emergency_shutdown` by the guardian is IMMEDIATE (no timelock); both bets became Voided.
- Refunds per party == offline expectation (stake + own storage, no fee): m2 10072572, t2 10072572, m3 10072572; escrow intents balance 0; fee account delta 0. No mismatches.
- Reclaim per D-E2E1a: 11 state keys wiped with `live-run16a/state-wipe` (self-only), 0 keys after, escrow DeleteAccount to dev (+6.49 NEAR to dev together with the 4 throwaway accounts), account no longer exists.
- Verifier: `final_step.sh` offline needs a recorder evidence dir (resolver run), which a drill escrow has none of; `verify-bet --live` reports **E2 FAIL "contract is_shutdown() is true"** by design (`run/final_step_live_bet1.txt`, `run/verify_bet1_offline_flag.txt`: E1 PASS with the freeze hash, E3/B1/B2 PASS, E2 FAIL, E4 FAIL live without OutLayer homes / SKIP offline). So "final_step.sh 0 FAIL on the drill-4 run dir" is NOT met and cannot be on a deliberately stopped escrow without a verifier change (E2 should treat a shutdown as expected for a drill dir). Orchestrator decision needed; the account is deleted so the live run cannot be re-verified, a rerun (DR9b) would be needed.

## Findings
- F-DR9-1 above (revoked key 401 produces no MON4 alert).
- F-DR9-2: the shared testnet funder (praetorial-dev-1101) was at ~0.18 NEAR and the faucet endpoints were unreachable, so keeper (1.27 NEAR) funded it. Top up dev before the next live item.
- F-DR9-3: a stale-save bug in my first scripts clobbered the tx log; fixed in lib.mjs, hashes recovered from the fastnear index.

## Final on-chain state (MISS1 salvage, read-only check 2026-11-13 ~05:51Z)

Salvaged onto main by MISS1 from branch `feat/dr9` (the run never merged). `run/chain_final_miss1.json` = `get_bet` view at that time (`spikes/miss1/chain_final.py`, view calls only).

- Drill 1 bet 44 on frz3 is **Settled NO** (maker conceded), as the README says. Drills 3 and 4 ran on a throwaway escrow that was deleted (reclaim), so there is nothing left on chain to re-check.
