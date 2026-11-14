# Mainnet night GAPS (MAINPREP1, 2026-11-10)

Everything NOT ready for tonight. BLOCKER = the RUNBOOK cannot pass the named step without it. can-wait = fine for an unlisted
launch tonight, must close before the URL is shared/listed (or later). Verified facts come from read-only mainnet views and local
dry runs listed in RUNBOOK.md; nothing was signed or deployed on mainnet.

## BLOCKERS

| # | Gap | Blocks step | Owner | How to close |
|---|---|---|---|---|
| B1 | **GO (GATE-11)**: familiarcow's written "GO" | 4 onward (every mainnet tx/deploy; scripts check `PRAETORIAL_MAINNET_GO=GO`) | FAMILIARCOW | say "GO" in writing |
| B2 | **GATE-09 capped NEAR AI key**: a `NEAR_AI_RESOLVER_KEY` line exists in `$PRAETORIAL_SECRETS_DIR/praetorial-nearai.env` (count 1, value not read), but nothing confirms it is the separate spend-capped key | 10 (bind); without a bound key the resolver emits no outcome (NOKEY1) so T4 cannot settle | FAMILIARCOW | create/confirm the capped key on cloud.near.ai, save as `NEAR_AI_RESOLVER_KEY`; `40-bind-secret.sh` refuses if it equals the general key |
| B3 | **Key signing (D-KEYS2b)**: the BOT signs every remaining tx from key files (`owner-temp` on `praetorial.near`, `bets`, `aikey`, `ops`, `attest`, `keeper`, `relayer`); familiarcow signs only the final delete of the temp key on `praetorial.near` (his paper phrase at the prompt, RUNBOOK step 15a) | 15a | FAMILIARCOW (one delete-key), BOT | temp key 6eWbyxb8 seen on chain by view 2026-11-10 ~20:07 (Mac mini clock) (`15-keyfile-steps.sh preflight` PASS) |
| B4 | **Money**: CLOSED (view ~20:07): `praetorial.near` was funded to 7.04 NEAR; after step 3b (6.3 NEAR to bets./aikey.) it holds 0.73 NEAR (guardian gas reserve) | 3b | FAMILIARCOW | done |
| B5 | **Privy allowed origin** `https://praetorial.com` on app `cmw1b5stc01q60glap4q18que` | 16-17 (login on the mainnet web) | FAMILIARCOW | RUNBOOK step 16 item 1 |
| B6 | **Accounts on mainnet**: CLOSED. relayer./attest. created by familiarcow ~19:25; bets. (escrow, 6 NEAR) + aikey. (secrets owner, 0.3 NEAR) created (seen by view ~20:07) from `praetorial.near` with the temp key file (RUNBOOK step 3b), keys 3BiLqo5Q / HKGkCQhp verified by view | 3b | BOT | done |
| B7 | **INTENTS1 not merged**: `scripts/mainnet-intents-smoke.sh` exists only in `~/praetorial-wt/intents1` (untracked); its RED tests for the real intents.near call shapes are not on main. If they find a web shape bug, the mainnet web Move/withdraw breaks | 2 (can run from the worktree), 13a/14 (web must include any INTENTS1 fix) | BOT (INTENTS1) | merge INTENTS1 before the web build; if not merged, run step 2 from its worktree and only proceed if the round trip passes |

## can-wait (tonight unlisted)

