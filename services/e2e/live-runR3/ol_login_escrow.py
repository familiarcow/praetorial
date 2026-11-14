# Point the olhome-r3c OutLayer CLI home at the recreated escrow account's new key (never prints it).
import json, os
S = os.path.join(os.environ["PRAETORIAL_CACHE_DIR"], "scratch/olhome-r3c/testnet/credentials.json")
N = os.path.expanduser("~/.near-credentials/testnet/praetorial-r3c-11061912.praetorial-dev-1101.testnet.json")
c = json.load(open(S)); n = json.load(open(N))
c["account_id"] = n["account_id"]; c["public_key"] = n["public_key"]; c["private_key"] = n["private_key"]
json.dump(c, open(S, "w")); os.chmod(S, 0o600)
print("ok", c["account_id"], c["public_key"])
