"""V1b / D-VER2: parity vectors for the origin-corroboration rules verify-bet B4 re-applies (D-ORIGIN1 / D-EXH1).
Python twin = judge.element_verdict_q. Same vectors: resolver/core/tests/verifier_b4_parity.rs (Rust) and
services/verifier/test/b4.test.ts (TS port). Run: python3 test_verifier_b4_parity.py"""
import json, os, sys
import judge as J

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services", "verifier", "test", "fixtures", "b4_parity.json")

def main():
    cases = json.load(open(P))["cases"]
    bad = 0
    for c in cases:
        got = J.element_verdict_q([tuple(r) for r in c["results"]], [dict({"party_controlled": False}, **s) for s in c["sources"]], c["quorum"])
        if got != c["expect"]:
            bad += 1
            print("FAIL %s: got %s want %s" % (c["name"], got, c["expect"]))
    print("%d cases, %d failed" % (len(cases), bad))
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
