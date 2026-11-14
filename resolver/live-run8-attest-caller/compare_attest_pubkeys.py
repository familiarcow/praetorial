"""Item 11(c): compare the `attest` pubkey the resolver wasm returns when run
by two different signer accounts. Same wasm hash, different pubkeys =>
the attest key is bound to the signer (manifest `caller` unset); equal =>
signer-independent (`caller: none`). Pure/offline: reads `outlayer run` logs."""
import json
import re


def parse_run_log(text):
    h = re.search(r"Hash: ([0-9a-f]{64})", text) or re.search(r"/([0-9a-f]{64})\.wasm", text)
    i = text.find("{", text.find("Tx:") if "Tx:" in text else 0)
    pk = None
    if i >= 0:
        try:
            pk = json.JSONDecoder().raw_decode(text[i:])[0]["signing"]["pubkey_hex"]
        except (ValueError, KeyError, TypeError):
            pk = None
    if not h or not pk or not re.fullmatch(r"[0-9a-f]{64}", pk):
        raise ValueError("log has no wasm hash / signing.pubkey_hex")
    return {"wasm_hash": h.group(1), "pubkey_hex": pk}


def verdict(a, b):
    if a["wasm_hash"] != b["wasm_hash"]:
        raise ValueError("runs used different wasm hashes; not comparable")
    return "signer-independent" if a["pubkey_hex"] == b["pubkey_hex"] else "signer-bound"
