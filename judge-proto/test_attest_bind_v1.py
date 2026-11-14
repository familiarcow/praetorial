"""D-ATTEST1 (queue item 7g4): archive snapshot admission is bound to the on-chain submit
time ([captured_at, captured_at + 15min]) and to the bet's terms_hash. Mirrors the
resolver/core tests of the same names (Python/Rust parity)."""
import hashlib, json, sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
import evidence as E
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

SK = Ed25519PrivateKey.from_bytes(bytes([7]) * 32) if hasattr(Ed25519PrivateKey, "from_bytes") else Ed25519PrivateKey.from_private_bytes(bytes([7]) * 32)
PK = SK.public_key().public_bytes_raw().hex()
TERM = {"bet_id": "jason-bet-1", "time": {"window_start": "2026-11-04T00:00:00Z", "window_end": "2028-10-28T19:00:00Z"},
        "sources_allowed": [{"id": "S_CB", "publisher": "Coinbase BTC-USD", "url": "https://a.example/p"}]}
BODY = "coinbase BTC-USD candle high 118500.00"
CAP = "2028-06-15T14:32:00Z"

def terms_hash(term):
    # the contract's terms_hash is sha256 of the raw term-sheet string (resolver terms_hash_ok)
    return hashlib.sha256(json.dumps(term, sort_keys=True).encode()).hexdigest()

def snap(onchain, th=None, bet="jason-bet-1", source="Coinbase BTC-USD"):
    th = th or terms_hash(TERM)
    h = hashlib.sha256(BODY.encode()).hexdigest()
    sig = SK.sign(E.archive_message(bet, source, CAP, th, h).encode()).hex() if th else ""
    return {"source_type": "archive_snapshot", "source_id": source, "captured_at": CAP, "body": BODY,
            "resolver_sig": sig, "terms_hash": th, "onchain_submitted_at": onchain}

def check(name, got, want):
    ok = got == want
    print(("PASS" if ok else "FAIL"), name)
    return ok

def main():
    th = terms_hash(TERM)
    r = [
        check("submitted_equals_captured_ok", E.is_resolver_archive(snap("2028-06-15T14:32:00Z"), TERM, PK, th), True),
        check("submitted_captured_plus_15min_ok", E.is_resolver_archive(snap("2028-06-15T14:47:00Z"), TERM, PK, th), True),
        check("backdated_snapshot_rejected", E.is_resolver_archive(snap("2028-06-15T14:31:59Z"), TERM, PK, th), False),
        check("late_posted_snapshot_rejected", E.is_resolver_archive(snap("2028-06-15T14:47:01Z"), TERM, PK, th), False),
        check("missing_onchain_submitted_at_rejected", E.is_resolver_archive({k: v for k, v in snap("x").items() if k != "onchain_submitted_at"}, TERM, PK, th), False),
        check("terms_hash_mismatch_rejected", E.is_resolver_archive(snap("2028-06-15T14:32:00Z", th="f" * 64), TERM, PK, th), False),
        check("terms_hash_field_swapped_after_signing_rejected",
              E.is_resolver_archive({**snap("2028-06-15T14:32:00Z"), "terms_hash": "e" * 64}, TERM, PK, th), False),
    ]
    sys.exit(0 if all(r) else 1)

if __name__ == "__main__":
    main()
