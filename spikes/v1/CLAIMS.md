# V1 claims audit (2026-11-11)

Every sentence of the About "How you can check it" section (apps/web/lib/about.ts, id `verify`, before V1) and every claim V1 adds,
checked against the code and the live mainnet chain. Read-only: public RPC views (`https://rpc.mainnet.fastnear.com`), the public
FastNEAR tx indexer (`https://tx.main.fastnear.com`), a FastFS download. No keys, no transactions.

Helper used for the views: `spikes/v1/rpcview.py <account> <method> [args]` (keyless `call_function`).

## Summary for the PM

| # | Claim (old About text) | Verdict |
|---|---|---|
| 1 | "The judge is an open program." | **FALSE** today |
| 2 | "Its fingerprint (8791413f…) is stored in the escrow contract" | TRUE |
| 3 | "the program itself is published on NEAR FastFS, so anyone can fetch it and check the fingerprint" | TRUE |
| 4 | "It runs inside OutLayer's TEE, a sealed computer that proves which program it is running." | **PARTLY** |
| 5 | "Nobody, including us, can change its answer." | **PARTLY** |
| 6 | "The escrow only accepts rulings signed by keys proven to come from that exact program." | **PARTLY** |
| 7 | "A ruling from anywhere else is refused." | TRUE |
| 8 | "The escrow's code can't be upgraded" | TRUE |
| 9 | "its admin key has been deleted" | TRUE |
| 10 | "so nobody can change how bets are paid." | **PARTLY** |

FALSE / PARTLY, in one line each:
- **1 FALSE**: the resolver's *compiled* program is public (FastFS), but its source code is not published anywhere: this repo has no
  remote (`git remote -v` is empty) and GATE-10 "public repo" is still open (release/mainnet-night/GAPS.md W7). Nobody outside can
  rebuild the wasm from source and compare. Reworded: "The judge is one fixed program…"; the About page says the source is not public yet.
- **4 PARTLY**: the escrow does ask OutLayer to run exactly that wasm, named by hash, and OutLayer's own on-chain event repeats the
  hash. That OutLayer runs it inside a TEE is OutLayer's claim; neither the escrow nor this app checks a TEE quote.
- **5 PARTLY**: nobody can *edit* a signed answer (the escrow checks the signature). But the answer depends on outside services the
  program reads (the source web pages, the NEAR AI model API), and OutLayer, as the operator of the sealed computer, is trusted.
- **6 PARTLY (the D-ATTEST1 question)**: on chain, the escrow accepts only signatures from ONE public key pinned at deploy
  (`outcome_pubkey`). It does **not** check, on chain, any OutLayer attestation tying that key to wasm 8791413f…. The link
  key ↔ program rests on OutLayer's key derivation (`bind: wasm`, caller = the escrow) and was checked **off chain** at deploy by a
  live `report-pubkey` run (release/mainnet-night/logs/verify-escrow.txt E4). The outcome key is bound to the caller
  `bets.praetorial.near`, whose keys are deleted, so the public cannot re-run that check themselves; the attest key (no caller
  binding) can be re-derived by anyone with an OutLayer account. D-ATTEST1 itself is about what the attest key signs (terms, clock),
  not about an on-chain key↔wasm proof.
- **10 PARTLY**: the code is frozen, but the guardian (praetorial.near) still has switches that change money flows: pause new
  offers; an emergency shutdown, after which every bet is refunded instead of paid to a winner; fee/minimum/stake-limit changes
  for NEW bets after a 24 h notice (a bet keeps the terms it opened with). Reworded to name them.

## Evidence

### 1. "The judge is an open program." — FALSE
- `git remote -v` in this repo: no remotes. release/mainnet-night/GAPS.md:29 (W7) lists "GATE-10 public repo" as not done.
- What IS public: the compiled wasm (claim 3) and every input/output on chain. So the program is *fixed and inspectable as a binary*,
  not open source.

### 2. Fingerprint stored in the escrow — TRUE
- `resolver_keys` view on `bets.praetorial.near` (2026-11-11, final):
  `["f67c1f8f…e440", "27070cba…0712", "8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473"]`
  = (outcome_pubkey, attest_pubkey, resolver_wasm_hash), contracts/escrow/src/lib.rs:1766-1772.
