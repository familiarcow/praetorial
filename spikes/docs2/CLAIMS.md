# DOCS2 claims: the mainnet-first Docs, with a source or a chain read for each claim

Checked on 2026-11-12 (ET evening, 2026-11-13 UTC) in worktree `web/docs2`. Paths are from the repo root. "Chain read" means read-only:
public RPC views on `https://free.rpc.fastnear.com`, tx status on `https://archival-rpc.mainnet.fastnear.com` (method `tx`), and the
public FastNEAR tx indexer `https://tx.main.fastnear.com` (`/v0/account`, `/v0/transactions`). Nothing was signed or sent, no paid call
was made, and no secret was read. The DOCS1 claims (`spikes/docs1/CLAIMS.md`) still hold for text DOCS2 did not change.
Helper used for the reads: `spikes/docs2/chainread.mjs` (state, view, tx). Raw outputs: `spikes/docs2/chain-mainnet-state.json`,
`spikes/docs2/evidence/`.

## Mainnet state (chain read, block 224306325, 2026-11-13T03:21Z = 12 Nov 22:21 ET)

| Claim on the pages | Read | Result |
|---|---|---|
| Escrow `bets.praetorial.near` has no access keys | `view_access_key_list` | 0 keys |
| Its code = the release (`caf134a4…`) | `view_account` code_hash | `EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q` = `release/mainnet-night/release-mainnet.json:5` |
| No mainnet bet yet (`MAINNET_STATUS.betCount` 0, `apps/web/lib/mainnetEvidence.ts`) | `bet_count` | 0 |
| Not paused; fee 1% | `is_paused`, `protocol_fee_bps` | false, 100 |
| Pinned keys and program | `resolver_keys` | `f67c1f8f…e440`, `27070cba…0712`, `8791413f…2473` |
| Program address; NEAR AI key owner | `outlayer_config` | `https://main.fastfs.io/ops.praetorial.near/outlayer.near`, `secrets_account_id` `aikey.praetorial.near` |
| Model pairs | `judge_chain` | 4 pairs = `release/mainnet-night/args.mainnet.json` `judge_chain` (= `LAUNCH_JUDGE_CHAIN`) |

## Mainnet transactions (every hash in `apps/web/lib/mainnetEvidence.ts` TX)

All listed by the indexer for `bets.praetorial.near` / `attest.praetorial.near` (8 + 3 txs; full dump `spikes/docs2/evidence/mainnet-escrow-txs.json`)
and each re-read by hash on the archival RPC. All SuccessValue.

| Hash | When (UTC) | Signer -> receiver | Actions | What it shows |
|---|---|---|---|---|
| `FF7ta6qDfBEN4ivby1VQ5Nyyfj9qgxvjxuveFWgUH3bP` | 11-11 00:32 | attest.praetorial.near -> outlayer.near | `request_execution` `{"mode":"report-pubkey"}`, source `WasmUrl` hash `8791413f…` | result: predecessor attest.praetorial.near, `attest_public_key` `27070cba…0712` (= `resolver_keys[1]`, = args `attest_pubkey`). RUNBOOK step 5 = release `outlayer.attest_run_tx` |
| `68bixJNEftXehdSjrSfF9r6VSa5diPAMnFEkLFATeCAB` | 11-11 01:06 | bets.praetorial.near -> outlayer.near | same, OutLayer request 2950 | result: predecessor bets.praetorial.near, `public_key` `f67c1f8f…e440` (= `resolver_keys[0]`, = args `outcome_pubkey`). RUNBOOK step 6 = release `outlayer.outcome_run_tx` |
| `9gFoypqaFzHEnUmkecG6NarvzoH8fdg8Bn2TPfy34NpX` | 11-11 01:55 | bets.praetorial.near -> itself | `DeployContract`, `new` | the deploy; `new()` args bytes sha256 `a9d7eeee52081ebe1cd76dd7d6cb39097a55db244b8e6330a445ef60c3bca17f` = sha256 of `release/mainnet-night/args.mainnet.json` (3908 bytes, byte-equal; script in REPORT.md). Code hash read above |
| `Dbp3M7nfrNKfyoyMunmnS5kHjacuU18NfVEqBRwgYw9m` | 11-11 01:56 | bets.praetorial.near -> outlayer.near | report-pubkey, request 2951 | E4 after deploy: same ruling key `f67c1f8f…` |
| `GSeXpea6crnGu1BtZDQKwyfo63YFg5j6HBADrAYvjHoF` | 11-11 01:57 | attest.praetorial.near -> outlayer.near | report-pubkey, request 2952 | E4 after deploy: same attest key `27070cba…` |
| `ACkj5srVv2nav4iUuszyefkEGtonjQJVfusbRAS36UT3` | 11-11 01:57 | bets.praetorial.near -> itself | `DeleteKey ed25519:3BiLqo5Q…` | the lock (= `release-mainnet.json` `delete_key_tx`, PUB1) |
| (not on a page) `Hqjf3zfQ6NrhbqDatczjR5ychujp2pG5kYb34GYrV2Zu` | 11-11 02:14 | keeper.praetorial.near -> bets | `topup_keeper_credit` | keeper credit only; no bet |

