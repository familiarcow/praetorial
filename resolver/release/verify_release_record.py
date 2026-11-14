#!/usr/bin/env python3
"""Verify a Praetorial release record: all required fields present, image digest
pinned, platform linux/amd64, >=3 builds, every build hash identical and equal
to `hash`. Exit 0 ok, 1 invalid. Usage: verify_release_record.py record.json"""
import json, re, sys

REQUIRED = ("repo", "commit", "image_digest", "platform", "hash", "builds")


def check(rec):
    errs = []
    for k in REQUIRED:
        if k not in rec:
            errs.append(f"missing field: {k}")
    if errs:
        return errs
    if not re.fullmatch(r"[0-9a-f]{40}", str(rec["commit"])):
        errs.append("commit must be 40 lowercase hex")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(rec["image_digest"])):
        errs.append("image_digest must be sha256:<64 hex>")
    if rec["platform"] != "linux/amd64":
        errs.append("platform must be linux/amd64 (arm64 changes the bytes)")
    if not re.fullmatch(r"[0-9a-f]{64}", str(rec["hash"])):
        errs.append("hash must be 64 lowercase hex")
    builds = rec["builds"]
    if not isinstance(builds, list) or len(builds) < 3:
        errs.append("need at least 3 builds")
        return errs
    hs = {b.get("sha256") for b in builds}
    if len(hs) != 1:
        errs.append(f"build hashes differ: {sorted(map(str, hs))}")
    elif hs != {rec["hash"]}:
        errs.append("hash does not equal the build hashes")
    return errs


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    errs = check(json.load(open(argv[1])))
    for e in errs:
        print("INVALID:", e, file=sys.stderr)
    if not errs:
        print("release record OK")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
