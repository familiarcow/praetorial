#!/usr/bin/env bash
# KEYS2 (D-KEYS2a / D-KEYS2b): the BOT's key-file-signed mainnet transactions, in RUNBOOK order. Every subcommand that sends a tx
# refuses without PRAETORIAL_MAINNET_GO=GO and checks the chain (read-only RPC views) before and after. Key files are only passed
# to near-cli by path (sign-with-access-key-file); nothing here reads or prints a private key.
#   15-keyfile-steps.sh preflight           read-only: key files present (mode 600, right account + public key); temp owner key on chain
#   15-keyfile-steps.sh create              step 3b: create bets. (6 NEAR) + aikey. (0.3 NEAR) from praetorial.near (owner-temp key file)
#   15-keyfile-steps.sh deploy              step 9: deploy the frozen escrow + new() on bets. (bets key file); code hash must be EfCgMFhe...
#   15-keyfile-steps.sh delete-bets-key     step 12: delete bets.'s only full-access key (bets key file), then rm the key file + OutLayer home
#   15-keyfile-steps.sh owner-temp-cleanup  step 15a: AFTER familiarcow deleted the temp key on chain: verify only their key is left, rm the file
set -uo pipefail
CMD=${1:?usage: 15-keyfile-steps.sh preflight|create|deploy|delete-bets-key|owner-temp-cleanup}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
RPC=${MAINNET_RPC:-https://free.rpc.fastnear.com}
: "${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir (holds praetorial-mainnet-keys/)}" "${PRAETORIAL_CACHE_DIR:?set PRAETORIAL_CACHE_DIR to the operator cache dir (holds mainnet-night/)}"
KEYS=$PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys   # fixed: the near-cli lines below name these paths literally
W=$PRAETORIAL_CACHE_DIR/mainnet-night
OWNER_FILE=$KEYS/owner-temp/praetorial.near-temp.json
BETS_FILE=$KEYS/bets/bets.praetorial.near.json
AIKEY_FILE=$KEYS/aikey/aikey.praetorial.near.json
TEMP_PK=ed25519:6eWbyxb82R32qxqmPmRM553u49YDZDHubwsmmavpYfuf
FAMILIARCOW_PK=ed25519:AtYDEhU4igU6WDhWu97BkK2g8HPCRaDReC968Y9mCvF1
BETS_PK=ed25519:3BiLqo5QjYkcTL1TnHDdT8ch7xJjGWwbGzUEZAK4HWYh
AIKEY_PK=ed25519:HKGkCQhpoStBPuG7CHfzLvH2XmuQe7d53SkUQux5MtLc
CODE_HASH=EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q
WASM=$W/escrow-caf134a4.wasm
WASM_SHA=caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f
ARGS=$REPO/release/mainnet-night/args.mainnet.json

die() { echo "REFUSED: $*" >&2; exit 1; }
go() { [ "${PRAETORIAL_MAINNET_GO:-}" = "GO" ] || { echo "refusing: needs PRAETORIAL_MAINNET_GO=GO (GATE-11, D-KEYS2b)" >&2; exit 3; }; }
q() { curl -s -m 15 "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"$1\",\"finality\":\"final\",\"account_id\":\"$2\"}}"; }
# keys <acct>: sorted "FA:<pk>" / "FC:<pk>" lines, or MISSING
keys() { q view_access_key_list "$1" | python3 -I -c 'import json,sys
r=json.load(sys.stdin).get("result")
if r is None: print("MISSING"); sys.exit()
print("\n".join(sorted(("FA:" if k["access_key"]["permission"]=="FullAccess" else "FC:")+k["public_key"] for k in r["keys"])))'; }
code_hash() { q view_account "$1" | python3 -I -c 'import json,sys; r=json.load(sys.stdin).get("result"); print(r["code_hash"] if r else "MISSING")'; }
balance() { q view_account "$1" | python3 -I -c 'import json,sys; r=json.load(sys.stdin).get("result"); print("%.4f" % (int(r["amount"])/1e24) if r else "MISSING")'; }
# keyfile <path> <account> <public key>: present, mode 600, names that account + public key (prints only account/public key)
keyfile() {
  [ -f "$1" ] || die "key file missing: $1"
  [ "$(stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1")" = "600" ] || die "key file $1 is not mode 600"
  python3 -I - "$1" "$2" "$3" <<'PY' || exit 1
import json, sys
k = json.load(open(sys.argv[1]))
if k.get("account_id") != sys.argv[2] or k.get("public_key") != sys.argv[3]:
    sys.exit(f"REFUSED: {sys.argv[1]} is for {k.get('account_id')} {k.get('public_key')}, expected {sys.argv[2]} {sys.argv[3]}")
print(f"key file OK  {sys.argv[2]}  {sys.argv[3]}")
PY
}
expect_keys() { local got want; got=$(keys "$1"); want=$(printf '%s\n' "$2" | sort); [ "$got" = "$want" ] || die "$1 keys are '${got//$'\n'/ }', expected '${want//$'\n'/ }'"; echo "chain OK  $1 keys: ${got//$'\n'/ }"; }

case "$CMD" in
preflight)
  keyfile "$OWNER_FILE" praetorial.near "$TEMP_PK"
  keyfile "$BETS_FILE" bets.praetorial.near "$BETS_PK"
  keyfile "$AIKEY_FILE" aikey.praetorial.near "$AIKEY_PK"
  expect_keys praetorial.near "FA:$FAMILIARCOW_PK"$'\n'"FA:$TEMP_PK"
  echo "praetorial.near balance $(balance praetorial.near) NEAR (step 3b sends 6.3; keep >= 0.5 for guardian gas => need >= 6.9)"
  ;;
create)
  go
  keyfile "$OWNER_FILE" praetorial.near "$TEMP_PK"
  expect_keys praetorial.near "FA:$FAMILIARCOW_PK"$'\n'"FA:$TEMP_PK"
  for a in bets.praetorial.near aikey.praetorial.near; do [ "$(keys $a)" = MISSING ] || die "$a already exists (run '00-accounts.sh' and skip what is done)"; done
  near account create-account fund-myself bets.praetorial.near '6 NEAR' use-manually-provided-public-key ed25519:3BiLqo5QjYkcTL1TnHDdT8ch7xJjGWwbGzUEZAK4HWYh sign-as praetorial.near network-config mainnet sign-with-access-key-file $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/owner-temp/praetorial.near-temp.json send || die "create bets.praetorial.near failed"
  near account create-account fund-myself aikey.praetorial.near '0.3 NEAR' use-manually-provided-public-key ed25519:HKGkCQhpoStBPuG7CHfzLvH2XmuQe7d53SkUQux5MtLc sign-as praetorial.near network-config mainnet sign-with-access-key-file $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/owner-temp/praetorial.near-temp.json send || die "create aikey.praetorial.near failed"
  sleep 3
  expect_keys bets.praetorial.near "FA:$BETS_PK"; echo "bets.praetorial.near $(balance bets.praetorial.near) NEAR"
  expect_keys aikey.praetorial.near "FA:$AIKEY_PK"; echo "aikey.praetorial.near $(balance aikey.praetorial.near) NEAR"
  ;;
