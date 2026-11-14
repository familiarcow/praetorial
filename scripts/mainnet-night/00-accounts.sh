#!/usr/bin/env bash
# MAINPREP1: read-only state of every mainnet Praetorial account (balance, code hash, access keys). Never signs.
set -uo pipefail
RPC=${MAINNET_RPC:-https://free.rpc.fastnear.com}
q() { curl -s -m 10 "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"$1\",\"finality\":\"final\",\"account_id\":\"$2\"}}"; }
# KEYS2 (D-KEYS2): escrow contract = bets.praetorial.near, fee account = praetorial.near, OutLayer secrets owner = aikey.praetorial.near.
for a in praetorial.near bets.praetorial.near aikey.praetorial.near keeper.praetorial.near operator.praetorial.near ops.praetorial.near \
         relayer.praetorial.near attest.praetorial.near; do
  acct=$(q view_account "$a"); keys=$(q view_access_key_list "$a")
  python3 -I - "$a" "$acct" "$keys" <<'PY'
import json, sys
a, acct, keys = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
r = acct.get("result")
if not r: print(f"{a:28} MISSING ({acct.get('error',{}).get('cause',{}).get('name')})"); sys.exit()
ks = keys.get("result", {}).get("keys", [])
kd = ",".join(("FA:" if k["access_key"]["permission"] == "FullAccess" else "FC:") + k["public_key"][8:16] for k in ks)
print(f"{a:28} {int(r['amount'])/1e24:10.4f} NEAR  locked-storage {r['storage_usage']*1e-5:7.4f} NEAR  code {r['code_hash'][:10]}  keys[{len(ks)}] {kd}")
PY
done
