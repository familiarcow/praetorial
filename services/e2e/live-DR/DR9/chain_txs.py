"""DR9 helper: recover the tx hash list from the public fastnear indexer (the live scripts' tx log was clobbered by a stale-save bug, fixed in lib.mjs).
usage: python3 -I chain_txs.py <account> ... ; prints ts, signer?, hash, for each account's signed txs (oldest first)."""
import json, sys, urllib.request
for acc in sys.argv[1:]:
    req = urllib.request.Request("https://tx.test.fastnear.com/v0/account", data=json.dumps({"account_id": acc, "limit": 100}).encode(), headers={"content-type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    rows = sorted(d["account_txs"], key=lambda r: int(r["tx_block_timestamp"]))
    for r in rows:
        if r.get("is_signer"):
            print(acc.split(".")[0], r["tx_block_timestamp"][:10], r["transaction_hash"])
