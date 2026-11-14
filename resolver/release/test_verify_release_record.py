"""Tests for verify_release_record.py (queue item 14). Run: python3 test_verify_release_record.py"""
import copy, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFY = os.path.join(HERE, "verify_release_record.py")
TEMPLATE = os.path.join(HERE, "release-record.template.json")
H = "a" * 64
GOOD = {
    "repo": "praetorial (local git, no remote)",
    "commit": "b" * 40,
    "image": "outlayer/wasmedge-compiler",
    "image_digest": "sha256:" + "c" * 64,
    "platform": "linux/amd64",
    "target": "wasm32-wasip2",
    "features": "real-http,outlayer-sign",
    "hash": H,
    "builds": [
        {"route": "docker-run-1", "sha256": H},
        {"route": "docker-run-2", "sha256": H},
        {"route": "fresh-container", "sha256": H},
    ],
}


def run(rec):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(rec, f)
    try:
        return subprocess.run([sys.executable, "-I", VERIFY, f.name], capture_output=True, text=True)
    finally:
        os.unlink(f.name)


class T(unittest.TestCase):
    def test_good_record_passes(self):
        self.assertEqual(run(GOOD).returncode, 0)

    def test_template_has_all_fields_and_is_not_a_valid_release(self):
        t = json.load(open(TEMPLATE))
        for k in ("repo", "commit", "image_digest", "platform", "hash", "builds"):
            self.assertIn(k, t)
        self.assertNotEqual(run(t).returncode, 0)  # placeholders must not verify

    def test_differing_hash_fails(self):
        r = copy.deepcopy(GOOD); r["builds"][2]["sha256"] = "d" * 64
        p = run(r); self.assertNotEqual(p.returncode, 0); self.assertIn("differ", p.stderr + p.stdout)

    def test_hash_must_equal_builds(self):
        r = copy.deepcopy(GOOD); r["hash"] = "e" * 64
        self.assertNotEqual(run(r).returncode, 0)

    def test_fewer_than_three_builds_fails(self):
        r = copy.deepcopy(GOOD); r["builds"] = r["builds"][:2]
        self.assertNotEqual(run(r).returncode, 0)

    def test_non_amd64_fails(self):
        r = copy.deepcopy(GOOD); r["platform"] = "linux/arm64"
        self.assertNotEqual(run(r).returncode, 0)

    def test_image_digest_must_be_sha256(self):
        r = copy.deepcopy(GOOD); r["image_digest"] = "latest"
        self.assertNotEqual(run(r).returncode, 0)

    def test_missing_commit_fails(self):
        r = copy.deepcopy(GOOD); del r["commit"]
        self.assertNotEqual(run(r).returncode, 0)


if __name__ == "__main__":
    unittest.main()
