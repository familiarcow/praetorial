"""Verify the sourcecheck_<kind>.log signature locally (same message as the contract)."""
import json, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
txt = open(sys.argv[1]).read()
o = json.loads(txt[txt.index("{", txt.index("Tx:")):])
s = o["signing"]
msg = f"praetorial:sourcecheck:v1:{o['spec_hash']}:{o['checked_at']}".encode()
Ed25519PublicKey.from_public_bytes(bytes.fromhex(s["pubkey_hex"])).verify(bytes.fromhex(s["signature_hex"]), msg)
print("VERIFIED", s["pubkey_hex"][:8], o["checked_at"])
