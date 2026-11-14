# DR8: rehearsal-ai-challenge-round2 (btc_touch, duplicated bet, losing side challenges once)

Status: **WAITING** (phase `open` done: bet created through web "Duplicate this bet" and taken). Not merged.
Web https://praetorial-web-testnet.familiarcow.workers.dev. Escrow `praetorial-frz3-2611100414.praetorial-dev-1101.testnet` == apps/web/lib/network.ts on main.
Escrow checks: `git diff freeze-candidate-2 HEAD -- contracts/escrow/src` empty; `npx tsx DR8/pin.ts` -> `full_match: true` (8791413f...2473 == apps/web/lib/release.json).

## Scenario
- Source bet: frz3 **bet 5** (RFRZ2c btc_touch, Settled, same Privy maker 8941e607...81c7). Maker clicked **Duplicate this bet** on its payout screen (S17/FE-15; banner "Copied from your bet of 2026-11-10 UTC. Check the dates before you continue."), set threshold/deadline, settlement period **1h**, invite by link, source check passed, opened.
- **New bet 42**: BTC `at_or_above` **74100 USD** (spot 73782.26 at choice, +0.431%), window opens at the open click (~22:02Z), deadline **T = 2026-11-10T23:12:00Z** (70 min). Stake 3 NEAR (wNEAR) each side, odds 1:1, AI judge, no referee, maker side YES.
- Maker: real Privy login (OTP never logged). Taker: fresh implicit `00358cf7...103d` (balance 0 asserted before funding), key 0600 in `$PRAETORIAL_CACHE_DIR/scratch/dr8_taker_wallet.json`, claimed a username through the first-login dialog, took through the invite link.
- Ground truth (phase `challenge`): Coinbase+Kraken+Bitstamp 1-minute candles fetched by the harness at T+2 min, written to run/ground_truth.json BEFORE any outcome is read (DR1 `groundTruth.ts`; YES iff >=2 venues wick >= 74100 in [open, T)).

## Bond handling per D-ECON (committed offline in test/dr8.test.ts, GREEN before the live run)
Quote (`required_challenge_bond`) = max(min_bond, 10% pot) * 2^(round-1) + run_price. At finalize, per bond: challenger_won iff final outcome != round-1 outcome.
- **Round 1 stands** (challenger lost): bond - run_price -> counterparty (on top of stakes - fees), run_price -> keeper, challenger 0.
- **Flips** (challenger won): bond - run_price -> challenger, run_price -> keeper; stakes follow the final outcome. The extra reimbursement from the loser's stake applies only to VOID.
The README final section will state which happened and check it against ground truth.

## Tx table
| step | by | tx |
|---|---|---|
| mint wNEAR to maker | harness | GaSSnisqf3Z1RgLU4Akq6vnLpCcwKg4374LURwjd9UzQ |
| mint wNEAR to taker | harness | ChSvy5HzxmUP3MLVBC2gcufk1SFW4aCtB7nBjpP1fWTU |
| tNEAR to taker | harness | 6ozt9F7UVGeZPrZFuR3v4ijCpCgHD9q4KQpVJfhQYYAM |
| open bet 42 (duplicate) | web (maker) | 7SLrS9EjwUeTthmJV4XYW2Ck1bQG65R6bxnhDouktiNs (inferred from `txs.ts`: the web shows no open hash; the `mt_transfer_call` right before the take) |
| take | web (fresh taker) | B8tpp2BStcFm9Lta1tZzzdpjci8sucpa3huWMNKPo4tM |
| request_resolution (round 1) | keeper (KEEPSUBMIT1c); web taker button only as recorded fallback | pending |
| submit_outcome (round 1) | keeper | pending |
| challenge (S13, losing side, pays quoted bond) | web | pending |
| request_resolution / submit_outcome (round 2) | keeper | pending |
| finalize | web button after the window, else keeper | pending |

Balances after take (run/results.json): maker 119.0576 wNEAR, taker 1.9829 wNEAR (3 stake + storage out of 5.0 minted).

## Resume
```
cd ~/praetorial && git checkout feat/dr8
cd apps/web; set -a; . $PRAETORIAL_SECRETS_DIR/praetorial-privy.env; set +a
# 1) at/after 2026-11-10T23:14Z (touch the taker key first: scratch prunes idle entries after 24 h)
DR8_PHASE=challenge PLAYWRIGHT_BASE_URL=https://praetorial-web-testnet.familiarcow.workers.dev npx playwright test -c ../../services/e2e/live-DR/harness/playwright.live.config.ts --project=maker DR8.live
# 2) after the challenge phase finished (round 2 + window)
DR8_PHASE=finish ... (same command)
```
`challenge` phase: waits T+2 min, writes ground truth, waits for the keeper's request_resolution + submit (web fallback after 10 min), reads the round-1 outcome, determines the loser, reads `required_challenge_bond(42, loser)`, loser (taker: scratch wallet; maker: Privy login) uses S13 `challenge-btn` -> `challenge-confirm`, asserts bond on chain == quote. The challenge window is 1 h from proposed_at, so run it right after round 1 lands. `finish` phase: waits round 2, asserts outcome == ground truth, finalize (web/keeper), per-party money incl. bond (taker fresh delta hard; maker/fee from receipts), escrow method guard, then verifier (`services/verifier/final_step.sh`; 0 FAIL, no SKIP except E4; B4 asserted PASS, PARTIAL reported as the open PM question).

## Not yet proven
Everything after take: round 1 result, S13 screen behaviour, bond payment, round 2, finalize, money, verifier. The S13 screen's testids were taken from BetPage.tsx / ResolutionModals.tsx but never driven live; a missing/broken screen is a FINDING (web fix item), no direct-contract fallback.

## Final on-chain state (MISS1 salvage, read-only check 2026-11-13 ~05:51Z)

Salvaged onto main by MISS1 from branch `feat/dr8` (the run never merged). `run/chain_final_miss1.json` = `get_bet` view at that time (`spikes/miss1/chain_final.py`, view calls only).

- The challenge and finish phases never ran. Bet 42 on frz3 is **Settled VOID** (run 1, near-ai): code decided NO (3 venues complete, none crossed 74100) but the 17c5 audit disagreed twice, so the resolver refunded (COULDNT_CHECK). No wrong winner. Already recorded on main as `spikes/cs1/MAINNET-READY.md` item 7.
- Not proven by DR8: the challenge round 2 bond handling. It was exercised live by CS1's challenged case (bet 49, `spikes/cs1/CASE-STUDIES.md` "challenged").
