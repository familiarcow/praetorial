# Praetorial mainnet night RUNBOOK (MAINPREP1, prepared 2026-11-10)

Tonight: frozen escrow `caf134a4` + resolver `8791413f` to `bets.praetorial.near`, 7 mainnet Workers + the web on
**https://praetorial.com (UNLISTED, no praetorial.com route)**, then a short smoke with
familiarcow's two accounts. Read [GAPS.md](GAPS.md) first: the BLOCKER rows must be closed before step 1.

**Accounts (D-KEYS2, 2026-11-10).** the sub-accounts `escrow.`, `fee.` and `secrets.` of praetorial.near are LOST (one-time keys never kept) and are
not used. Escrow contract = `bets.praetorial.near`; fee_account = guardian = owner = `praetorial.near`; OutLayer secrets owner
(NEAR AI key, GATE-09) = `aikey.praetorial.near`. The frozen `new()` has no distinctness check (contracts/escrow/src/lib.rs `new`:
only outlayer_config/judge_chain/usdc/pubkey/hash checks), so fee_account == guardian is accepted.

**Roles (D-KEYS2a/b).** `BOT` = praetorial-bot runs **every remaining step** from key files in
`$PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/` (mode 600, never printed, never in the repo): `ops/`, `attest/`, `keeper/`, `relayer/`,
`bets/` (escrow account, deleted after its key is removed on chain), `aikey/` (secrets owner, stays bot-held) and `owner-temp/`
(a TEMPORARY full-access key on `praetorial.near`, ed25519:6eWbyxb82R32qxqmPmRM553u49YDZDHubwsmmavpYfuf, D-KEYS2b). `FAMILIARCOW` signs
only as `praetorial.near` with his paper phrase (default HD path m/44'/397'/0'): adding and finally deleting that temp key.
familiarcow's D-KEYS2b message is the GATE-11 GO for the bot's mainnet steps; every BOT tx is still gated in code by
`PRAETORIAL_MAINNET_GO=GO` (`scripts/mainnet-night/15-keyfile-steps.sh`, `40-bind-secret.sh`, `50-keeper-credit.mjs`,
`deploy-mainnet.sh`, and `[ "$PRAETORIAL_MAINNET_GO" = GO ] && …` on the OutLayer runs).

**Key rule (D-KEYS2).** Never `autogenerate`-a-keypair for an account whose key a person must hold: create accounts only with
`use-manually-provided-public-key <key>` from a key that already exists in a key file (bot) or that familiarcow derived himself.
BOT near-cli lines sign with `sign-with-access-key-file <key file> send` (never a key on the command line). FAMILIARCOW's lines end
at `sign-with-seed-phrase`: near-cli **prompts** for the phrase and the HD path (accept the default `m/44'/397'/0'` for
`praetorial.near`), then pick `send`. Read signer, receiver and deposit on screen before `send`. Never paste a phrase or key into chat.

**Shell setup (BOT, every terminal):**
```bash
cd ~/praetorial                        # main, clean, includes MAINPREP1
export PRAETORIAL_SECRETS_DIR=<operator secrets dir> PRAETORIAL_CACHE_DIR=<operator cache dir>   # outside the repo; scripts refuse when unset
set -a; . $PRAETORIAL_SECRETS_DIR/praetorial-cloudflare.env; set +a
export NIGHT=release/mainnet-night W=$PRAETORIAL_CACHE_DIR/mainnet-night
export LOGS=$W/logs                    # upload.log + report_pubkey_attest.log (steps 4-5) are already here; 20-fill-outlayer.sh reads $LOGS
mkdir -p $NIGHT/logs $LOGS
```
Frozen files (already staged, outside the repo): `$W/escrow-caf134a4.wasm` (538,601 B, sha256 `caf134a4…0f2f`),
`$W/praetorial-resolver-8791413f.wasm` (3,404,255 B, sha256 `8791413f…2473`). OutLayer homes (all bot, built from the key files by
`scripts/mainnet-night/05-olhome.sh ops|attest|bets|aikey`): `$W/olhome-ops`, `$W/olhome-attest`, `$W/olhome-bets` (step 6, deleted in
step 12), `$W/olhome-aikey` (step 10).

Resolver release record (PREMAIN1, 2026-11-10): `resolver/release/record-f5695b9.json` (source commit f5695b9d, tests-only
RHTTP1 change, D-RELREC2). It re-proves the SAME wasm: 3 reproducible builds = `8791413f…2473`, byte-identical to record-f9c61ec.
Upload, pins and bind steps below are unchanged: upload `praetorial-resolver-8791413f.wasm`. The E2 line in the dry-run transcript
further down names record-f9c61ec because it was recorded before PREMAIN1; both records carry the same hash.

Abort principle (go/no-go section I): before step 9 nothing is irreversible except account names and spent gas. After step 9
the code is fixed forever; a wrong arg = abandon `bets.praetorial.near`, deploy a new account (a new bot key file +
`use-manually-provided-public-key`, never autogenerate). **Do not delete the bets key (step 12) until steps 10-11 PASS**
(`15-keyfile-steps.sh delete-bets-key` refuses without the step-11 `# 4 PASS, 0 FAIL, 0 SKIP`).

---

## Step 0 — BOT, 5 min — pre-flight (read-only)
```bash
shasum -a 256 $W/escrow-caf134a4.wasm $W/praetorial-resolver-8791413f.wasm
bash scripts/mainnet-night/00-accounts.sh
(cd services && node --import tsx workers/scripts/check-mainnet-ready.mjs)
bash scripts/mainnet-night/10-args.sh preflight
```
Expected: the two hashes `caf134a4…` / `8791413f…`; `mainnet config is deploy-ready (0 findings)`; preflight exit 0 with exactly
3 `PENDING` lines. Abort: any hash differs, any finding, a price pair >2% apart (rerun in 5 min; twice = NO-GO).

KEYS2 (D-KEYS2b) adds the key-file preflight (read-only):
```bash
bash scripts/mainnet-night/15-keyfile-steps.sh preflight
```
Expected: three `key file OK` lines (praetorial.near 6eWbyxb8…, bets. 3BiLqo5Q…, aikey. HKGkCQhp…) and `chain OK praetorial.near
keys: FA:…6eWbyxb8… FA:…AtYDEhU4…`. Abort: a key file is missing/not mode 600/names another key, or the temp key is not on chain.

Read-only state 2026-11-10 ~20:07, Mac mini clock (after the temp key was added and step 3b ran; `00-accounts.sh`):
```
praetorial.near                  0.7321 NEAR  locked-storage  0.0026 NEAR  code 1111111111  keys[2] FA:6eWbyxb8,FA:AtYDEhU4
bets.praetorial.near             5.9990 NEAR  locked-storage  0.0018 NEAR  code 1111111111  keys[1] FA:3BiLqo5Q
aikey.praetorial.near            0.2990 NEAR  locked-storage  0.0018 NEAR  code 1111111111  keys[1] FA:HKGkCQhp
keeper.praetorial.near           1.0000 NEAR  locked-storage  0.0018 NEAR  code 1111111111  keys[1] FA:FXCAmAaU
operator.praetorial.near         0.1000 NEAR  locked-storage  0.0018 NEAR  code 1111111111  keys[1] FA:4y8pCuYz
ops.praetorial.near              0.4825 NEAR  locked-storage  0.0018 NEAR  code 1111111111  keys[1] FA:CkX38zfq
relayer.praetorial.near          2.0000 NEAR  locked-storage  0.0018 NEAR  code 1111111111  keys[1] FA:9c4HDV9A
attest.praetorial.near           0.9977 NEAR  locked-storage  0.0018 NEAR  code 1111111111  keys[1] FA:2pjNQ2La
```
The pre-KEYS2 dry-run output (old account names) is kept at the end of this file under "History".
`--final` on the same input refuses (exit 1, no file): `outlayer_config.wasm_base_url: contains PLACEHOLDER`, `outcome_pubkey: is an
all-0 or all-1 placeholder key`, `attest_pubkey: ...`. Full limits table: `dryrun/limits.md` (wNEAR min 2.7143 NEAR = $10.00).

## Step 1 — FAMILIARCOW, 10 min — money in + the temporary bot key (D-KEYS2b)
DONE (seen on chain by view 2026-11-10 ~20:07): `praetorial.near` was funded (7.04 NEAR before step 3b) and holds the temp key 6eWbyxb8. For the
record, the add-key command (familiarcow, his phrase at the prompt, default path m/44'/397'/0'):
```bash
near account add-key praetorial.near grant-full-access use-manually-provided-public-key ed25519:6eWbyxb82R32qxqmPmRM553u49YDZDHubwsmmavpYfuf network-config mainnet sign-with-seed-phrase
```
Put on familiarcow's two smoke
accounts (A = maker, B = taker, both Privy logins on the mainnet web; their 64-hex ids appear after first login in step 16):
A: 3.5 NEAR + 20 USDC, B: 3.5 NEAR + 10 USDC (native USDC on NEAR, `17208628…33a1`).
Check: `bash scripts/mainnet-night/15-keyfile-steps.sh preflight` passes.

## Step 2 — SUPERSEDED by D-UIRT1: the intents round trip is done in the real UI after step 15 (Privy login, Move 1 NEAR, Withdraw it)
Kept for reference (CLI variant, not run tonight):
INTENTS1's script (`scripts/mainnet-intents-smoke.sh`; until merged run it from `~/praetorial-wt/intents1`). Dry run first (BOT may run
it, free): `scripts/mainnet-intents-smoke.sh --signer <FAMILIARCOW_WALLET>`. Then familiarcow:
```bash
MAINNET_SMOKE_OK=yes scripts/mainnet-intents-smoke.sh --live --signer <FAMILIARCOW_WALLET> --amount-near 1.5 --sign-with keychain
```
Expected: TX1 near_deposit, TX2 ft_transfer_call to intents.near, view `mt_balance_of(<wallet>, nep141:wrap.near)` rises by exactly
the wNEAR amount, TX3 ft_withdraw, TX4 near_withdraw; cost ≈ 0.003 NEAR gas (+0.00125 wrap storage once).
**Abort:** balance delta ≠ amount, or any TX fails → NO-GO (the web's Move/withdraw shapes are wrong on real intents.near).

## Step 3 — DONE (familiarcow, ~19:25, PM-verified on chain) — relayer. + attest. (bot-held keys)
Bot-held keys (files in `$PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/{relayer,attest}/`): relayer ed25519:9c4HDV9A…, attest ed25519:2pjNQ2La….
(The two familiarcow-signed create commands are recorded under "History" at the end; nothing left to run.)
Expected (seen): `00-accounts.sh` shows relayer 2.0, attest 1.0, one FA key each, relayer key `9c4HDV9A…`, attest key `2pjNQ2La…`.

## Step 3b — BOT (GO: D-KEYS2b), 5 min — create bets. + aikey. from `praetorial.near` (temp owner key file)
DONE before ~20:07 by another bot session, not the KEYS2 build agent (verified by view: bets 5.9990 NEAR key 3BiLqo5Q, aikey 0.2990 NEAR key HKGkCQhp). The command:
```bash
PRAETORIAL_MAINNET_GO=GO bash scripts/mainnet-night/15-keyfile-steps.sh create
```
which checks both key files and the temp key on chain, refuses if either account exists, and runs exactly:
```bash
near account create-account fund-myself bets.praetorial.near '6 NEAR' use-manually-provided-public-key ed25519:3BiLqo5QjYkcTL1TnHDdT8ch7xJjGWwbGzUEZAK4HWYh sign-as praetorial.near network-config mainnet sign-with-access-key-file $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/owner-temp/praetorial.near-temp.json send
near account create-account fund-myself aikey.praetorial.near '0.3 NEAR' use-manually-provided-public-key ed25519:HKGkCQhpoStBPuG7CHfzLvH2XmuQe7d53SkUQux5MtLc sign-as praetorial.near network-config mainnet sign-with-access-key-file $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/owner-temp/praetorial.near-temp.json send
```
Expected: `chain OK bets.praetorial.near keys: FA:ed25519:3BiLqo5Q…` (~6 NEAR) and `chain OK aikey.praetorial.near keys:
FA:ed25519:HKGkCQhp…` (~0.3 NEAR). Abort: a key differs → stop, report (do not deploy to an account whose key is not ours).

## Step 4 — DONE (GO ~19:35; `$LOGS/upload.log`: `https://main.fastfs.io/ops.praetorial.near/outlayer.near/8791413f….wasm`) — BOT, 10 min — (c) upload the resolver wasm to mainnet FastFS (signer `ops.praetorial.near`)
```bash
OUTLAYER_HOME=$W/olhome-ops ~/.local/bin/outlayer upload $W/praetorial-resolver-8791413f.wasm 2>&1 | tee $LOGS/upload.log
curl -s -o /tmp/res.wasm "$(sed -n 's/^FastFS URL: //p' $LOGS/upload.log)" && shasum -a 256 /tmp/res.wasm
```
Expected: `SHA256: 8791413f…2473`, 4 chunk txs, `FastFS URL: https://<mainnet fastfs host>/ops.praetorial.near/outlayer.near/8791413f….wasm`
(testnet pattern: `https://test.fastfs.io/<uploader>/outlayer.testnet/<hash>.wasm`); the re-download hashes to `8791413f…`. Cost ≲ 0.15 NEAR gas.
Abort: re-download hash differs, or the URL is not https → stop, report.

## Step 5 — DONE (`$LOGS/report_pubkey_attest.log`, predecessor attest.praetorial.near) — BOT, 5 min — (c) attest pubkey (signer `attest.praetorial.near`)
```bash
echo '{"mode":"report-pubkey"}' > /tmp/job.json
OUTLAYER_HOME=$W/olhome-attest ~/.local/bin/outlayer run --wasm "$(sed -n 's/^FastFS URL: //p' $LOGS/upload.log)" --input /tmp/job.json 2>&1 | tee $LOGS/report_pubkey_attest.log
```
Expected: JSON with `"mode": "report-pubkey"`, `"predecessor": "attest.praetorial.near"`, `attest_public_key` 64 hex. Up to 180 s.
Known flake: `the request failed with timeout error` (seen twice tonight on testnet attest1, third try PASS): retry up to 3×.

## Step 6 — BOT (GO), 10 min — (c) outcome pubkey (signer `bets.praetorial.near`, BEFORE deploy)
OutLayer derives the outcome key per caller, so this run must be signed by the escrow account itself (bot-held, D-KEYS2a).
```bash
bash scripts/mainnet-night/05-olhome.sh bets                   # -> $W/olhome-bets from the bets key file (prints Account/Network only)
echo '{"mode":"report-pubkey"}' > /tmp/job.json
[ "$PRAETORIAL_MAINNET_GO" = GO ] && OUTLAYER_HOME=$W/olhome-bets ~/.local/bin/outlayer run --wasm "$(sed -n 's/^FastFS URL: //p' $LOGS/upload.log)" --input /tmp/job.json 2>&1 | tee $LOGS/report_pubkey_outcome.log
```
Expected: `05-olhome.sh` prints `Account: bets.praetorial.near`, `Network: mainnet`; the run prints `"predecessor":
"bets.praetorial.near"`, `public_key` 64 hex. Cost ≈ 0.002 NEAR from bets. Keep `$W/olhome-bets` until step 12 (step 11 E4 needs
it); step 12 deletes it together with the bets key file. Known flake: OutLayer timeout → retry ≤3×.

## Step 7 — BOT, 5 min — (b)+(c) fill the OutLayer fields, fresh prices, FINAL args (sign step 9 within 30 min of this)
```bash
bash scripts/mainnet-night/20-fill-outlayer.sh       # reads $LOGS; -> $NIGHT/input.mainnet.json; refuses a predecessor other than bets./attest. or a hash mismatch
bash scripts/mainnet-night/10-args.sh final          # -> $NIGHT/args.mainnet.json + limits.md + input.priced.json, prints sha256
```
Expected: `outcome_pubkey <hex>`, `attest_pubkey <hex>`, `wasm_base_url https://…/ops.praetorial.near/outlayer.near`; then the price
table, `ok: wrote …args.mainnet.json (6 assets, network mainnet, all asserts passed)` and the sha256. `--final` refuses any
placeholder, all-0/1 key, non-https or testnet value. Proven tonight on the real NOKEY1b testnet logs: fill reproduced NOKEY1b's
`new_args.json` pubkeys exactly (outcome `4479e0b6…`, attest `a3fa8914…`) and `--final` accepted the shape.
Abort: any REFUSED → fix the input, never hand-edit `args.mainnet.json`.

## Step 8 — BOT (familiarcow may read along), 10 min — review the args (line by line)
`cat $NIGHT/args.mainnet.json`; `cat $NIGHT/limits.md`. Check: `intents` = `intents.near`; guardian `praetorial.near`; fee_account
`praetorial.near` (same as guardian, D-KEYS2); keeper `keeper.praetorial.near`; operator `operator.praetorial.near`; outlayer `outlayer.near`;
`resolver_wasm_hash` `8791413f…2473`; secrets_account_id `aikey.praetorial.near`; 6 assets; each min ≈ $10; `max_offer_ttl_secs`
5184000; `judge_chain` 4 pairs starting DeepSeek-V4.1-Flash-1017 + glm-5.3-flash. Then BOT also builds the web from these args (step 13a) so a mismatch shows up early.

## Step 9 — BOT (GO), 5 min — (d) deploy + new() in ONE transaction (irreversible), signed with the bets key file
```bash
PRAETORIAL_MAINNET_GO=GO bash scripts/mainnet-night/15-keyfile-steps.sh deploy
```
Checks first: bets key file + `chain OK bets.praetorial.near keys: FA:…3BiLqo5Q…`, no code yet, `$W/escrow-caf134a4.wasm` sha256
`caf134a4…0f2f`, `args.mainnet.json` exists with no PLACEHOLDER (prints its sha256). Then runs exactly:
```bash
near contract deploy bets.praetorial.near use-file $PRAETORIAL_CACHE_DIR/mainnet-night/escrow-caf134a4.wasm with-init-call new file-args release/mainnet-night/args.mainnet.json prepaid-gas '300 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-access-key-file $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/bets/bets.praetorial.near.json send
```
Expected: `Transaction … succeeded`, then `chain OK bets.praetorial.near code EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q`; record
the tx hash in `$NIGHT/release-mainnet.json` (`mainnet_escrow.deploy_tx`). Storage: 538,601 B locks ≈5.39 NEAR of bets.'s ~6.0.
Abort: `LackBalanceForState` → send 0.5 NEAR to bets. from praetorial.near with the temp key file, then rerun:
```bash
[ "$PRAETORIAL_MAINNET_GO" = GO ] && near tokens praetorial.near send-near bets.praetorial.near '0.5 NEAR' network-config mainnet sign-with-access-key-file $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/owner-temp/praetorial.near-temp.json send
```
A `new()` panic → read the message, fix args (step 7), rerun (the whole tx reverts, so no code is on chain).

## Step 10 — BOT (GO), 10 min — (c) GATE-09: bind the capped NEAR AI key (signer `aikey.praetorial.near`, bot key file)
Prereq (familiarcow, GATE-09): capped key created on cloud.near.ai and saved as `NEAR_AI_RESOLVER_KEY` in `$PRAETORIAL_SECRETS_DIR/praetorial-nearai.env`.
```bash
bash scripts/mainnet-night/05-olhome.sh aikey                  # -> $W/olhome-aikey (prints Account/Network only)
OUTLAYER_HOME=$W/olhome-aikey PRAETORIAL_MAINNET_GO=GO bash scripts/mainnet-night/40-bind-secret.sh
```
The script refuses unless the home is `aikey.praetorial.near` on mainnet and the resolver key is set and differs from the general
key; it never prints the key. Expected: `Secrets stored (profile: praetorial-resolver, keys: NEAR_AI_API_KEY)`, `Calls admitted only
from: bets.praetorial.near`, then `OK: NEAR_AI_API_KEY bound for escrow bets.praetorial.near, resolver hash 8791413f…`.
`$W/olhome-aikey` and the aikey key file stay (aikey. remains the bot-held secrets owner; familiarcow may later add his own key, D-KEYS2a).
Abort: not bound → the resolver emits no outcome (NOKEY1); do not open bets.

## Step 11 — BOT, 15 min — (e) verify-escrow E1-E4 + views == args
```bash
cd services
[ "$PRAETORIAL_MAINNET_GO" = GO ] && ./verifier/verify-escrow --network mainnet --escrow bets.praetorial.near --expect-escrow-hash caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f \
  --outlayer-home-escrow $W/olhome-bets --outlayer-home-attest $W/olhome-attest | tee ../$NIGHT/logs/verify-escrow.txt
cd .. && bash scripts/mainnet-night/30-views.sh | tee $NIGHT/logs/views.txt
```
E4 signs two small OutLayer runs (bets + attest, bot key files, ≈0.002 NEAR each). Expected: `PASS E1 … PASS E4`, `# 4 PASS, 0 FAIL, 0 SKIP`;
views `# 10 PASS, 0 FAIL` (resolver_keys, outlayer_config, judge_chain, 6× asset_limit… listed per asset, protocol_fee_bps 100,
is_paused false, is_shutdown false, contract_version). E4 timeout = retry ≤3× (known flake).
**Abort (key still present, nothing irreversible yet beyond the code):** any FAIL other than an E4 timeout → NO-GO: keep the app
unlisted, abandon this escrow (see abort principle).

Dry run tonight against testnet frz3 (same frozen wasm + resolver; NOKEY1b args):
```
PASS E1  deployed code hash == expected build hash caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f; governance replay: guardian arbiter1.praetorial-dev-1101.testnet, 4 judge pair(s), 3 asset(s)
PASS E2  pins match release record record-f9c61ec.json (commit f9c61ecb); new() args recorded (...)
PASS E3  resolver wasm (3404255 bytes) hashes to the pinned resolver_wasm_hash 8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473
PASS E4  live report-pubkey of the pinned wasm reproduces the bound outcome pubkey (predecessor praetorial-frz3-...testnet) and attest pubkey (predecessor attest1.praetorial-dev-1101.testnet)
# 4 PASS, 0 FAIL, 0 SKIP          (third attempt; attempts 1-2: FAIL E4 "outlayer run failed" = attest-side RPC timeout)
# views-vs-args: testnet escrow praetorial-frz3-2611100414.praetorial-dev-1101.testnet args e2e/live-NOKEY1b/new_args.json
PASS resolver_keys / outlayer_config / judge_chain / asset_limit(nep141:usdc.testnet) / asset_limit(nep141:btc.mock.testnet) /
     asset_limit(nep141:wrap.testnet) / protocol_fee_bps = 100 / is_paused = false / is_shutdown = false / contract_version = 1.0.0
# 10 PASS, 0 FAIL
```
(Mainnet will print 13 view lines: 6 assets.)

## Step 12 — BOT (GO), 5 min — (d) delete bets.'s full-access key (irreversible: locks the code), then its key file + OutLayer home
```bash
PRAETORIAL_MAINNET_GO=GO bash scripts/mainnet-night/15-keyfile-steps.sh delete-bets-key
```
Refuses unless `$NIGHT/logs/verify-escrow.txt` has `# 4 PASS, 0 FAIL, 0 SKIP` (step 11), the code hash is the frozen one and the
only key is 3BiLqo5Q. Then runs exactly:
```bash
near account delete-keys bets.praetorial.near public-keys ed25519:3BiLqo5QjYkcTL1TnHDdT8ch7xJjGWwbGzUEZAK4HWYh network-config mainnet sign-with-access-key-file $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/bets/bets.praetorial.near.json send
```
checks on chain that bets. has **keys[0]** and code `EfCgMFhe…`, and only then deletes the key file and the OutLayer home:
```bash
rm -rf $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/bets
rm -rf $W/olhome-bets
```
Expected: `chain OK bets.praetorial.near keys[0], code EfCgMFhe…: locked`, `deleted the bets key file and its OutLayer home`;
`bash scripts/mainnet-night/00-accounts.sh | grep bets` → `code EfCgMFheGB … keys[0]`. Record the tx (`mainnet_escrow.delete_key_tx`).
Re-run `verify-escrow … --offline`: E1-E3 PASS, E4 SKIP, exit 3 (expected after the key is gone).

## Step 13 — BOT (after GO), 15 min — (f) fund the services
```bash
node scripts/mainnet-night/50-keeper-credit.mjs 0.5                              # dry run: prints the call
PRAETORIAL_MAINNET_GO=GO node scripts/mainnet-night/50-keeper-credit.mjs 0.5     # keeper.praetorial.near -> topup_keeper_credit 0.5 NEAR
```
Expected: `tx topup_keeper_credit <hash>`, `keeper_credit_balance 0.5 NEAR`. The relayer got 2 NEAR at creation (step 3); keeper keeps
~0.5 NEAR for gas (monitor floors: relayer 1 NEAR, keeper 0.3 NEAR). Exact amounts: see the cost table (GAPS.md).

### Step 13a — BOT, 10 min — mainnet web build from the FINAL args (build only)
See "Web" below for the commands and tonight's dry-run output.

## Step 14 — BOT (after GO), 20 min — (g) deploy the 7 mainnet Workers + secrets + the mainnet web (workers.dev only)
```bash
cd services/workers
DRY_RUN=1 bash scripts/deploy-mainnet.sh                                # prints every wrangler command, runs the checks
PRAETORIAL_MAINNET_GO=GO bash scripts/deploy-mainnet.sh                 # checks + escrow code hash == EfCgMFhe… + D1 migrations + 7 deploys
PRAETORIAL_MAINNET_GO=GO bash scripts/set-mainnet-secrets.sh            # RELAYER/KEEPER/SOURCECHECK keys, notifier contact key, alerts token if present
cd ../../apps/web && npm run deploy:mainnet                             # build:mainnet -> dist guard (+ live diff) -> wrangler deploy --config wrangler.mainnet.toml
npm run check:live:mainnet                                              # DEPLOYFIX post-deploy check: funding + every service URL live
```
`deploy-mainnet.sh` refuses without GO, on any `check-mainnet-ready` finding, on config drift, on a dirty tree, or when the escrow's
on-chain code hash is not `EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q`. Order: indexer, notifier, monitor, relayer, registry,
sourcecheck, keeper (keeper's service bindings need the others). No routes, no custom domains anywhere.
Dry run tonight (stub wrangler, `DRY_RUN=1 SKIP_CHAIN_CHECK=1`, unit test `deployMainnetScript.test.ts`):
```
mainnet config is deploy-ready (0 findings)
config-drift OK: apps/web NETWORKS matches 7 Worker wrangler.toml files (testnet + mainnet)
deploying MAINNET git_sha=<sha> services=indexer notifier monitor relayer registry sourcecheck keeper
DRY: bash -c cd indexer && npx wrangler d1 migrations apply praetorial-indexer-mainnet --env mainnet --remote
DRY: bash -c cd indexer && npx wrangler deploy --env mainnet --var GIT_SHA:<sha>
... notifier, monitor, relayer, registry (+ d1 migrations), sourcecheck, keeper
DRY: (cd relayer && <privkey …/relayer/<id>.json> | npx wrangler secret put RELAYER_PRIVATE_KEY --env mainnet)   # names only, never values
```
Abort: a deploy fails → fix and rerun that service only (`… deploy-mainnet.sh relayer`); nothing user-facing is listed yet.

## Step 15 — BOT, 5 min — (h) check-deployed-stack against mainnet
```bash
cd services && node --import tsx workers/scripts/check-deployed-stack.mjs --network mainnet --release ../release/mainnet-night/release-mainnet.json
curl -s https://praetorial.com/ | grep -o 'index-[A-Za-z0-9_-]*\.js'
```
Expected: `deployed stack OK (7/7 PASS)` (each /health: network mainnet, escrow `bets.praetorial.near`, git_sha, fresh ticks).
Tonight before deploy (proves the command): `FAIL indexer praetorial-indexer-mainnet HTTP 404` … 7 of 7 FAIL, exit 1.
Abort: any FAIL after 3 min (cron ticks) → `wrangler tail --env mainnet` on that Worker; do not start the smoke.

## Step 15a — FAMILIARCOW then BOT, 5 min — take the keys offline (end of the bot-run steps, D-KEYS2b)
Right after step 15 PASS (steps 16-17 need neither key; the guardian pause drill S9 waits). First the BOT checks bets. is locked
(`00-accounts.sh | grep bets` → `keys[0]`). Then **familiarcow** deletes the temporary bot key from `praetorial.near`, signing with his
paper phrase at the prompt (default HD path m/44'/397'/0'; check signer `praetorial.near`, action DeleteKey 6eWbyxb8…, then `send`):
```bash
near account delete-keys praetorial.near public-keys ed25519:6eWbyxb82R32qxqmPmRM553u49YDZDHubwsmmavpYfuf network-config mainnet sign-with-seed-phrase
```
Then the **BOT** verifies on chain that only familiarcow's key is left and deletes the temp key file (refuses if 6eWbyxb8 is still on chain):
```bash
bash scripts/mainnet-night/15-keyfile-steps.sh owner-temp-cleanup     # runs: rm -rf $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/owner-temp
ls $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/                          # no bets/, no owner-temp/
```
Expected: `chain OK praetorial.near keys: FA:ed25519:AtYDEhU4igU6WDhWu97BkK2g8HPCRaDReC968Y9mCvF1`, `deleted the owner-temp key file`.
Bot-held keys left: ops, attest, keeper, relayer, operator, aikey (D-KEYS1/D-KEYS2a).

## Step 16 — FAMILIARCOW, 10 min — (i) Privy
On the existing Privy app `cmw1b5stc01q60glap4q18que` (D-PRIVY5 reuse; the mainnet build uses the same app id):
1. Configuration → App settings → Domains → Allowed origins: **add `https://praetorial.com`** (exact,
   https, no path). Keep the testnet origin. This is the only setting the mainnet web needs to work.
2. Login methods: email only (already). Embedded wallets: NEAR on, create on login (already; same implicit-account ids on both networks).
3. **Test login (PRIVY_TEST_*)**: not needed for the mainnet web to work and not used by tonight's smoke (familiarcow's real logins).
   D-PRIVY5 requires it OFF before the mainnet web is live for users. It may stay ON while the URL is unlisted and only familiarcow uses
   it; it MUST be off before the URL is shared or listed. Turning it off also stops the testnet @live suite (same app) until a separate
   dev app exists — familiarcow's call; recommendation: off tonight right after the smoke, before any link leaves this machine.
Check: open the mainnet URL in a private window, log in with A's real email, note A's 64-hex account id; same for B. Then send the
step-1 funds to those ids if not done.

## Step 17 — FAMILIARCOW (+BOT watching), 60-90 min — (j) smoke tonight (min stakes, accounts A and B)
BOT records every tx hash and runs `verify-bet --network mainnet --escrow bets.praetorial.near --bet <id>` after each terminal bet.

| # | Tonight | Stake | Pass |
|---|---|---|---|
| T1 | A: Move 10 USDC + 3 NEAR into Escrow balance (web Move modal); withdraw 1 USDC back | — | `mt_balance_of` on intents.near moves by exactly the amounts; relayer balance moves by gas only (RELAYDEP1) |
| T2 (S1) | A opens a USDC offer below min ($1) | $1 | refused (UI or `open_rejected` log), funds back in Escrow balance |
| T3 (S2) | A opens $10 USDC, cancels/lets the operator reclaim | $10 | full refund, no fee |
| T4 (S3) | A opens a short-fuse BTC price bet (AI judge, built-in venue, e.g. "BTC above X at <now+2h>"), B takes | $10 each | sourcecheck attest OK, keeper requests the run, `judge_backend: near-ai`, signed outcome, `finalize` after the window, winner gets pot − 1% (min $0.50/side); `verify-bet` PASS |
| T5 (S6) | wNEAR bet at the min (≈2.72 NEAR/side), settled fast by **concede** (RFRZ2d path) | min | payout exact in 24 dp, fee = max(1%, 0.1357 NEAR) |
| T6 (S12) | `30-views.sh` again + the web's judge-models page shows the 4-pair chain | — | all PASS |
| T7 (S11) | Reconcile: escrow `mt_balance_of` per asset == outstanding bets; `praetorial.near` (fee account) received the fees | — | residue = expected |

Can wait (after tonight, before listing): S4 VOID after deadline (needs a bet to run past `resolve_deadline`), S5 challenge round
(+$5 bond), S7 USDT/BTC/ETH/ZEC min bets, S8 sponsored no-NEAR user (RELAYDEP1 now requires users to hold NEAR for deposits), S9
pause/unpause drill with `praetorial.near`, S10 keeper-stall alert (needs the alerts bot token). Never run `emergency_shutdown` on mainnet.
Abort: T4/T5 wrong payout or verify-bet FAIL → keep unlisted, pause new offers (runbook §9), report.

---

## Web (step 13a/14): mainnet build
Profile: `NETWORK_ID=mainnet` selects `NETWORKS.mainnet` (escrow `bets.praetorial.near`, intents `intents.near`), the mainnet release
pins (`lib/release.mainnet.json`: resolver f9c61ec / `8791413f…`, fee `praetorial.near`) and the mainnet asset ids. Vite defines
`__PRAETORIAL_BUILD_NETWORK__`, so the testnet tables (network, assets, release pins, mock referees) are dropped from the bundle; the
proxy Worker (`wrangler.mainnet.toml`, `NETWORK_ID=mainnet`) uses service bindings to the `-mainnet` Workers only and returns 502 if a
binding is missing (it never falls back to a URL fetch). Fail-closed: selecting a network that is not in the build throws; an
unknown `NETWORK_ID` throws at build and returns 502 in the proxy; the mainnet registry is reached through `/_proxy/registry` (default URL: the mainnet registry Worker, REG1); and
`mainnetDeployGuard` refuses any `.testnet` id or `praetorial-dev-1101` in `dist/`, missing mainnet ids, stale limits, or an empty bundle.
DEPLOYFIX: it also refuses a `dist/` that lacks any mainnet service URL (`requiredMainnetUrls`: the funding Worker
`https://funding.praetorial.com` (1Click Add money / Cash out / Convert), the sourcecheck and registry Workers,
`/_proxy/{indexer,relayer,registry}`). The funding URL comes from `NETWORKS.mainnet.fundingUrl` (`lib/network.ts`); no env var is needed.
Then it diffs `dist/` against the LIVE mainnet bundle (`scripts/compare-live-bundle.mjs`, GETs only) and refuses if live has a service URL
that dist lacks. If the live site can't be read, it refuses (`GUARD_SKIP_LIVE=1` skips that step with a loud WARNING, only when there is no live site yet).
Testnet: `build:testnet` / `deploy:testnet` are unchanged (a testnet bundle built with this branch still has frz3, `usdc.testnet`,
the dev fee account and the testnet sourcecheck URL).

### Step 13a on the night (BOT, after step 8 `10-args.sh final`; build only)
```bash
cd apps/web
npm run gen:limits -- --args ../../release/mainnet-night/args.mainnet.json   # limits from the FINAL args (prices moved since the draft)
VITE_ESCROW_CONTRACT_ID=$(node -p 'require("../../release/mainnet-night/release-mainnet.json").mainnet_escrow.account') npm run build:mainnet
npm run guard:mainnet          # must print "current with release/mainnet-night/args.mainnet.json" and NO "WARNING ... DRAFT"
```
Abort: the guard prints `REFUSED` or a `DRAFT` warning → do not run step 14's `deploy:mainnet`. The guard's last line must be
`OK: dist has every service URL the live bundle has`. To diff by hand: `node scripts/compare-live-bundle.mjs` (repo root; `--dist <dir>`, `--origin <url>`).

### After every mainnet web deploy (PM, read-only, 1 min): post-deploy check
```bash
cd apps/web && npm run check:live:mainnet       # GET the live index.html + every assets/*.js it references
```
Expected: `PASS funding Worker (1Click Add money / Cash out / Convert): https://funding.praetorial.com`,
PASS for sourcecheck, registry, the three `/_proxy/*` paths and both mainnet ids, then `live check OK`, exit 0.
Abort: `LIVE CHECK FAILED` (exit 1) means users have no Add money / Cash out / Convert (or another service). Redeploy from a build that passes
`guard:mainnet`. Exit 2 means the site could not be read; retry. Note: the regenerated
`lib/assetLimits.generated.ts` then differs from `release/draft-args.mainnet.json`, so `assetsReleaseParity.unit.test.ts` fails until
the night's args are folded back in (GAPS W13). Deploy from that working tree; do not commit it to main as is.

### Dry run (KEYS2, 2026-11-10 ~20:08, fix/keys2; draft args because the final args do not exist yet; nothing deployed)
```
$ cd apps/web
$ ESC=$(node -p 'require("../../release/mainnet-night/release-mainnet.json").mainnet_escrow.account')   # bets.praetorial.near
$ VITE_ESCROW_CONTRACT_ID=$ESC npm run build:mainnet
✓ built in 4.08s                                                   exit 0
$ npm run guard:mainnet
WARNING: the web's per-asset limits come from DRAFT args, not the args the mainnet escrow was deployed with.
limits: lib/assetLimits.generated.ts is current with release/draft-args.mainnet.json
bundle: 263 js file(s), no testnet ids, mainnet ids present        exit 0
$ grep -l -F <id> dist/assets/*.js | wc -l
"bets.praetorial.near" 1 · "praetorial.near" 1 · lost escrow./fee./secrets. ids 0 · praetorial-frz3 0 · usdc.testnet 0
```
Tonight's DRAFT warning is expected (no final args yet); step 13a regenerates the limits from the FINAL args.

---

<!-- KEYS2-HISTORY -->
## History (pre-KEYS2 evidence, old account names; not instructions)
Step 0 read-only output before D-KEYS2 (escrow./fee./secrets. were later lost, D-KEYS2):
```
praetorial.near                  3.7659 NEAR  ... keys[1] FA:Cfnpwrax
escrow.praetorial.near           6.5000 NEAR  ... code 1111111111  keys[1] FA:5Re1FAGW
fee.praetorial.near              0.1000 NEAR  ... keys[1] FA:CrfvarDX
keeper.praetorial.near           1.0000 NEAR  ... keys[1] FA:FXCAmAaU
operator.praetorial.near         0.1000 NEAR  ... keys[1] FA:4y8pCuYz
ops.praetorial.near              0.5000 NEAR  ... keys[1] FA:CkX38zfq
relayer.praetorial.near      MISSING (UNKNOWN_ACCOUNT)
attest.praetorial.near       MISSING (UNKNOWN_ACCOUNT)
secrets.praetorial.near      MISSING (UNKNOWN_ACCOUNT)
mainnet config is deploy-ready (0 findings)
| BTC  | coinbase BTC-USD | 73879.635 | kraken XBTUSD | 73944.70000 | 0.088068 | 2026-11-10T14:49:16.000Z |
| ETH  | coinbase ETH-USD | 2066.675  | kraken ETHUSD | 2069.42000  | 0.132822 | ...
| NEAR | coinbase NEAR-USD | 3.68415  | kraken NEARUSD | 3.68930    | 0.139788 | ...
| ZEC  | coinbase ZEC-USD | 1174.82   | kraken ZECUSD | 1177.56000  | 0.233227 | ...
ok: wrote .../dryrun/args.mainnet.json (6 assets, network mainnet, all asserts passed)
PENDING attest_pubkey (OutLayer-sourced: ...)
PENDING outcome_pubkey (OutLayer-sourced: ...)
PENDING outlayer_config.wasm_base_url (OutLayer-sourced: ...)
NOT DEPLOYABLE: 3 OutLayer-sourced field(s) pending; everything else passed the --final checks
```

### Web dry run (2026-11-10, fix/mainprep @ 018fd45d + the web change; draft args because the final args do not exist yet)
```
$ cd apps/web
$ ESC=$(node -p 'require("../../release/mainnet-night/release-mainnet.json").mainnet_escrow.account')   # escrow.praetorial.near
$ VITE_ESCROW_CONTRACT_ID=$ESC npm run build:mainnet
> NETWORK_ID=mainnet VITE_NETWORK_ID=mainnet VITE_INDEXER_URL=/_proxy/indexer VITE_RELAYER_URL=/_proxy/relayer VITE_REGISTRY_URL=/_proxy/registry VITE_SOURCECHECK_URL=https://sourcecheck.praetorial.com/sourcecheck npm run build
> tsc -p tsconfig.json --noEmit && vite build
vite v5.4.21 building for production...
dist/assets/index-B6azsg07.js       325.12 kB │ gzip: 122.40 kB
dist/assets/core-BFP1WBor.js        597.00 kB │ gzip: 170.23 kB
dist/assets/index-C3Lhwg_7.js     2,496.86 kB │ gzip: 767.59 kB
(… 263 js chunks, 6.8 MB dist; only the usual >500 kB chunk-size warning)
✓ built in 5.12s                                                   exit 0
$ npm run guard:mainnet
WARNING: release/mainnet-night/args.mainnet.json not found -- asset limits are checked against DRAFT args (release/draft-args.mainnet.json).
limits: lib/assetLimits.generated.ts is current with release/draft-args.mainnet.json
bundle: 263 js file(s), no testnet ids, mainnet ids present        exit 0
$ grep -l -F <id> dist/assets/*.js | wc -l
"escrow.praetorial.near" 1 · "intents.near" 1 · "fee.praetorial.near" 1 · praetorial-sourcecheck-mainnet 1 · /_proxy/indexer 1
praetorial-frz3 0 · usdc.testnet 0 · wrap.testnet 0
```
Tonight's DRAFT warning is expected (no final args yet). The final args move the BTC/ETH/ZEC/wNEAR minimums by up to 8% (dry-run
prices), which is why step 13a regenerates the limits. Nothing was deployed.

Step 3 as run by familiarcow ~19:25 (relayer./attest., his phrase at the prompt; both accounts verified on chain):
```bash
near account create-account fund-myself relayer.praetorial.near '2 NEAR' use-manually-provided-public-key ed25519:9c4HDV9AACggXAHUWxK2f1UhPDxPBkNu19VgBu5SbmX6 sign-as praetorial.near network-config mainnet sign-with-seed-phrase
near account create-account fund-myself attest.praetorial.near '1 NEAR' use-manually-provided-public-key ed25519:2pjNQ2La8u1R4svywQFRCUWhHC6oYMpU8CF6a3uzdsHt sign-as praetorial.near network-config mainnet sign-with-seed-phrase
```
