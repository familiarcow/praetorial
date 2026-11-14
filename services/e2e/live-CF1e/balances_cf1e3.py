import json, urllib.request
for a in ["relayer.praetorial-dev-1101.testnet", "praetorial-dev-1101.testnet", "keeper.praetorial-dev-1101.testnet"]:
    req = urllib.request.Request("https://rpc.testnet.near.org", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"request_type": "view_account", "finality": "final", "account_id": a}}).encode(), {"content-type": "application/json"})
    r = json.load(urllib.request.urlopen(req))
    print(a, int(r["result"]["amount"]) / 1e24 if "result" in r else r.get("error", r)["cause"]["name"] if "error" in r else r)
