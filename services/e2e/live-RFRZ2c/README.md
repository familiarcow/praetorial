# RFRZ2c + RFRZ2d (testnet-ai-bet-wnear on frz3): STATUS COMPLETE (RFRZ2d finished the evidence)
Escrow `praetorial-frz3-2611100414.praetorial-dev-1101.testnet`; `git diff freeze-candidate-2 HEAD -- contracts/escrow/src` empty; `resolver_keys()[2]` == release.json `8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473` (full 64).

## Done (live, deployed web, Privy maker, test-wallet taker, no NEAR AI)
- Bet **5**: AI btc_touch at_or_above $1,000,000, window 6 h (> 5 h), stake 3 NEAR/side as nep141:wrap.testnet. Opened via the web; live sourcecheck PASSED ("The AI can read these sources.", `run/results_run3_*.json`). Review card storage line = `0.01716 NEAR`, pay now `3.01716 NEAR` (screenshot `run/review_card_storage_line.png`, from run 1 — same card).
- Taker took via the maker's personal invite link: tx `7ruVaBTBwQbkZiFv9ZmPfNdfUqeb5yRvGyxuBaJVAusv`. Taker conceded via the S12 modal. Chain: bet 5 `Settled`, outcome YES, `is_fully_paid` true, `pending_payouts` = [] (all legs done).
- Mints (harness faucet): maker `BfrFdebJYQ6M1rR6EjEvnHZ3qw8VW1AkZuJVEJCSgDBp`, taker `CxK4PNYE4mxuuExfWDPF9RAqRU9GrLJmdBU2zrGqAMpn`. Dev account had 2.48 NEAR, no top-up needed.
- `verify-bet --offline` bet 5 (`run/verify_bet5.txt`): 4 PASS (E2,E3,B1,B2), 0 FAIL, 6 SKIP (E1 no hash passed, E4 offline, B3-B6 no ruling: concede, no NEAR AI call).
- Offline TDD test `test/rfrz2c.test.ts` (4 pass), plan.ts; wired into services `npm test`.

## RFRZ2d: finish (chain evidence, money, verifier, orphan cancels)

### Tx table (all on `praetorial-frz3-2611100414.praetorial-dev-1101.testnet`, recovered from fastnear tx history, receipts inspected)
| Step | Tx | Signer -> receiver | Evidence |
|---|---|---|---|
| open bet 5 (maker, web, relayer delegate) | `47FMvXjQCxRvv1ZWY7KyBFXrbdWK6ULyjWgCQwZ1ERaD` | relayer -> maker implicit `8941e607...` (Delegate: intents-mock `transfer_with_msg`) | `mt_on_transfer` -> `bet_opened` bet_id 5, storage 0.01716 |
| take bet 5 (taker, invite link) | `7ruVaBTBwQbkZiFv9ZmPfNdfUqeb5yRvGyxuBaJVAusv` | relayer -> taker implicit `763be141...` | from previous run |
| concede bet 5 (taker, web S12 modal) | `4tWw9wUhpHnfAoKxAA1jdRVzmnZ85ZMYwmycEk2UB4Np` | relayer -> taker implicit | `bet_conceded` + `concede` events, bet 5 |
| payouts bet 5 | same tx `4tWw9w...` receipts (no separate drain tx): 2 x `intents-mock.mt_transfer` (maker, fee account) + 2 x `on_payout_result` -> `payout_done` payout_ids [2,3] and [4,5] | escrow -> intents-mock | `pending_payouts` = [], `is_fully_paid` true |
| open bet 4 (orphan) | `H8J8dWKbf8TGBjuscrCNEonUpaJcMzxUFxfdqMhnstBq` | relayer -> maker | `bet_opened` bet_id 4 (stake 2.75 NEAR, not 3) |
| cancel bet 3 (orphan) | `3atkQuXzig4nNN5tyM2iRz3d9DwgQh7zryivhAuyAFNS` | relayer -> maker | `bet_cancelled` bet 3. Already done by the earlier "timed out" cancel run (the task brief said it was still open: stale); refund drained by keeper `drain_payouts` `4xHo9WqiD1ySsy8mLFcRyFdxcYbUPz1MAEmR9nmkr57Q` |
| cancel bet 4 (orphan, this run, web) | `9T5bV91eri1VGoSwU722oAujGe8TTX63WubZYcpJw7cE` | relayer -> maker (`cancel`) | status Cancelled, refund drained by keeper `drain_payouts` `BMAPe52EzUf9Xu9HsyY9iKJZ9dNkE8F7QccwkFchZQdm` |
| faucet mints | maker `BfrFdebJYQ6M1rR6EjEvnHZ3qw8VW1AkZuJVEJCSgDBp`, taker `CxK4PNYE4mxuuExfWDPF9RAqRU9GrLJmdBU2zrGqAMpn` | | |