| # | Gap | Severity | Owner | Note |
|---|---|---|---|---|
| W1 | **Alerts bot token** (ALRT1): no `$PRAETORIAL_SECRETS_DIR/praetorial-alerts.env`; mainnet monitor runs but cannot alert; `ALERT_TELEGRAM_CHAT_ID` not set in `[env.mainnet.vars]` | can-wait tonight (familiarcow + bot watching); BLOCKER before listing (go/no-go D3) | FAMILIARCOW (token), BOT (chat id var + `set-mainnet-secrets.sh`) | familiarcow guide "TODAY (2026-11-09)" |
| W2 | **Privy test login** (PRIVY_TEST_*) still on the shared app | BLOCKER before the URL is shared (D-PRIVY5); not needed for the web to work | FAMILIARCOW | turning it off stops the testnet @live suite until a separate dev app exists |
| W3 | Keeper uses its full-access bot key (`keeper.praetorial.near`, ~1 NEAR) as `KEEPER_PRIVATE_KEY`, not a function-call key scoped to the escrow (go/no-go E4) | can-wait (blast radius = keeper balance) | BOT + FAMILIARCOW | add an FC key (receiver escrow) and swap the Worker secret |
| W4 | Mainnet FastFS host not confirmed in advance (`main.fastfs.io` root 404; testnet is `test.fastfs.io`) | none: the URL is read from the upload output and re-download hash-checked (step 4) | BOT | — |
| W5 | Smoke S4 (VOID), S5 (challenge), S7 (USDT/BTC/ETH/ZEC), S8 (sponsored no-NEAR user), S9 (pause drill), S10 (keeper-stall alert) | before listing | FAMILIARCOW + BOT | RUNBOOK step 17 "can wait" |
| W6 | Escrow free balance after deploy ≈ 1.1 NEAR (538,601-byte wasm locks ≈5.39 NEAR of 6.5); monitor `storage_headroom` alerts below 0.5 | can-wait | FAMILIARCOW | optional +0.5 NEAR to escrow any time (plain transfer works after the key is deleted) |
| W7 | praetorial.com route/DNS, Privy production domain (GATE-08 domain part), GATE-10 public repo, terms/jurisdiction (F2/F3) | before listing | FAMILIARCOW | deliberately not tonight |
| W8 | Workers Free shared quota: testnet + mainnet stacks share 100k requests/day and the 5-cron limit (now 1 used; mainnet keeper → 2) | can-wait | BOT | watch the CF dashboard first 24 h |
| W9 | Notifier high-stake USD routing prices only USDC/USDT (volatile assets logged as unpriced, never mis-valued); no TELEGRAM_BOT_TOKEN for the notifier | can-wait | BOT | — |
| W10 | Second RPC for D-DSY1 is `https://rpc.intea.rs` then `https://rpc.mainnet.near.org` (both answered mainnet views tonight; near.org is slow ~3 s and rate-limited) | can-wait | BOT | consider a keyed provider later |
| W11 | In-flight agent work not on main: KEEPSUBMIT1 (`~/praetorial` is on `feat/keepsubmit1`), IDX1, RELAYDEP1 follow-ups. Step 14 deploys whatever main holds | check before step 14 | BOT | `deploy-mainnet.sh` refuses a dirty tree; deploy from a clean main checkout |
| W12 | `release/freeze-candidate-2.json` has no `mainnet_escrow`; tonight's record is `release/mainnet-night/release-mainnet.json` (PENDING fields filled during the night) | can-wait | BOT | fold into a `freeze-record` run after the night |
| W13 | Mainnet web limits come from the FINAL args (step 13a `gen:limits --args …`), so the deployed web's `assetLimits.generated.ts` differs from main's (draft-based, parity test); main must fold the night's args into `release/draft-args.mainnet.json` + regenerate after the night | can-wait | BOT | the build/guard path is done and dry-run (RUNBOOK "Web"); the mainnet build no longer blocks |

## familiarcow-only items (in order, D-KEYS2b)
1. GATE-09 capped key (B2). 2. Smoke accounts funded. 3. Step 15a: delete the temp key 6eWbyxb8 from `praetorial.near` (his phrase at
the prompt). 4. Step 16 Privy origin (+ test-login decision). 5. Step 17 smoke with A and B. Everything else is BOT (key files).
Later: alerts bot token (W1), test login off (W2), DNS/route (W7).

## Cost table (what familiarcow must have on hand tonight)
Prices: NEAR $3.68 (PXF1 2026-11-10T14:49Z). Balances from read-only views 2026-11-10.

