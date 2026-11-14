#!/usr/bin/env python3
"""NOKEY1: tests for check_key_bound.py (release preflight: NEAR_AI_API_KEY bound for (escrow, exact 64-char wasm hash))."""
import os, subprocess, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_key_bound as c

ESC = "praetorial-frz2-2611091914.praetorial-dev-1101.testnet"
H = "6517a422f55639d5d452ba2abcea93cc261c33729025be2afd5efcfa42d3b1c3"
LIST = (
    "PROFILE         ACCESSOR                       ACCESS         \n"
    "default         WasmHash(e114ad62...)          allow-all      \n"
    "praetorial-resolver WasmHash(3dd936d8...)          from:praetorial-e2e-2611052236.praetorial-dev-1101.testnet\n"
    "praetorial-resolver WasmHash(6517a422...)          from:" + ESC + "\n"
)


class T(unittest.TestCase):
    def test_bound_passes(self):
        self.assertEqual(c.check(LIST, ESC, H), [])

    def test_wrong_escrow_fails(self):
        p = c.check(LIST, "praetorial-other.testnet", H)
        self.assertTrue(p and "from:praetorial-other.testnet" in p[0])

    def test_unbound_hash_fails(self):
        p = c.check(LIST, ESC, "ab" * 32)
        self.assertTrue(p and "abababab" in p[0])

    def test_hash_bound_for_a_different_escrow_only_fails(self):
        p = c.check(LIST, ESC, "3dd936d8" + "0" * 56)
        self.assertTrue(p)

    def test_wrong_profile_fails(self):
        self.assertTrue(c.check(LIST.replace("praetorial-resolver", "default"), ESC, H))

    def test_allow_all_row_does_not_count(self):
        l = "default WasmHash(6517a422...) allow-all\n"
        self.assertTrue(c.check(l, ESC, H))

    def test_short_or_bad_hash_is_refused(self):
        for bad in ["6517a422", H[:63], H + "0", H.upper(), "z" * 64, ""]:
            self.assertTrue(c.check(LIST, ESC, bad), bad)

    def test_empty_escrow_refused(self):
        self.assertTrue(c.check(LIST, "", H))

    def test_prefix_is_not_a_substring_match(self):
        # a row for 16517a42 must not satisfy 6517a422
        l = "praetorial-resolver WasmHash(16517a42...) from:" + ESC + "\n"
        self.assertTrue(c.check(l, ESC, H))

    def test_escrow_must_match_exactly_not_as_a_suffix(self):
        l = "praetorial-resolver WasmHash(6517a422...) from:x" + ESC + "\n"
        self.assertTrue(c.check(l, ESC, H))

    def test_main_fails_and_never_prints_a_key(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write(LIST + "secret NEAR_AI_API_KEY=sk-live-ABCDEF0123456789ABCDEF0123456789\n")
        try:
            script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check_key_bound.py")
            ok = subprocess.run([sys.executable, "-I", script, "--escrow", ESC, "--hash", H, "--list-file", f.name], capture_output=True, text=True)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            bad = subprocess.run([sys.executable, "-I", script, "--escrow", "praetorial-nope.testnet", "--hash", H, "--list-file", f.name], capture_output=True, text=True)
            self.assertEqual(bad.returncode, 1)
            self.assertNotIn("sk-live", ok.stdout + ok.stderr + bad.stdout + bad.stderr)
        finally:
            os.unlink(f.name)


if __name__ == "__main__":
    unittest.main()
