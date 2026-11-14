#!/usr/bin/env bash
# INTENTS1: ~$5 round trip through the REAL mainnet intents.near, in exactly the shapes the web uses
# (apps/web/lib/moveToBetting.ts, withdraw.ts; real ABI pinned in fixtures/intents_near/real_abi.json):
#   1. wrap.near   near_deposit                         (attach AMOUNT NEAR; first deposit keeps 0.00125 NEAR storage)
#   2. wrap.near   ft_transfer_call(intents.near, wNEAR received, msg {"receiver_id": SIGNER})   1 yocto
#   3. view        intents.near mt_balance_of(SIGNER, "nep141:wrap.near") must rise by exactly that amount
#   4. intents.near ft_withdraw(token "wrap.near", receiver_id SIGNER, amount)                    1 yocto
#   5. wrap.near   near_withdraw(amount)  (unwrap back to native NEAR)                            1 yocto
# Expected cost: gas (~0.003 NEAR) + 0.00125 NEAR wrap.near storage if the signer was never registered. Nothing else.
#
# DEFAULT IS A DRY RUN: prints the exact transaction JSON and does free read-only view calls (skip them with --offline).
# --live broadcasts, and only when MAINNET_SMOKE_OK=yes AND --signer is given; it signs with the SIGNER's own key via
# near-cli-rs (keychain by default, --sign-with ledger|legacy-keychain). The build bot never runs --live: familiarcow does.
#
# usage: scripts/mainnet-intents-smoke.sh [--signer ACCOUNT] [--amount-near 1.5] [--offline]
#        MAINNET_SMOKE_OK=yes scripts/mainnet-intents-smoke.sh --live --signer ACCOUNT [--sign-with keychain|ledger|legacy-keychain]
set -euo pipefail

INTENTS="intents.near"
WRAP="wrap.near"
TOKEN_ID="nep141:wrap.near"
RPC="${MAINNET_RPC_URL:-https://rpc.mainnet.near.org}"
NEAR_CLI="${NEAR_CLI:-near}"
MAX_NEAR="3"                                   # smoke cap (~$5-10); refuse anything bigger
STORAGE_FEE="1250000000000000000000"           # wrap.near storage_balance_bounds().min (view 2026-11-10)
GAS_30="30000000000000"; GAS_100="100000000000000"

LIVE=0; OFFLINE=0; SIGNER=""; AMOUNT_NEAR="1.5"; SIGN_WITH="keychain"
die() { echo "REFUSED: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --live) LIVE=1 ;;
    --offline) OFFLINE=1 ;;
    --signer) SIGNER="${2:-}"; shift ;;
    --amount-near) AMOUNT_NEAR="${2:-}"; shift ;;
    --sign-with) SIGN_WITH="${2:-}"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done

if [ "$LIVE" = 1 ]; then
  [ "${MAINNET_SMOKE_OK:-}" = "yes" ] || die "--live needs MAINNET_SMOKE_OK=yes in the environment (exactly 'yes'). Nothing was sent."
  [ -n "$SIGNER" ] || die "--live needs --signer <your mainnet account>; the script never picks a key itself. Nothing was sent."
  [ "$OFFLINE" = 0 ] || die "--live cannot be --offline"
  case "$SIGN_WITH" in keychain|ledger|legacy-keychain) ;; *) die "--sign-with must be keychain, ledger or legacy-keychain" ;; esac
fi
SIGNER_SHOWN="${SIGNER:-your-account.near}"
[[ "$SIGNER_SHOWN" =~ ^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$ ]] || die "signer '$SIGNER_SHOWN' is not a NEAR account id"
[[ "$AMOUNT_NEAR" =~ ^[0-9]+(\.[0-9]{1,24})?$ ]] || die "--amount-near must be a decimal NEAR amount"

