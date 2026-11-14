# DR4 rehearsal-custom-any-page-ai — STATUS: WAITING (judge result pending; finalize needs +1 h settlement window)

Bet **25** on `praetorial-frz2-2611091914.praetorial-dev-1101.testnet`, deployed web `https://praetorial-web-testnet.familiarcow.workers.dev`.

## Scenario
- Built in the S3 custom builder (card `bet-type-card-custom`), real Privy login for the maker, taker via invite link (Node-side signing).
- Messy wording, verbatim from the L1 set (`live-L1/examples.json` `range_breakout_no`, "BTC stays below $X for the whole session"): a custom-kind case the builder ACCEPTS (unlike `flips_100k_messy`, `pct_up_day`, `friday_custom`, which it refuses). Only the level X was substituted ($74690 = Coinbase spot 74598.82 + 0.122%). Wording not hand-cleaned. The offline test asserts the real `builderGate` accepts it.
- Two distinct sites (D-TPL1): Coinbase BTC-USD candles + Bitstamp btcusd OHLC. S6 preflight on both shown: "The AI can read these sources. Checked at 06:54 UTC", sourcecheck Worker 200, unreachable [].
- Window 06:58–07:08 UTC, evidence cutoff 07:10 (shortest the builder allows: offer expires at event start), settlement window 1 h per round.

## Txs
| step | tx |
|---|---|
| orphan bet 24 cancel (failed attempt 3, cancelled via web) | 5jyD4odeRmdfxqcszb72gvTQBTUjNMyS2jL9iC9ALZnf |
| open bet 25 (web, maker) | ANMaWWoKSGv5PMpGTVQQwyohkK6u6tpA7haD3F6nunxb |
| take (web, taker) | 4ZjvNFSzDpcHW2qVWYFw3EJVRpJ7qA4cmgEEAH3Y783x |
| request_resolution (web, taker relay response; UI tx text not captured) | 6rh32jwK68qywrb4hrvA1KgkLauzXX4w2G2XseKyzmGR |
Earlier orphans from failed attempts (bets 23) cancelled likewise; see `run/results.json` (txs, balances_before/after_take).

## Ground truth (written 07:1x UTC, BEFORE request_resolution and before any outcome was read; `run/ground_truth.json`, raw pages `run/raw_coinbase.json`, `run/raw_bitstamp.json`)
Expected outcome **YES**: max 1-min candle high in window Coinbase 74684.18, Bitstamp 74683.50, both < 74690 (10 candles each). Margin is thin ($5.8) but real; the judge is not told.

## Status at hand-off
Bet is `Resolving` (request_resolution landed ~07:15Z), judge outcome not yet on chain (>20 min). Finalize requires the 1 h settlement window after the judge result.
**RESUME** (after finalize time, i.e. judge result + 1 h; check `get_bet 25`):
`cd ~/praetorial-wt/overnight/apps/web && set -a && . $PRAETORIAL_SECRETS_DIR/praetorial-privy.env && set +a && DR4_PHASE=finish ALARM=5400 bash $PRAETORIAL_CACHE_DIR/scratch/run_open_dr4_0142.sh`
(resume guard: reuses the written ground truth, does not re-send request_resolution when status != Taken; the original finish run may still be alive and complete by itself.) Then `services/verifier` with the bet id, compare to `ground_truth.json`, merge only if green.

## Tests
`test/dr4.test.ts` 12/12 (money YES/NO/VOID, ground truth YES/NO/VOID-on-disagreement, builder-gate acceptance, SKIP set, tx guard). Spec was written and committed before the live run.

## Findings / notes
- First-login username step renders after nav: first attempts skipped it by race (spec bug, fixed; claim a name, Skip only if offered).
- Judge latency: >20 min from request_resolution to outcome for a window already closed (observation, not a verdict).
## Proves / does not prove
Proves: messy custom wording accepted by builder, 2-site preflight, open+take via deployed web, independent ground truth ordering. Does not (yet) prove: judge outcome/payout/verifier.

## Final on-chain state (MISS1 salvage, read-only check 2026-11-13 ~05:51Z)

Salvaged onto main by MISS1 from branch `feat/dr4` (the run never merged). `run/chain_final_miss1.json` = `get_bet` view at that time (`spikes/miss1/chain_final.py`, view calls only).

- The finish phase never ran. Bet 25 on frz2 is **Settled VOID** (run 1): `judge_backend` **offline-mock**, because the OutLayer secret was not bound for that escrow (known: TESTING.md "DR4 bet 25 ran unbound and got offline-mock"). Ground truth was YES (both venues below 74690), so this is a **false VOID, not a wrong winner**; the VOID path refunds both stakes (amounts not re-checked by MISS1).
- Not proven by DR4: the AI judge on a custom any-page bet. The near-ai binding was fixed afterwards (bet 26, same TESTING.md line).
