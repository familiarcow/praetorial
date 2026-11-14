#!/usr/bin/env python3
"""HK1 GATE-10: classify every `ed25519:<base58 64+>` string as SECRET KEY or not.

A NEAR secret key is 64 bytes = seed(32) || pubkey(32), where pubkey == Ed25519(seed).public.
A NEAR signature is also 64 bytes, but its second half is NOT the public key of its first half.
Prints only counts and REDACTED fingerprints, never a value. Needs `cryptography`.

Usage:
  check_ed25519.py history <repo> [git-log rev args...]   (default --all; scans added lines of every commit)
  check_ed25519.py tree <dir>                             (scans files on disk; skips node_modules/target/.git)
Exit 0 = no secret key found, 2 = at least one secret key found.
"""
import collections, hashlib, os, re, subprocess, sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
RX = re.compile(r"ed25519:([1-9A-HJ-NP-Za-km-z]{64,})")


def b58d(s):
    n = 0
    for c in s:
        n = n * 58 + A.index(c)
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + b


def from_history(repo, revs):
    seen = {}
    p = subprocess.Popen(["git", "-C", repo, "log", *(revs or ["--all"]), "-p", "-U0", "--text", "--no-color", "--format=@@C %H"], stdout=subprocess.PIPE)
    commit = path = None
    for raw in p.stdout:
        l = raw.decode("utf-8", "replace")
        if l.startswith("@@C "):
            commit = l[4:12]
        elif l.startswith("+++ "):
            path = l[6:].strip()
        elif l.startswith("+"):
            for m in RX.finditer(l):
                seen.setdefault(m.group(1), (commit, path))
    p.wait()
    return seen


def from_tree(root):
    seen = {}
    skip = {"node_modules", "target", ".git", ".venv", ".wrangler"}
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in skip and not x.startswith("target-")]
        for f in files:
            p = os.path.join(d, f)
            if os.path.islink(p):
                continue
            try:
                with open(p, "r", errors="replace") as fh:
                    for i, line in enumerate(fh, 1):
                        for m in RX.finditer(line):
                            seen.setdefault(m.group(1), ("tree", f"{os.path.relpath(p, root)}:{i}"))
            except OSError:
                pass
    return seen


def main():
    mode = sys.argv[1]
    seen = from_history(sys.argv[2], sys.argv[3:]) if mode == "history" else from_tree(sys.argv[2])
    cls = collections.Counter()
    keys = []
    for v, (c, pth) in seen.items():
        b = b58d(v)
        if len(b) != 64:
            cls[f"not-64-bytes(len{len(b)})"] += 1
            continue
        pub = Ed25519PrivateKey.from_private_bytes(b[:32]).public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        if pub == b[32:]:
            cls["SECRET-KEY"] += 1
            keys.append((c, pth, f"REDACTED(sha256:{hashlib.sha256(v.encode()).hexdigest()[:8]})"))
        else:
            cls["signature-or-other(64B, not a keypair)"] += 1
    print(f"ed25519 check ({mode}): distinct values {len(seen)}: {dict(cls)}")
    for k in keys:
        print("SECRET-KEY", *k, sep="\t")
    sys.exit(2 if keys else 0)


if __name__ == "__main__":
    main()