# Exact integer math (yocto) without floats.
py() { python3 -I -c "$1" "${@:2}"; }
AMOUNT_YOCTO=$(py 'import sys
w,_,f=sys.argv[1].partition(".")
print(int(w)*10**24+int((f+"0"*24)[:24] or 0))' "$AMOUNT_NEAR")
OVER=$(py 'import sys; print(1 if int(sys.argv[1]) > int(sys.argv[2])*10**24 else 0)' "$AMOUNT_YOCTO" "$MAX_NEAR")
[ "$OVER" = 0 ] || die "amount $AMOUNT_NEAR NEAR is above the smoke cap of $MAX_NEAR NEAR"
[ "$AMOUNT_YOCTO" != 0 ] || die "amount must be > 0"

# ---- free read-only RPC views (never signs anything)
view() { # view CONTRACT METHOD ARGS_JSON -> JSON result (or "null")
  local a; a=$(printf '%s' "$3" | base64 | tr -d '\n')
  curl -s --max-time 20 "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$a\"}}" |
    py 'import sys,json
r=json.load(sys.stdin)
res=r.get("result") or {}
if "result" not in res: sys.exit("view failed: "+json.dumps(r)[:300])
print(bytes(res["result"]).decode() or "null")'
}
num() { py 'import sys,json; v=json.loads(sys.argv[1]); print(int(v) if v is not None else 0)' "$1"; }
native() {
  curl -s --max-time 20 "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    py 'import sys,json; r=json.load(sys.stdin); print(r["result"]["amount"] if "result" in r else "MISSING")'
}

# The wNEAR the deposit will yield: the first near_deposit of an unregistered account keeps the storage fee.
REGISTERED="unknown (no --signer / offline: assuming NOT registered, fee taken)"
EXPECT_WNEAR=$(py 'import sys; print(int(sys.argv[1])-int(sys.argv[2]))' "$AMOUNT_YOCTO" "$STORAGE_FEE")
if [ "$OFFLINE" = 0 ]; then
  echo "== read-only preflight on $RPC (free view calls)"
  echo "   intents.near contract_source_metadata: $(view "$INTENTS" contract_source_metadata '{}' | py 'import sys,json; d=json.load(sys.stdin); print(d["version"], d["link"])')"
  echo "   intents.near storage-registered on wrap.near: $(view "$WRAP" storage_balance_of "{\"account_id\":\"$INTENTS\"}")"
  if [ -n "$SIGNER" ]; then # the placeholder may be someone's real account: only look up a signer that was given
    REG_JSON=$(view "$WRAP" storage_balance_of "{\"account_id\":\"$SIGNER\"}")
    if [ "$REG_JSON" != "null" ]; then REGISTERED="yes"; EXPECT_WNEAR="$AMOUNT_YOCTO"; else REGISTERED="no (near_deposit keeps $STORAGE_FEE yocto storage)"; fi
    echo "   wrap.near storage_balance_of($SIGNER): $REG_JSON -> registered: $REGISTERED"
    echo "   native balance: $(native "$SIGNER") yocto"
    echo "   wrap.near ft_balance_of: $(view "$WRAP" ft_balance_of "{\"account_id\":\"$SIGNER\"}")"
    echo "   intents.near mt_balance_of: $(view "$INTENTS" mt_balance_of "{\"account_id\":\"$SIGNER\",\"token_id\":\"$TOKEN_ID\"}")"
  fi
fi

tx() { # tx N TITLE RECEIVER METHOD ARGS_JSON GAS DEPOSIT -> prints the exact transaction JSON
  echo "--- TX $1 $2"
  py 'import sys,json
s,r,m,a,g,d=sys.argv[1:7]
print(json.dumps({"signer_id":s,"receiver_id":r,"actions":[{"FunctionCall":{"method_name":m,"args":json.loads(a),"gas":g,"deposit":d}}]},indent=2))' \
    "$SIGNER_SHOWN" "$3" "$4" "$5" "$6" "$7"
  echo "--- END TX $1"
}
MSG=$(py 'import sys,json; print(json.dumps(json.dumps({"receiver_id":sys.argv[1]},separators=(",",":"))))' "$SIGNER_SHOWN")
print_plan() { # print_plan WNEAR_AMOUNT
  tx 1 "wrap $AMOUNT_NEAR NEAR" "$WRAP" near_deposit '{}' "$GAS_30" "$AMOUNT_YOCTO"
  tx 2 "deposit the wNEAR received into intents.near" "$WRAP" ft_transfer_call "{\"receiver_id\":\"$INTENTS\",\"amount\":\"$1\",\"msg\":$MSG}" "$GAS_100" 1
  echo "--- VIEW (free) $INTENTS mt_balance_of {\"account_id\":\"$SIGNER_SHOWN\",\"token_id\":\"$TOKEN_ID\"} must rise by exactly $1"
  tx 3 "withdraw it back to the wallet (wNEAR)" "$INTENTS" ft_withdraw "{\"token\":\"$WRAP\",\"receiver_id\":\"$SIGNER_SHOWN\",\"amount\":\"$1\"}" "$GAS_100" 1
  tx 4 "unwrap to native NEAR" "$WRAP" near_withdraw "{\"amount\":\"$1\"}" "$GAS_30" 1
}

if [ "$LIVE" = 0 ]; then
  echo "== DRY RUN: nothing is signed or sent. Exact transactions (signer $SIGNER_SHOWN, network mainnet):"
  print_plan "$EXPECT_WNEAR"
  echo "== wNEAR amount in TX 2-4 assumes registered=$REGISTERED; --live reads the real amount from chain after TX 1."
  echo "== To run for real (familiarcow only): MAINNET_SMOKE_OK=yes $0 --live --signer <account> [--amount-near $AMOUNT_NEAR] [--sign-with keychain|ledger|legacy-keychain]"
  exit 0
fi

# ------------------------------------------------------------------------------------------------ LIVE (familiarcow signs)
command -v "$NEAR_CLI" >/dev/null || die "near-cli-rs ('$NEAR_CLI') not found"
[ "$(native "$SIGNER")" != "MISSING" ] || die "account $SIGNER does not exist on mainnet"
send() { # send RECEIVER METHOD ARGS_JSON GAS DEPOSIT_YOCTO
  echo "+ $NEAR_CLI contract call-function as-transaction $1 $2 json-args '$3' prepaid-gas '$(( $4 / 1000000000000 )) Tgas' attached-deposit '$5 yoctoNEAR' sign-as $SIGNER network-config mainnet sign-with-$SIGN_WITH send"
  "$NEAR_CLI" contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas "$(( $4 / 1000000000000 )) Tgas" \
    attached-deposit "$5 yoctoNEAR" sign-as "$SIGNER" network-config mainnet "sign-with-$SIGN_WITH" send
}
wnear() { num "$(view "$WRAP" ft_balance_of "{\"account_id\":\"$SIGNER\"}")"; }
mtbal() { num "$(view "$INTENTS" mt_balance_of "{\"account_id\":\"$SIGNER\",\"token_id\":\"$TOKEN_ID\"}")"; }
settle() { sleep 4; }
sub() { py 'import sys; print(int(sys.argv[1])-int(sys.argv[2]))' "$1" "$2"; }

echo "== LIVE on mainnet as $SIGNER. Planned (wNEAR amount re-read after TX 1):"
print_plan "$EXPECT_WNEAR"
read -r -p "Type 'send' to broadcast these with $SIGNER's key: " ok
[ "$ok" = "send" ] || die "not confirmed"

N0=$(native "$SIGNER"); W0=$(wnear); I0=$(mtbal)
send "$WRAP" near_deposit '{}' "$GAS_30" "$AMOUNT_YOCTO"; settle
W1=$(wnear); GOT=$(sub "$W1" "$W0")
echo "== TX1 done: wNEAR +$GOT"
[ "$(py 'import sys; print(int(sys.argv[1])>0)' "$GOT")" = "True" ] || die "near_deposit produced no wNEAR; stopping"
send "$WRAP" ft_transfer_call "{\"receiver_id\":\"$INTENTS\",\"amount\":\"$GOT\",\"msg\":$MSG}" "$GAS_100" 1; settle
I1=$(mtbal); CRED=$(sub "$I1" "$I0")
echo "== TX2 done: intents.near mt_balance_of($TOKEN_ID) +$CRED (expected +$GOT)"
[ "$CRED" = "$GOT" ] || die "intents credited $CRED, expected $GOT -- STOP and investigate (funds are in intents.near under $SIGNER or back in the wallet)"
send "$INTENTS" ft_withdraw "{\"token\":\"$WRAP\",\"receiver_id\":\"$SIGNER\",\"amount\":\"$CRED\"}" "$GAS_100" 1; settle
W2=$(wnear); I2=$(mtbal)
echo "== TX3 done: intents $I2 (was $I1), wallet wNEAR $W2 (was $(sub "$W1" "$GOT"))"
[ "$(sub "$W2" "$(sub "$W1" "$GOT")")" = "$CRED" ] || die "ft_withdraw did not deliver $CRED wNEAR -- check the tx; intents refunds a failed ft_transfer to the betting balance"
send "$WRAP" near_withdraw "{\"amount\":\"$CRED\"}" "$GAS_30" 1; settle
N1=$(native "$SIGNER")
echo "== ROUND TRIP OK. native before $N0, after $N1, cost $(sub "$N0" "$N1") yocto (gas + storage if first wrap)."