deploy)
  go
  keyfile "$BETS_FILE" bets.praetorial.near "$BETS_PK"
  expect_keys bets.praetorial.near "FA:$BETS_PK"
  [ "$(code_hash bets.praetorial.near)" = 11111111111111111111111111111111 ] || die "bets.praetorial.near already has code"
  [ "$(shasum -a 256 "$WASM" | cut -d' ' -f1)" = "$WASM_SHA" ] || die "$WASM is not the frozen escrow caf134a4"
  [ -f "$ARGS" ] || die "missing $ARGS: run 20-fill-outlayer.sh + 10-args.sh final (step 7) first"
  grep -q PLACEHOLDER "$ARGS" && die "$ARGS still has a PLACEHOLDER"
  echo "args sha256 $(shasum -a 256 "$ARGS" | cut -d' ' -f1)"
  cd "$REPO"
  near contract deploy bets.praetorial.near use-file $PRAETORIAL_CACHE_DIR/mainnet-night/escrow-caf134a4.wasm with-init-call new file-args release/mainnet-night/args.mainnet.json prepaid-gas '300 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-access-key-file $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/bets/bets.praetorial.near.json send || die "deploy + new() failed (read the panic; the whole tx reverts, so no code is on chain)"
  sleep 3
  got=$(code_hash bets.praetorial.near); [ "$got" = "$CODE_HASH" ] || die "bets.praetorial.near code hash $got != $CODE_HASH"
  echo "chain OK  bets.praetorial.near code $got (frozen caf134a4); balance $(balance bets.praetorial.near) NEAR"
  ;;
delete-bets-key)
  go
  V=${VERIFY_LOG:-$REPO/release/mainnet-night/logs/verify-escrow.txt}
  grep -q '^# 4 PASS, 0 FAIL, 0 SKIP' "$V" 2>/dev/null || die "step 11 verify-escrow did not record '# 4 PASS, 0 FAIL, 0 SKIP' in $V: do not lock the code"
  [ "$(code_hash bets.praetorial.near)" = "$CODE_HASH" ] || die "bets.praetorial.near does not carry the frozen code"
  expect_keys bets.praetorial.near "FA:$BETS_PK"
  near account delete-keys bets.praetorial.near public-keys ed25519:3BiLqo5QjYkcTL1TnHDdT8ch7xJjGWwbGzUEZAK4HWYh network-config mainnet sign-with-access-key-file $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/bets/bets.praetorial.near.json send || die "delete-keys failed"
  sleep 3
  got=$(keys bets.praetorial.near); [ -z "$got" ] || die "bets.praetorial.near still has keys: $got (key files kept)"
  echo "chain OK  bets.praetorial.near keys[0], code $(code_hash bets.praetorial.near): locked"
  rm -rf $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/bets
  rm -rf "$W/olhome-bets"
  [ ! -e "$KEYS/bets" ] && [ ! -e "$W/olhome-bets" ] && echo "deleted the bets key file and its OutLayer home"
  ;;
owner-temp-cleanup)
  expect_keys praetorial.near "FA:$FAMILIARCOW_PK"
  rm -rf $PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys/owner-temp
  [ ! -e "$KEYS/owner-temp" ] && echo "deleted the owner-temp key file: praetorial.near holds only familiarcow's key"
  ;;
*) echo "usage: 15-keyfile-steps.sh preflight|create|deploy|delete-bets-key|owner-temp-cleanup" >&2; exit 2 ;;
esac
