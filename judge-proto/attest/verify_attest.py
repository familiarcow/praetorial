"""Verify a NEAR AI response receipt: (1) signed text = hashes of our exact request/response,
(2) ed25519 signature valid, (3) signing key is bound inside a fresh TDX quote (report_data) with our nonce."""
import json, hashlib, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
req=open("req.json","rb").read(); resp=open("resp.json","rb").read()
sig=json.load(open("sig.json")); att=json.load(open("att.json")); nonce=open("nonce.txt").read().strip()
H=lambda b: hashlib.sha256(b).hexdigest()
text=sig["text"]; parts=text.split(":")
print("signed text fields:", len(parts), "| kind:", sig.get("signature_kind"))
print("1a request hash matches :", H(req) in text)
print("1b response hash matches:", H(resp) in text)
pk=bytes.fromhex(sig["signing_address"])
try: Ed25519PublicKey.from_public_bytes(pk).verify(bytes.fromhex(sig["signature"]), text.encode()); print("2  ed25519 signature    : VALID")
except Exception as e: print("2  ed25519 signature    : INVALID", e)
g=att["gateway_attestation"]
print("3a key == attested key  :", g.get("signing_address")==sig["signing_address"])
q=bytes.fromhex(g["intel_quote"]); rd=q[568:632]   # TDX quote v4: header 48 + report body offset 520 -> report_data (64B)
print("   quote version/tee    :", int.from_bytes(q[0:2],"little"), q[4:8].hex())
print("   report_data          :", rd.hex()[:64], "...", rd.hex()[64:])
print("3b report_data has key  :", pk.hex()[:32] in rd.hex() or H(pk)[:32] in rd.hex())
print("3c report_data has nonce:", nonce in rd.hex())
print("   attestation keys     :", [k for k in g if k!="intel_quote"])
m=att["model_attestations"][0]; print("   model attestation    :", {k:(str(v)[:80]) for k,v in m.items()})