| Where it goes | Amount | Stays familiarcow's? | Notes |
|---|---|---|---|
| `bets.praetorial.near` (create, step 3b; escrow) | 6.0 NEAR | 5.39 locked forever by the wasm; ~0.6 free for state | storage headroom: monitor alerts below 0.5 |
| `aikey.praetorial.near` (create, step 3b; secrets owner) | 0.3 NEAR | yes | secret storage ≈0.0074 NEAR (refundable) |
| `relayer.praetorial.near` (create, step 3) | 2.0 NEAR | yes (spent as user gas over time) | monitor floor 1 NEAR; relayer pays gas only (RELAYDEP1) |
| `attest.praetorial.near` (create) | 1.0 NEAR | yes | ≈0.0022 NEAR per sourcecheck net; runs attach up to 0.4 NEAR temporarily |
| `praetorial.near` reserve after step 3b | 0.73 NEAR (seen) | yes | guardian pause/unpause gas |
| Keeper compute credit (from keeper's existing 1.0 NEAR, step 13) | 0.5 NEAR | consumed by AI rulings (≈0.013 NEAR each, unused refunded per run) | keeper keeps ≈0.5 NEAR gas |
| FastFS upload (ops, existing 0.5 NEAR) | ≤0.15 NEAR | burned (gas) | 4 chunk txs |
| OutLayer report-pubkey runs (bets ×2, attest ×2) | ≈0.01 NEAR | burned | from the bets./attest. balances |
| Escrow wasm storage | 5.39 NEAR | locked forever | inside bets.'s 6.0 NEAR (above) |
| Step 2 intents round trip (familiarcow wallet) | 1.6 NEAR | yes (≈0.005 burned) | returned by the script |
| Smoke account A | 3.5 NEAR + 20 USDC | yes, minus fees | fees/storage charges go to `praetorial.near` (fee account, familiarcow's) |
| Smoke account B | 3.5 NEAR + 10 USDC | yes, minus fees | |
| NEAR AI (capped key) | ≈$0.05 | burned | 2 calls per AI ruling |

**On hand tonight (KEYS2):** `praetorial.near` was funded and paid bets./aikey. (done); smoke accounts A/B 7 NEAR + 30 USDC.
The ~6.9 NEAR on the lost escrow./fee./secrets. accounts is unrecoverable (D-KEYS2). Fees and storage charges land in
`praetorial.near` (fee account, familiarcow's).

---

<!-- KEYS2-HISTORY -->
## History (pre-KEYS2 rows, old account names; superseded by D-KEYS2/2a/2b)
| B3 | **Paper-key signing**: `praetorial.near` (create accounts), `escrow.praetorial.near` (OutLayer login, deploy+new, delete key), `secrets.praetorial.near` (new, familiarcow-held) | 3, 6, 9, 10, 12 | FAMILIARCOW | have the paper keys at the Mac mini; near-cli prompts for them (never on a command line) |
| B4 | **Money**: `praetorial.near` has 3.7659 NEAR; step 3 sends 3.3 NEAR and it should keep ≥0.5 for guardian gas | 3 | FAMILIARCOW | send ≥1.0 NEAR to `praetorial.near` (3.3 out + 0.5 reserve + gas/buffer → have ≥4.8) |
| B6 | **Accounts missing on mainnet**: `relayer.`, `attest.`, `secrets.praetorial.near` (UNKNOWN_ACCOUNT, view 2026-11-10). Keys for relayer/attest generated by BOT tonight (pubkeys in RUNBOOK step 3) | 3 → 4/5/10/14 | FAMILIARCOW (signs), BOT (keys ready) | RUNBOOK step 3 |
| `secrets.praetorial.near` (create) | 0.3 NEAR | yes | secret storage ≈0.0074 NEAR (refundable) |

## familiarcow-only items (in order)
1. GO in writing (B1). 2. GATE-09 capped key (B2). 3. Money in (B4 + smoke accounts). 4. Paper keys at hand (B3).
5. Step 2 intents round trip. 6. Step 3 three accounts. 7. Step 6 OutLayer login as escrow + outcome run. 8. Step 8 args review.
9. Step 9 deploy+new. 10. Step 10 secrets login + bind. 11. Step 12 delete escrow key. 12. Step 16 Privy origin (+ test-login decision).
13. Step 17 smoke with A and B. Later: alerts bot token (W1), test login off (W2), DNS/route (W7).

**On hand tonight:** `praetorial.near` needs +1.0 NEAR (3.77 → ≥4.8); smoke + intents wallets 8.6 NEAR; total **≈9.6 NEAR
(≈$35) + 30 USDC**. Real money burned tonight ≈ **0.2-0.4 NEAR (~$1-1.5) + cents of NEAR AI**; the rest stays in familiarcow's
accounts (fees and storage charges land in `fee.praetorial.near`, which familiarcow owns).

