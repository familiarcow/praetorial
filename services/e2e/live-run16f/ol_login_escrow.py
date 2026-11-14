# Point the olhome-escrow16 OutLayer CLI home at the recreated escrow account's new key (never prints it).
import json, os
S = os.path.join(os.environ["PRAETORIAL_CACHE_DIR"], "scratch/olhome-escrow16/testnet/credentials.json")
N = os.path.expanduser("~/.near-credentials/testnet/praetorial-e2e-2611052236.praetorial-dev-1101.testnet.json")
c = json.load(open(S)); n = json.load(open(N))
c["public_key"] = n["public_key"]; c["private_key"] = n["private_key"]
json.dump(c, open(S, "w")); os.chmod(S, 0o600)
print("ok", c["account_id"], c["public_key"])
