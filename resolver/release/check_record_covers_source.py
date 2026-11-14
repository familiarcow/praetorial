#!/usr/bin/env python3
"""RR6 guard: the current resolver release record (release dir CURRENT pointer) must cover the current resolver source.
EXP2: history-independent. The pointer replaces git-log order; when the record's commit is in the repo the
`git diff <commit> <ref>` check still runs, and the record's per-file `source` digests are always compared
with the covered files (working tree), so a squashed clone is checked by content and any changed byte fails.
Logic and the covered paths: scripts/release/covers_source.py (COMPONENTS["resolver"]).
Usage: check_record_covers_source.py [--repo DIR] [--ref HEAD]"""
import argparse, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "scripts", "release"))
import covers_source  # noqa: E402

COMPONENT = "resolver"


def check(repo, ref="HEAD"):
    return covers_source.check(repo, COMPONENT, ref)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=ROOT)
    ap.add_argument("--ref", default="HEAD")
    a = ap.parse_args()
    return covers_source.main(["check", COMPONENT, "--repo", os.path.abspath(a.repo), "--ref", a.ref])


if __name__ == "__main__":
    sys.exit(main())