- Set once in `new()` (lib.rs:1684, 1736); no method writes it (lib.rs:1383-1384 doc; no setter in any `pub fn (&mut self)`).
- Equals release/mainnet-night/args.mainnet.json `resolver_wasm_hash` and apps/web/lib/release.mainnet.json.

### 3. Published on FastFS — TRUE
- `outlayer_config` view: `{"wasm_base_url":"https://main.fastfs.io/ops.praetorial.near/outlayer.near", …}`.
- The wasm path is `{wasm_base_url}/{resolver_wasm_hash}.wasm` (lib.rs:1587, 2924).
- `curl https://main.fastfs.io/ops.praetorial.near/outlayer.near/8791413f…2473.wasm` → HTTP 200, 3,404,255 bytes,
  `application/wasm`; `shasum -a 256` = `8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473`. Matches.

### 4. "Runs inside OutLayer's TEE … proves which program it is running" — PARTLY
- The escrow (not the keeper) calls `outlayer.near request_execution` with `code_source: WasmUrl{url, hash}` = the pinned hash
  (lib.rs:2784-2786, 2805-2830, 2924). OutLayer's on-chain events repeat it, e.g. mainnet tx
  `Dbp3M7nfrNKfyoyMunmnS5kHjacuU18NfVEqBRwgYw9m`: `execution_requested … "code_source":{"WasmUrl":{"url":"https://main.fastfs.io/…/8791413f….wasm","hash":"8791413f…"}}`
  and `execution_completed … "success":true`.
- The TEE itself (Intel TDX worker) is OutLayer's; no TDX/quote check exists in contracts/escrow or apps/web. The resolver only uses
  OutLayer's key API (resolver/wasm-bin/src/main.rs:4593-4606 `outlayer::signing_keys::{public_key,sign}`).

### 5. "Nobody, including us, can change its answer." — PARTLY
- TRUE part: `submit_outcome` verifies an ed25519 signature over borsh(escrow, bet_id, terms_hash, outcome, element_results_hash,
  run_no, checked_until, judge_pair_index[, next_check_ns][, observations]) under the pinned `outcome_pubkey`
  (lib.rs:3105, 3172, 3274, 3346; message = services/common/src/resolverSign.ts:82-85). Any edit breaks the signature.
- `submit_outcome` is permissionless (anyone may submit), so we can't block a signed answer either (keeper OR the web fallback,
  apps/web/lib/judgeRuling.ts).
- Not covered: the program's inputs come from outside (web pages, NEAR AI models); OutLayer as operator is trusted
  (enclave clock is not attested: Decision register D-ATTEST1a).

### 6. "Only keys proven to come from that exact program" — PARTLY (D-ATTEST1 question)
- On chain: one pinned key, no attestation check (lib.rs:1382-1392; 3172; 3274; 3346). `new()` only checks the key is 64 hex chars
  (lib.rs:1698-1700).
- Off chain: resolver/wasm-bin/manifest.json declares `{"path":"outcome","bind":"wasm","caller":"predecessor"}` and
  `{"path":"attest","bind":"wasm"}`; OutLayer derives each key from (wasm hash[, caller]). At deploy the bot ran `report-pubkey`
  with the pinned wasm as `bets.praetorial.near` and as `attest.praetorial.near`; both keys reproduced
  (release/mainnet-night/logs/verify-escrow.txt: `PASS E4 live report-pubkey of the pinned wasm reproduces the bound outcome
  pubkey (predecessor bets.praetorial.near) and attest pubkey`). Checked by services/verifier/src/e4.ts.
- Tested on testnet bet 49: the stored ruling's `signing.pubkey_hex` equals the escrow's outcome key and its signature verifies
  under it (apps/web/tests/verifyBet.unit.test.ts, real testnet data).