`release/mainnet-night/logs/verify-escrow.txt:5` (E4 PASS at deploy, predecessors bets./attest.) is consistent with the two post-deploy runs.

## Release record (`release/mainnet-night/release-mainnet.json`)

| Field | Value | Source |
|---|---|---|
| `deploy_tx`, `delete_key_tx` | as above | filled by PUB1; DOCS2 re-read both on the archival RPC |
| `args_sha256` | `a9d7eeee52081ebe1cd76dd7d6cb39097a55db244b8e6330a445ef60c3bca17f` | DOCS2: sha256 of `args_file`, byte-equal to the deploy tx's `new()` args (RUNBOOK step 7: `10-args.sh final` "prints sha256") |
| `outlayer.upload_url` | `https://main.fastfs.io/ops.praetorial.near/outlayer.near/8791413f…2473.wasm` | `outlayer_config.wasm_base_url` + pinned hash; the URL is the `source.WasmUrl.url` in all four report-pubkey txs; `curl … \| shasum -a 256` printed `8791413f…2473` |
| `outlayer.outcome_run_tx`, `attest_run_tx` | `68bixJNE…`, `FF7ta6qD…` | RUNBOOK steps 6 and 5 (report-pubkey before deploy), chain read above |
| `outlayer.secret_bind` | still `PENDING` | not looked up (FOLLOWUPS) |

Test: `apps/web/tests/docs2.unit.test.ts` "args_sha256 …".

## Mainnet accounts (`apps/web/lib/mainnetAccounts.json`, test-checked)

| Role | Account | Source |
|---|---|---|
| Escrow | bets.praetorial.near | `apps/web/lib/network.ts:56` |
| Guardian, fee account | praetorial.near | `args.mainnet.json:6,8` (`guardian`, `fee_account`) |
| Keeper | keeper.praetorial.near | `args.mainnet.json:9` |
| Operator (may reclaim expired offers) | operator.praetorial.near | `args.mainnet.json:5`; `contracts/escrow/src/lib.rs:2569` |
| Registry name | registry.praetorial.near | `args.mainnet.json:7`; no account on chain (DOCS1) |
| Intents | intents.near | `args.mainnet.json:2` |
| OutLayer | outlayer.near | `args.mainnet.json:4` |
| NEAR AI key owner | aikey.praetorial.near | `args.mainnet.json` `outlayer_config.secrets_account_id`; chain `outlayer_config` |
| Program uploader | ops.praetorial.near | `wasm_base_url` path |
| Relayer | relayer.praetorial.near | `services/workers/relayer/wrangler.toml:53` |
| Source check (attest) signer | attest.praetorial.near | `services/workers/sourcecheck/wrangler.toml:48`; report-pubkey txs above |

## Corrected facts

