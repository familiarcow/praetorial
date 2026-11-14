"""7g3: the live OutLayer sourcecheck signature must verify against the attest
pubkey over the sourcecheck_crosscheck message layout, and spec_hash must be
sha256 of the raw term sheet the job carried."""
import hashlib, json, os, unittest

import verify_attest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "..", "contracts", "escrow", "tests", "fixtures", "sourcecheck_crosscheck.json")


def load(name):
    with open(os.path.join(HERE, name)) as f:
        return json.load(f)


class VerifyAttest(unittest.TestCase):
    def test_message_layout_matches_crosscheck_fixture(self):
        fx = json.load(open(FIXTURE))
        msg = verify_attest.sourcecheck_message(fx["spec_hash"], int(fx["checked_at"]))
        self.assertEqual(msg.decode(), fx["message"])
        self.assertEqual(msg.hex(), fx["message_hex"])

    def test_live_signature_verifies_against_attest_pubkey(self):
        rec = load("attest_record.json")
        self.assertTrue(verify_attest.verify_record(rec))

    def test_spec_hash_is_sha256_of_raw_terms_in_job(self):
        rec = load("attest_record.json")
        job = load("job_sourcecheck.json")
        self.assertEqual(rec["output"]["spec_hash"], hashlib.sha256(job["terms"].encode()).hexdigest())

    def test_tampered_checked_at_or_spec_hash_fails(self):
        rec = load("attest_record.json")
        bad = json.loads(json.dumps(rec)); bad["output"]["checked_at"] += 4096
        self.assertFalse(verify_attest.verify_record(bad))
        bad = json.loads(json.dumps(rec)); bad["output"]["spec_hash"] = "0" * 64
        self.assertFalse(verify_attest.verify_record(bad))

    def test_wrong_pubkey_fails(self):
        rec = load("attest_record.json")
        rec["output"]["signing"]["pubkey_hex"] = "00" * 31 + "01"
        self.assertFalse(verify_attest.verify_record(rec))


if __name__ == "__main__":
    unittest.main()