### 7. "A ruling from anywhere else is refused." — TRUE
- lib.rs:3274 / 3346 `require(verify_sig(&outcome_pubkey, …), …)`; no other path sets `outcome` for an AI bet (referee bets use
  `referee_rule`, which checks the caller is the bet's referee, lib.rs:3399).

### 8. "The escrow's code can't be upgraded" — TRUE
- `view_access_key_list bets.praetorial.near` (block 224151830): `"keys":[]`. With no access key nobody can sign a DeployContract.
- No contract path deploys code or adds a key: `grep deploy_contract|add_full_access_key|add_access_key|DeployContract|fn upgrade|fn migrate`
  over contracts/escrow/src/*.rs (excluding tests.rs): no match.
- `view_account`: `code_hash` `EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q` = release/mainnet-night/release-mainnet.json
  `escrow_code_hash_b58` (wasm sha256 `caf134a4…2f2f`).

### 9. "its admin key has been deleted" — TRUE
- Same `view_access_key_list` (empty). The deletion: mainnet tx `ACkj5srVv2nav4iUuszyefkEGtonjQJVfusbRAS36UT3`
  (`bets.praetorial.near` → itself, `DeleteKey`), after deploy tx `9gFoypqaFzHEnUmkecG6NarvzoH8fdg8Bn2TPfy34NpX`
  (`DeployContract` + `new`). Note: release-mainnet.json still says `"delete_key_tx": "PENDING"` (record not back-filled).

### 10. "so nobody can change how bets are paid." — PARTLY
- Guardian powers that remain (all event-logged): `pause_new_offers` (lib.rs:5148), `emergency_shutdown` (lib.rs:5216) then
  `emergency_refund` per bet (lib.rs:5279: each side gets its own deposit back), `propose_params`/`apply_params` (lib.rs:4829,
  4851; 24 h delay, hard caps; new bets only, D-PARAMS1), new judge pairs after a 7-day notice (`JUDGE_PAIR_DELAY_NS`,
  contracts/escrow/src/jc1.rs:6), new assets (24 h, lib.rs:4962). The guardian cannot move funds, pick a winner, or change the
  resolver, its keys or the code.

## Claims V1 adds (all TRUE, each re-checked)

| Claim | Evidence |
|---|---|
| The escrow tells OutLayer exactly which program to run, by its fingerprint | lib.rs:2784-2786, 2924; mainnet event above |
| OutLayer's own on-chain log names the program it ran | `execution_requested`/`execution_completed` events (`code_source.WasmUrl.hash`) |
| The AI ruling, its signature and the signing key are stored on chain with the bet | `get_bet.last_resolution_raw` (`result`, `signing.signature_hex`, `signing.pubkey_hex`), lib.rs `on_resolution` 2967 |
| The signature can be checked by anyone against the key in the escrow | `scripts/verify-bet.mjs` check `ruling-sig-*`, tests with real testnet bet 49 |
| The key was checked against the program once, at deploy, off chain | release/mainnet-night/logs/verify-escrow.txt E4 |
| The program file's sha256 equals the fingerprint | claim 3 |
| Terms hash = sha256 of the stored terms text | services/verifier/src/run.ts checkB1; scripts/verify-bet.mjs `terms-hash`; tests |
| The escrow has no access keys and its code hash is EfCgMFhe… | claims 8 and 9 |

## Reworded About text (what the site says now)

See apps/web/lib/about.ts `verify` section. The old bullets are replaced by numbered steps ("How to verify a bet") plus a short
"What this proves, and what it doesn't" list:
- "The judge is one fixed program. Its fingerprint is stored in the escrow and can't be changed. The program file is published on
  NEAR FastFS, so anyone can download it and check the fingerprint. Its source code is not public yet."
- "The escrow asks OutLayer to run exactly that program. OutLayer runs it in a sealed computer (a TEE). That part is OutLayer's
  promise: the escrow doesn't check it."
- "The escrow only accepts a ruling signed with one key, set when it was deployed. We checked once, at deploy, that this key belongs
  to that program. The escrow doesn't re-check it."
- "Nobody can edit a ruling after it is signed: the signature would no longer match. The judge's answer still depends on the
  source pages and the AI models it reads."
- "The escrow's code can't be changed and it has no keys left. We can still pause new offers, shut it down in an emergency (then
  every bet is refunded), and change fees for new bets after a 24 hour notice."