| Fact on the pages | Source |
|---|---|
| No maximum stake per side (D-CAP3) | `release/mainnet-night/args.mainnet.json:22` (`max_per_side` 10^34 for every asset); `apps/web/lib/assets.ts:51-54` |
| Minimum $10 per side; fee 1% per side, at least $0.50 | `release/mainnet-night/limits.md:5` (USDC `min_per_side` 10000000 = $10.00, `min_fee_per_side` 500000 = $0.50); rendered from `feeRows(["USDC"])` (`apps/web/lib/about.ts:59`); fee bps 100 chain read |
| Withdraw to a NEAR wallet: mainnet and testnet. 1Click cash-out: mainnet only | `apps/web/lib/withdraw.ts:18-28`; `apps/web/lib/walletCards.ts:150`; `services/workers/funding/wrangler.toml:26,55` (as DOCS1) |
| Challenge bond = max(min_bond, 10% of pot) x 2^(round-1) + run_price | `contracts/escrow/src/lib.rs:2408` (`pot * 1_000 / BPS_DENOM`, `BPS_DENOM` = 10_000 at `:25`), `:2410-2411`; `pot_for_challenger` `:826-833`; min_bond $5 for USDC `limits.md:5` |
| Stale comments saying 5% | `contracts/escrow/src/lib.rs:1560` and `:2393` (doc/inline comments; contract frozen, not edited) |
| Mainnet bet ids start at 1 (commands use bet 1) | `contracts/escrow/src/lib.rs:1718` (`next_bet_id: 1`), `:5074-5075` |
| License MIT | `LICENSE:1` |

## Hackathon cards (a)-(h): status and evidence (`apps/web/lib/mainnetEvidence.ts`)

| Card | Status | Evidence | Code behind the description |
|---|---|---|---|
| (a) judge | In progress | none on mainnet (bet_count 0) | `resolver/core/src/lib.rs:68` (FIXED_SYSTEM form), `:185` (`quote_in`), `:1017-1049` (`decide`); `resolver/wasm-bin/src/main.rs:667` (`two_model_agree`) |
| (b) signed-keys | Partly proven | `FF7ta6qD…`, `68bixJNE…`, `9gFoypqa…`, `Dbp3M7nf…`, `GSeXpea6…` | `contracts/escrow/src/lib.rs:1766` (`resolver_keys`), `:3271-3275` (verify under pinned key) |
| (c) immutable | Proven | `9gFoypqa…`, `ACkj5srV…` + 0 keys | `contracts/escrow/src/lib.rs:1329-1338` (guardian powers), `:5208-5222`, `:5279` |
| (d) reproducible | Proven | `9gFoypqa…` (code hash = `contracts/escrow/release/record-84f23c8.json:10-11`, 3 builds); resolver `8791413f…` = `resolver/release/record-f5695b9.json` and = the `WasmUrl.hash` OutLayer ran | DOCS1 rebuilt both with Docker on 2026-11-12 (`spikes/docs1/REPORT.md`); DOCS2 did not rebuild |
| (e) failsafe | In progress | none on mainnet | `contracts/escrow/src/lib.rs:152`, `:3242-3255`, `:4295` |
| (f) disputes | In progress | none on mainnet | `contracts/escrow/src/lib.rs:2399-2414`, `:117-130` (max 2 rounds) |
| (g) intents | In progress | none on mainnet | `apps/web/lib/assets.ts` ASSET_TABLE (6 tokens on mainnet); DOCS1 Page 3 rows |
| (h) verifier | Partly proven | `9gFoypqa…`, `Dbp3M7nf…`, `GSeXpea6…` (E1-E4 at deploy) | `release/mainnet-night/logs/verify-escrow.txt:2-6`; `scripts/verify-bet.mjs`; `services/verifier` |

"Mainnet run pending" text names the mainnet smoke run (M1-M8) and the hackathon self-bet, as the brief does. The repo has no
definition of M1-M8, so the pages say no more about them.

## Command blocks added or changed by DOCS2

| Id | Change | Run |
|---|---|---|
| cmd:e4-onchain | new (Trust step 4): reads the four report-pubkey txs from the archival RPC, prints program hash, caller, ruling key, attest key | run verbatim (text generated from `DOCS_COMMANDS`) in bash and zsh on 2026-11-13 UTC; output `spikes/docs2/evidence/e4-onchain.txt` |
| cmd:get-bet, cmd:verify-bet-mjs, cmd:verify-bet-full | example bet 7 -> bet 1 (the first mainnet bet id) | `view get_bet '{"bet_id":1}'` returns `null` today (no bet); the commands are otherwise as DOCS1 ran them |
| cmd:escrow-build, cmd:resolver-build | now also on the Hackathon page (card d) | unchanged; DOCS1 ran them |

