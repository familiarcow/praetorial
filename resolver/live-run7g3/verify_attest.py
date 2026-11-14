"""Verify a live OutLayer sourcecheck attestation (7g3).

Message layout = praetorial_core::sourcecheck_message
  b"praetorial:sourcecheck:v1:{spec_hash}:{checked_at_ns}"  (checked_at as decimal u64)
Signature = ed25519 over those raw bytes, pubkey = the wasm's "attest" key.
Usage: python3 verify_attest.py attest_record.json
"""
import json, sys
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def sourcecheck_message(spec_hash: str, checked_at_ns: int) -> bytes:
    return f"praetorial:sourcecheck:v1:{spec_hash}:{checked_at_ns}".encode()


def verify_record(rec: dict) -> bool:
    out = rec["output"]
    s = out.get("signing")
    if not out.get("ok") or not s:
        return False
    try:
        pk = Ed25519PublicKey.from_public_bytes(bytes.fromhex(s["pubkey_hex"]))
        pk.verify(bytes.fromhex(s["signature_hex"]), sourcecheck_message(out["spec_hash"], int(out["checked_at"])))
        return True
    except (InvalidSignature, ValueError):
        return False


if __name__ == "__main__":
    ok = verify_record(json.load(open(sys.argv[1])))
    print("VERIFIED" if ok else "FAILED")
    sys.exit(0 if ok else 1)
