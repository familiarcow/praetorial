#!/usr/bin/env python3
"""Tests for check_record_covers_source.py on throwaway git repos (EXP2: CURRENT pointer + content digests)."""
import json, os, subprocess, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_record_covers_source as c
import covers_source as cs  # put on sys.path by the wrapper

REL = "resolver/release"
SRC = "resolver/core/src/lib.rs"
LOCK = "resolver/Cargo.lock"
COMP = "resolver"


def g(d, *a, env=None):
    return subprocess.run(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@l", *a],
                          check=True, capture_output=True, text=True, env=env).stdout.strip()


def w(d, rel, s):
    p = os.path.join(d, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(s)


def squash(d):
    """Replace history with one commit (every file added at the same time), like the public export."""
    out = tempfile.mkdtemp(dir=os.path.dirname(d))
    subprocess.run(f"git -C {d} archive HEAD | tar -x -C {out}", shell=True, check=True)
    g(out, "init", "-q"); g(out, "add", "-A")
    env = dict(os.environ, GIT_AUTHOR_DATE="2026-01-01T00:00:00Z", GIT_COMMITTER_DATE="2026-01-01T00:00:00Z")
    g(out, "commit", "-qm", "squash", env=env)
    return out


class T(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = os.path.join(self.t.name, "r"); os.mkdir(self.d)
        g(self.d, "init", "-q")
        w(self.d, SRC, "a"); w(self.d, LOCK, "l")
        g(self.d, "add", "-A"); g(self.d, "commit", "-qm", "src")
        self.src = g(self.d, "rev-parse", "HEAD")

    def rec(self, commit, name="record-x.json", pointer=True, source=True, **extra):
        r = {"commit": commit, "hash": "f" * 64, **extra}
        if source:
            r["source"] = cs.source_block(cs.manifest(self.d, commit if len(commit) == 40 and commit != "0" * 40 else "HEAD", COMP, worktree=False))
        w(self.d, f"{REL}/{name}", json.dumps(r))
        if pointer:
            w(self.d, f"{REL}/CURRENT", name + "\n")
        g(self.d, "add", "-A"); g(self.d, "commit", "-qm", "rec")

    def errs(self, d=None):
        return c.check(d or self.d)[0]

    # --- today's behaviour (full history) ---
    def test_fresh_passes(self):
        self.rec(self.src)
        self.assertEqual(self.errs(), [])

    def test_src_change_fails(self):
        self.rec(self.src)
        w(self.d, SRC, "b"); g(self.d, "commit", "-qam", "chg")
        self.assertTrue(self.errs())

    def test_lockfile_change_fails(self):
        self.rec(self.src)
        w(self.d, LOCK, "m"); g(self.d, "commit", "-qam", "chg")
        self.assertTrue(self.errs())

    def test_uncommitted_src_change_fails(self):
        self.rec(self.src)
        w(self.d, SRC, "b")
        self.assertTrue(any("source differs" in e for e in self.errs()), self.errs())

    def test_unrelated_change_ok(self):
        self.rec(self.src)
        w(self.d, "services/x.ts", "1"); g(self.d, "add", "-A"); g(self.d, "commit", "-qm", "u")
        self.assertEqual(self.errs(), [])

    def test_covered_new_file_fails(self):
        self.rec(self.src)
        w(self.d, "resolver/core/src/new.rs", "1"); g(self.d, "add", "-A"); g(self.d, "commit", "-qm", "u")
        self.assertTrue(self.errs())

    def test_newest_record_wins(self):
        self.rec(self.src, "record-old.json")
        w(self.d, SRC, "b"); g(self.d, "commit", "-qam", "chg")
        self.rec(g(self.d, "rev-parse", "HEAD"), "record-new.json")
        self.assertEqual(self.errs(), [])

    def test_unknown_commit_and_no_record_fail(self):
        self.assertTrue(self.errs())  # no pointer, no record
        self.rec("0" * 40, source=False)
        self.assertTrue(self.errs())  # commit absent and no content digests: cannot be verified

    def test_record_without_source_fails_even_with_commit(self):
        self.rec(self.src, source=False)
        self.assertTrue(any("no `source`" in e for e in self.errs()), self.errs())

    # --- EXP2: pointer ---
    def test_stale_pointer_fails(self):
        self.rec(self.src, "record-old.json")
        self.rec(self.src, "record-new.json", pointer=False)  # new record added, CURRENT not moved
        self.assertTrue(any("stale pointer" in e for e in self.errs()), self.errs())

    def test_pointer_to_missing_record_fails(self):
        self.rec(self.src)
        w(self.d, f"{REL}/CURRENT", "record-nope.json\n"); g(self.d, "commit", "-qam", "p")
        self.assertTrue(self.errs())

    # --- EXP2: squashed tree (no history, equal timestamps) ---
    def _two_records(self):
        self.rec(self.src, "record-a-old.json")   # sorts first, like record-0723fe2 did
        w(self.d, SRC, "b"); g(self.d, "commit", "-qam", "chg")
        self.rec(g(self.d, "rev-parse", "HEAD"), "record-z-new.json")

    def test_squashed_selects_current_and_passes_by_content(self):
        self._two_records()
        s = squash(self.d)
        errs, rec = c.check(s)
        self.assertEqual(errs, [])
        self.assertTrue(rec.endswith("record-z-new.json"), rec)

    def test_squashed_modified_source_fails(self):
        self._two_records()
        s = squash(self.d)
        w(s, SRC, "tampered")
        self.assertTrue(any("source differs" in e and SRC in e for e in self.errs(s)), self.errs(s))
        g(s, "commit", "-qam", "t")
        self.assertTrue(self.errs(s))

    def test_squashed_pointer_to_old_record_fails_by_content(self):
        self._two_records()
        w(self.d, f"{REL}/CURRENT", "record-a-old.json\n"); g(self.d, "commit", "-qam", "p")
        self.assertTrue(self.errs())  # history: stale pointer
        self.assertTrue(self.errs(squash(self.d)))  # squash: old record's source != tree

    # --- EXP2: rebuild record (public export) ---
    def test_rebuild_record_covers_rewritten_source(self):
        self.rec(self.src, "record-a.json")
        s = squash(self.d)
        w(s, SRC, "rewritten comment"); g(s, "commit", "-qam", "rw")
        self.assertTrue(self.errs(s))
        prov = g(s, "rev-parse", "HEAD")
        b = ["--build", "run-1=" + "f" * 64, "--build", "run-2=" + "f" * 64, "--build", "cp=" + "f" * 64]
        out = os.path.join(s, REL, "record-export.json")
        self.assertEqual(cs.main(["rebuild-record", COMP, out, "--of", "record-a.json", "--commit", prov,
                                  "--image-digest", "sha256:" + "0" * 64, "--repo", s, *b]), 0)
        self.assertEqual(json.load(open(out))["differs_from"], {"record": "record-a.json", "changed": [SRC], "absent": [], "added": []})
        g(s, "add", "-A"); g(s, "commit", "-qm", "rec")
        self.assertEqual(self.errs(s), [])
        w(s, SRC, "tampered after the rebuild")
        self.assertTrue(self.errs(s))

    def test_rebuild_record_with_other_hash_or_two_builds_is_ignored(self):
        self.rec(self.src, "record-a.json")
        w(self.d, SRC, "rw"); g(self.d, "commit", "-qam", "rw")
        prov = g(self.d, "rev-parse", "HEAD")
        src = cs.source_block(cs.manifest(self.d, prov, COMP, worktree=False))
        for bad in ({"hash": "e" * 64, "builds": [{"sha256": "e" * 64}] * 3},
                    {"hash": "f" * 64, "builds": [{"sha256": "f" * 64}] * 2}):
            w(self.d, f"{REL}/record-rb.json", json.dumps({"commit": prov, "rebuild_of": "record-a.json", "source": src, **bad}))
            self.assertTrue(cs.check(self.d, COMP, "HEAD")[0])

    def test_release_dir_tooling_change_ok(self):
        self.rec(self.src)
        w(self.d, "resolver/release/verify_release_record.py", "1"); g(self.d, "add", "-A"); g(self.d, "commit", "-qm", "u")
        self.assertEqual(self.errs(), [])


if __name__ == "__main__":
    unittest.main()