## TODOs for familiarcow (unchanged from DOCS1, minus the license)
- `TODO(familiarcow): public repository URL`
- `TODO(familiarcow): team`
- `TODO(familiarcow): demo post on X and the demo site address`
- The license is now MIT (`LICENSE`), so the Hackathon page states it; the DOCS1 placeholder is gone.

## Case studies (testnet rehearsals, `apps/web/lib/caseStudies.ts`)

12 cases, 102 testnet transactions, every one confirmed by read-only RPC tx status (archival testnet nodes for the older ones). Every stake,
amount and outcome on the page is checked against both a repo evidence file and the chain. Per figure, with file:line and the RPC
result: `spikes/docs2/CASES-VERIFIED.md` (full-hash appendix at the end; the test requires every hash on the page to be in it). Data:
`spikes/docs2/cases.verified.json`. DOCS2 re-read 3 of them independently (`4N3EanAw…` bond via relayer, Delegate, SuccessValue;
`AsBnfX8U…` and `3GqTf4fu…` finalize, SuccessValue).

Order (the brief's preference): Jason-style BTC sheet (3 cases: both-venue YES and one-venue NO on one escrow, and the code-decided NO),
DR1 bet 18, the run16 fail-safe series, KNYC weather (2 VOIDs, then YES), the early-request VOID, the challenged bet 49 with the
re-judge, NHL bet 51, NOAA Kp bet 54, the human-referee bet 53. All carry `network: "testnet"` and render "Testnet rehearsal".

### Dropped or corrected (figures the case-study log had, which the page does not use)
- **L1b-1 (the first Jason bet):** the log's "10 USDC each side" is wrong (repo and chain: 1 USDC per side). Not shown as its own case: the
  same sheet is shown through the L1b18 bets, whose txs all verify.
- **"Six fail-safe VOIDs" is five.** Attempt 1 of the run16 series never reached the judge (OutLayer refused the request format) and was
  unwound by a 50/50 mutual settle, not a VOID. The card says so. The log's run16 date (~11-05) is wrong: chain shows 2026-11-06.
- **run8:** not shown. The log's payout figures are wrong (one 9,900,000 transfer per side, not "4,950,000 in two legs"; the BTC bet's
  fee was 8,100 units, not 100).
- **R3c:** kept (weather VOIDs); all figures verify. The cause of bet 2's HTTP 400 ("wrong model id") is not confirmed even in the repo,
  and the page says "most likely … not confirmed".
- **R3e:** the log said finalize and stake were unknown; both are in the repo and on chain (finalize `3GqTf4fu…`, 1 USDC per side). Kept.
- **DR5:** figures verify, but not shown (bet 53 covers the human-referee path; DR5's open tx was never recorded). Note: its failed
  ruling tx `FqawWQJp…` shows top-level success while the escrow call inside failed (prepaid gas).
- **WT1:** not a requested case; its txs verify. The log's "bet 1 unknown" is the L1b20 bet (shown as the code-decided NO).
- **Figures removed from kept cases:** run16 attempt 1's mutual-settle amounts (chain only, no repo file); DR1's venue highs (repo only);
  the fee amounts of bets 51 and 54 (chain only); bet 51's "RETRY before the game" step (no tx); bet 49's "minus compute cost" wording
  (chain: 44.00 USDC to the maker, 0.005 USDC run price to the keeper; the challenger paid the compute).
- **Bond check (bet 49):** the 5.005 USDC bond on 20 USDC per side IS the 10% rule: pot 40 USDC, 10% = 4 USDC < min_bond 5 USDC, so
  max(5, 4) + run_price 0.005 = 5.005 (`contracts/escrow/src/lib.rs:2408-2411`; chain read: the testnet escrow's `asset_limit` for `nep141:usdc.testnet` has `min_bond` 5000000, `run_price` 5000).
