# FRZ1b: DONE on branch feat/frz1b-freeze-candidate-2-deploy (rehearsal testnet deploy of freeze candidate 2)

Supersedes the FAIL-stop note below (FRZ1 step 4, kept as history).

- Escrow: praetorial-frz1b-2611081810.praetorial-dev-1101.testnet, wasm caf134a4... (record-c40e5fa, covers current escrow src per check_record_covers_source.py).
  Txs: create 516QZm8X8H8SSNvuKejouqY1pLuAfQx7k9ANYcdCcwuz, deploy uEW3DL9wcW1zzghG5pfyRGXZZRbpz4Ci7joD2Y1eP7o, new() Hf1882FtBfbsdmYwcPJ4f9jQDZfq1yoxjgNvNUxLAfBf.
- Resolver c1fa4242... (record-1733f97) on FastFS (upload.log).
- verify-escrow (live, with --outlayer-home-escrow/--outlayer-home-attest): E1 E2 E3 E4 all PASS, see verify-escrow.txt.
- Found live and fixed test-first: verify-escrow crashed in checkB6 (no bet); now runs only E1-E4 (runEscrowChecks).
- release/freeze-candidate-2.json rebuilt via the freeze-record CLI (testnet escrow, deploy tx, verify output sha).
- GATE-05 delta pass on bad77d8 (CAP3b) is CLEAN (vault Bots/praetorial-bot "GATE-05 delta drift pass bad77d8"), no escrow src change since: tag allowed.
- Tag freeze-candidate-2 is local only, never pushed. No freeze-candidate-1 tag.

---
# FRZ1 step 4 (testnet deploy + verify-escrow E1-E4): NOT DONE (FAIL-stop)

Reason: `services/verifier/src/run.ts` `checkE4()` is hardcoded to return SKIP ("offline: pubkey reproduction needs a live
OutLayer report-pubkey run"); no live E4 exists, so `verify-escrow` can never print `PASS E4` (see live-WT1/verify_bet2_open.txt: E4 SKIP).
Acceptance "E1-E4 must all PASS" is therefore unattainable without new code (live E4 = OutLayer report-pubkey run bound to the
fresh escrow account + wasm hash, spends OutLayer credit) which is outside FRZ1 scope.

Further prerequisites for E2/E3 on a fresh escrow, also not yet satisfied:
- resolver record-e2db201 (hash 0015abc2...) wasm is "not uploaded" to FastFS (E3 fetches <wasm_base_url>/<hash>.wasm);
- outcome/attest pubkeys in release/draft-input.testnet.json are the R3e pubkeys; they are bound to the OLD escrow account, so
  a fresh account needs its own report-pubkey run before new();
- storage: the 472310-byte wasm locks ~4.72 NEAR in the fresh account (> the 3 NEAR cap if locked storage counts as spend; refundable only by deleting the account).
Deployer account available: praetorial-dev-1101.testnet (~7.67 testnet NEAR at 2026-11-08 09:45).
Freeze record release/freeze-candidate-2.json is the draft WITHOUT testnet_escrow; rerun `freeze-record ... --testnet-escrow A --deploy-tx T --verify-output F` after step 4.

## D-FRZ1 ruling (FRZ1a merged; step 4 deferred to FRZ1b)
Per D-FRZ1 (praetorial-bot under D-PM3) steps 1-3 (freeze-record CLI, draft args, draft record) are merged as FRZ1a.
`release/freeze-candidate-2.json` is `status: "draft"`; testnet escrow account, deploy tx, verify output, E1-E4 and tag are all
`"pending FRZ1b"` (written via `freeze-record ... --pending-frz1b yes`). No testnet tx, no tag was made.
FRZ1b (live E4, FastFS upload of the resolver wasm, fresh testnet deploy, E1-E4, tag) is a separate later item, not started.
A record that claims a deploy without `--verify-output` is refused by the CLI.
