# DR0: dress-rehearsal harness (offline)

Built for the dress rehearsal (plan sections 3, 4, 9). **No live run exists yet.** Everything here runs offline
(`./test.sh fast` via `services npm test`, glob `e2e/live-DR/harness/test/**/*.test.ts`): no network, no testnet writes,
no NEAR AI calls. Money in the rehearsal is **mock USDC** on a **testnet intents-mock**, so a pass here says nothing
about real-asset custody, real intents.near behaviour or mainnet.

| File | Part | What it is |
|---|---|---|
| `recorder.ts` | 1 | Writes an evidence dir (layout of `services/e2e/live-runR3e`) from recorded tx results, `get_bet` snapshots and balances before/after finalize. |
| `money.ts` | 2 | Expected payout/fee/tip per ending; fee params from the release config + `PROTOCOL_FEE_BPS_V1`. |
| `parsers.ts` | 3 | Kraken + Coinbase candle parsers and BTC touch, ESPN league game winner, IEM copy of the NWS CLI daily high. |
| `playwright.live.config.ts`, `liveContexts.ts` | 4 | Live Playwright config (maker via Privy; taker/referee via `window.__e2eTestWallet`). |
| `fixtures/` | | Raw recorded public payloads + the recorder input fixture (`make_recorded_input.mjs` derives it from the frozen R3e run). |

## What each check proves, and what it does not

**1. Recorder (`test/recorder.test.ts`)**
- Proves: for a recorded run, the dir the recorder writes is accepted by `services/verifier/final_step.sh` with 0 FAIL (E2, B1, B2, B3, B5, B6 PASS); a copy with the winner's payout changed by 1 raw unit gets `FAIL B5`; a run whose escrow is not drained, or that has pending payouts, is refused at write time; no secret-looking env value appears in the evidence.
- Does NOT prove: that a live run's chain data is what the recorder was given (it records what the caller observed); B4 (judge/NEAR AI attestation), E3 (wasm bytes) and E4 (live OutLayer key check) stay SKIP offline; the E1 hash check is skipped unless an expected hash is passed. The fixture is the R3e run (signatures already valid), not a fresh one.

**2. Money assertions (`test/money.test.ts`)**
- Proves: for $10/$50/$100 on 6-decimal USDC and a taker-option take, the expected amounts for YES, NO, VOID refund, concede, human ruling with tip (YES/NO/VOID) and deadline refund follow the frozen rules (`side_fee`, `finalize`, `referee_rule`, `concede`, `void_after_deadline`, `pay_tips`); every ending conserves money (payouts == deposits, escrow 0 of each asset); `sideFee` has the shape of the contract's `side_fee` (source text checked) and the recorded R3e payout matches. `min_fee_per_side` and `fee_bps` are read from `services/release/example/args.indicative.json` and `contracts/escrow/src/lib.rs`, never typed into the test.
- Does NOT prove: the contract's behaviour (it is a re-derivation from reading the source, not an execution; the contract's own `cargo test` is the executable check); the indicative release config is the final mainnet config; multi-asset payouts beyond the per-asset bookkeeping; bond/objection/challenge-round money (AI dispute path) is out of scope here.
- Note (observed in source, not a harness bug): the tip equals the bettor's own `side_fee`, so at $10 the min fee dominates the percentage.

**3. Ground-truth parsers (`test/parsers.test.ts`)**
- Proves: independent code (no `resolver/` import) parses recorded Kraken and Coinbase public candles (same one-hour window), decides a BTC touch per venue and reports venue disagreement instead of merging it, reads a final game winner from a league payload, and reads the daily high from an IEM-hosted NWS CLI product (first `MAXIMUM` under `TEMPERATURE`).
- Does NOT prove: that the live endpoints still return these shapes (fixtures were fetched once by hand on the build day); the resolver's own fetch path (deliberately not exercised); correct rules for a given market (touch uses candle high/low only; no tick data, no timezone/settlement-rule judgement beyond the given window). The box score is ESPN's NBA scoreboard payload, one league only.

**4. Live Playwright config (`test/liveConfig.test.ts`)**
- Proves (statically): trace/video/screenshot off, no console output or file writes, only `PLAYWRIGHT_BASE_URL` read, maker/taker/referee projects, seam installer matches `apps/web/src/App.tsx`'s declared shape, no key in the init script; the config lives outside `apps/web`, is not referenced by `apps/web` scripts or `./test.sh fast`, and only matches `*.live.spec.ts`.
- Does NOT prove: that a browser run works. It has never been executed (no live specs yet; DR1-DR9 are not part of DR0). Signing for taker/referee needs the spec to expose a Node-side `__drSign` binding; that is part of the live specs. The maker's Privy login is not automated here.

## Running
`cd services && node --import tsx --test e2e/live-DR/harness/test/*.test.ts`

## Judge-backend guard (FRZ2SEC1)
`judgeBackend.ts` `assertRealJudge(last_resolution_raw)` throws when a run used `judge_backend` `offline-mock` (or any non-`near-ai`, or a NEAR_AI_API_KEY reason). `writeEvidenceDir` calls it, so a DR finish phase cannot record a mock run; call it directly on `get_bet.last_resolution_raw` before reading an outcome. Fixture: DR4 bet 25 (`fixtures/frz2_bet25_get_bet_offline_mock.json`).

## Money check (DR1b, D-PM3)
`money.ts`: `creditsFromReceipts(tx_status, {escrow, intents, betId, token})` sums the escrow's own `mt_transfer` receipts (sent by the escrow to the intents contract, succeeded, right token) per receiver and refuses events that name another bet_id; `checkPerBetMoney(expectedSettlement, ...)` asserts each party's credit == expected to the yocto, no credit to a stranger, per-bet residue 0 (deposits minus receipt credits) and `is_fully_paid`.
- **Why fee and escrow use per-bet receipts and not balance deltas:** the fee account and the escrow balance are shared by every bet on the deployment, so over a long wait their balance deltas include other bets' movements (DR1 bet 18 failed exactly this way). The per-bet receipts are the only exact per-bet ledger.
- **Bettor balance delta stays a hard assertion (not loosened):** `freshBettorAccounts()` makes new per-run maker/taker accounts; call `assertFreshBefore(role, balance)` before funding (must be 0), then pass `bettorDeltas` + `fresh:{maker:true,taker:true}` to `checkPerBetMoney`. A delta on a non-fresh account is reported as a mismatch ("not fresh"), never silently accepted.
- Tests: `test/perBetMoney.test.ts` with fixture `fixtures/dr1_bet18_finalize_tx_status.json` (keeper finalize tx EkMbnyrD..., saved from public testnet RPC once; offline).
- The older `checkObserved` (plain balance deltas incl. escrow-after) remains for single-bet isolated setups; DR1 no longer uses it.

## B4 evidence capture (DR1b)
`recorder.ts` takes optional `judgeEvidence {sources, responses}` and `attestations [{model, signing_address, raw}]`, writes `judge_evidence.json` and `attestation_report_N.json` (usable with `verify-bet --judge-evidence / --attestation`), and `b4_evidence.json` listing `gaps` (what B4 would still SKIP on). `attestationTargets(rawResolution)` lists the (model, signer) reports to fetch (keyless GET). Test: `test/b4Evidence.test.ts` (B4 FULL PASS with the captured material). The raw NEAR AI stream is not exposed by OutLayer/the resolver: see the vault FINDING note; B4 is never marked optional.
