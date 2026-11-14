"""Item 11(c): attest `caller` decision hook. Run: python3 -m unittest -v test_compare
(from this directory). Not part of ./test.sh fast (needs only the recorded logs)."""
import os
import unittest

import compare_attest_pubkeys as m

HERE = os.path.dirname(os.path.abspath(__file__))
WASM = "cd853f8feb74f83041e936c3125ba85394b7547db46dbb7772b3bb20a6be19d7"


class Compare(unittest.TestCase):
    def rec(self, name):
        return m.parse_run_log(open(os.path.join(HERE, name)).read())

    def test_parses_recorded_live_logs(self):
        a = self.rec("signer_dev1101.log")
        b = self.rec("signer_escrow_e2e.log")
        self.assertEqual(a["wasm_hash"], WASM)
        self.assertEqual(b["wasm_hash"], WASM)
        self.assertEqual(len(a["pubkey_hex"]), 64)

    def test_recorded_two_signer_runs_are_signer_bound(self):
        a = self.rec("signer_dev1101.log")
        b = self.rec("signer_escrow_e2e.log")
        v = m.verdict(a, b)
        self.assertEqual(v, "signer-bound")
        self.assertNotEqual(a["pubkey_hex"], b["pubkey_hex"])

    def test_equal_pubkeys_would_mean_caller_none(self):
        a = self.rec("signer_escrow_e2e.log")
        self.assertEqual(m.verdict(a, dict(a)), "signer-independent")

    def test_refuses_to_compare_different_wasm_hashes(self):
        a = self.rec("signer_escrow_e2e.log")
        b = dict(self.rec("signer_dev1101.log"), wasm_hash="0" * 64)
        with self.assertRaises(ValueError):
            m.verdict(a, b)

    def test_log_without_pubkey_is_rejected(self):
        with self.assertRaises(ValueError):
            m.parse_run_log("Hash: " + WASM + " (1 bytes)\nno json here")


if __name__ == "__main__":
    unittest.main()
