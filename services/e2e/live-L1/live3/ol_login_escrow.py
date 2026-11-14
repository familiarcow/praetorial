# Point the olhome-l1b5 OutLayer CLI home at the fresh R3e escrow account's key (never prints it).
import json, os
S = os.path.join(os.environ["PRAETORIAL_CACHE_DIR"], "scratch/olhome-l1b5/testnet/credentials.json")
N = os.path.expanduser("~/.near-credentials/testnet/praetorial-l1b11-11072031.praetorial-dev-1101.testnet.json")
c = json.load(open(S)); n = json.load(open(N))
c["account_id"] = n["account_id"]; c["public_key"] = n["public_key"]; c["private_key"] = n["private_key"]
json.dump(c, open(S, "w")); os.chmod(S, 0o600)
print("ok", c["account_id"], c["public_key"])