Not ours: keeper `request_resolution` txs (09:25-09:32 and 11:46-11:49) all fail "too early to request resolution" on bets that are not bet 5's ruling path (bet 5 has window 6 h, `used_run_nos` [], `runs_used` 0, no `submit_outcome`). Bet 5 has no resolution run, so no NEAR AI call.

Harness capture bug (fixed test-first): `finish.live.spec.ts` read `getByTestId("concede-tx")`, an element the web never renders (BetPage only has `concede-result`), so the concede tx was `null`. Fix: `findTxByMethod(hist, "concede")` from chain history (`plan.ts`, RED test in `test/rfrz2c.test.ts` then GREEN). `chaincheck.ts` re-derives everything post-hoc from chain.

### Balances (wNEAR raw, `intents-mock.mt_balance_of`, `run/chaincheck_bet5.json`)
| | before bet 5 | after take | final | delta take->final | expected (offline test) |
|---|---|---|---|---|---|
| maker | 106604620038565760869565228 | 103587460038565760869565228 | 109315720908130978260869576 | +5728260869565217391304348 | +5728260869565217391304348 |
| taker | 26065680000000000000000000 | 23048520000000000000000000 | 23048520000000000000000000 | 0 | 0 |
| fee account | 1852944782608695652173912 | same | 2159003913043478260869564 | +306059130434782608695652 | +306059130434782608695652 |
| escrow | 8309565000000000000000000 | 14343885000000000000000000 | 8309565000000000000000000 | back to before (residue 0) | residue 0 |

`moneyMismatches` = [] (asserted in code). Net for the maker vs before open: +2.7111 NEAR (won 3 minus fee, storage refunded via the fee account rule: fee account keeps both storages, per `expectedConcedeByTaker`). Conservation: maker + fee = 2*3 NEAR + 2*0.01716 NEAR.

### Verifier (live, with OutLayer homes; `run/verify_bet5_live.txt`)
`verify-bet --network testnet --escrow <frz3> --bet 5 --expect-escrow-hash caf134a4...450f2f --outlayer-home-escrow olhome-frz3 --outlayer-home-attest olhome-frz2-attest`: **6 PASS (E1 E2 E3 E4 B1 B2), 0 FAIL, 4 SKIP (B3, B4, B5, B6)**. E4 is live (pinned wasm report-pubkey reproduces the bound outcome and attest pubkeys). B3-B6 SKIP because a concede ending has no ruling (no `request_resolution` input_data, no `last_resolution_raw`, no `proposed_at`), allowed by D-DR1c. `services/verifier/final_step.sh <run-dir>` was NOT run: it needs a recorder evidence dir built from a proposal/raw resolution that a concede never creates (same reason as DR6); `verify-bet` live is the equivalent and strictly stronger than the earlier `--offline` (adds E1 and E4).

### Screens touched
Login (Privy email+OTP), username step, create offer (btc_touch guided form, odds, invite-by-link), review card (storage line 0.01716 NEAR, pay-now 3.01716 NEAR, source check), share screen, take flow (take-open, take-next, take-confirm), bet page, S12 concede modal, cancel-bet / cancel-confirm (own open bet).

### D-SRCCHK3 live proof
The review card's live "Check sources" ran against the deployed web before the open button enabled and returned "The AI can read these sources." for the btc_touch terms (`run/results_run3_*.json`), and the review card showed a real storage amount (`storageLineIsReal` test) instead of the placeholder.

### What it proves / does not prove
Proves: a real AI-judged wNEAR bet with window > 5 h can be created through the deployed web by a real Privy maker, sourcechecked, taken, conceded and settled on frz3 with exact money (maker, fee, taker, escrow residue 0) matching the frozen rules; the escrow is the pinned build (E1) with live E4; own open offers cancel with a full refund and no fee.
Does not prove: a judge ruling (no NEAR AI call), B3-B6, challenge/referee paths, taker's real Privy login (test-wallet seam), mainnet intents, the `final_step.sh <run-dir>` path.

### Other observations
- Task brief said bets 3 and 4 were both open; bet 3 was already Cancelled by the earlier cancel run. Bet 4 stake is 2.75 NEAR.
- Relayer RELAY500 on Move-to-betting-balance did not block cancel (web track).
