#!/usr/bin/env python3
"""NOKEY1 release preflight: is NEAR_AI_API_KEY bound for (escrow, exact resolver wasm hash)?

A real-http resolver without the key has no judge (NOKEY1: it now emits an unsigned `no_live_judge_key` error, never a signed
outcome). So before a release/deploy, the OutLayer secret must exist under the secrets-owner account's home with
profile = outlayer_config.secrets_profile, accessor = WasmHash(<resolver hash>) and access `from:<escrow>`.

Usage:  OUTLAYER_HOME=<secrets-owner home> check_key_bound.py --escrow <account> --hash <64-hex> [--profile praetorial-resolver]
                                                              [--list-file F]   (F = saved `outlayer secrets list -v` output; offline/tests)
Exit 0 = bound, 1 = NOT bound (release must stop), 2 = usage/tool error.
Never prints a key: only the metadata table is read (the CLI's `secrets list` is metadata-only) and any long token is redacted.
LIMIT: `secrets list` shows only the first 8 hex chars of a hash; the full 64 chars are validated here (shape) and must be the
escrow's pinned hash (compare with `resolver_keys` / release.json); an 8-char prefix collision is not distinguishable from the list.
"""
import argparse, os, re, subprocess, sys

HEX64 = re.compile(r"^[0-9a-f]{64}$")
ROW = re.compile(r"^(?P<profile>\S+)\s+WasmHash\((?P<prefix>[0-9a-f]{8})\.\.\.\)\s+(?P<access>.*?)\s*$")


def check(listing, escrow, hash64, profile="praetorial-resolver"):
    """Return a list of problems ([] = bound)."""
    if not isinstance(hash64, str) or not HEX64.match(hash64):
        return ["hash must be the full 64-char lowercase hex resolver wasm sha256 (got %d chars)" % len(hash64 or "")]
    if not escrow or not re.match(r"^[a-z0-9._-]+$", escrow):
        return ["escrow account id missing or malformed"]
    want_access = "from:" + escrow
    prefix = hash64[:8]
    for line in listing.splitlines():
        m = ROW.match(line.strip())
        if m and m["profile"] == profile and m["prefix"] == prefix and m["access"] == want_access:
            return []
    return ["NEAR_AI_API_KEY is NOT bound: no row `%s WasmHash(%s...) %s` in `outlayer secrets list -v` (secrets-owner home). "
            "Run: OUTLAYER_HOME=<secrets-owner home> bash services/e2e/live-run16r/bind_secret.sh %s %s. "
            "Without it the resolver emits no outcome at all (NOKEY1)." % (profile, prefix, want_access, escrow, hash64)]


def _redact(s):
    return re.sub(r"[A-Za-z0-9_\-]{50,}", "<r>", s)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--escrow", required=True)
    ap.add_argument("--hash", required=True)
    ap.add_argument("--profile", default="praetorial-resolver")
    ap.add_argument("--list-file")
    a = ap.parse_args(argv)
    if a.list_file:
        listing = open(a.list_file).read()
    else:
        ol = os.environ.get("OL") or os.path.expanduser("~/.local/bin/outlayer")
        try:
            r = subprocess.run([ol, "secrets", "list", "-v"], capture_output=True, text=True, timeout=120)
        except Exception as e:  # missing CLI, timeout
            print("preflight error: cannot run `outlayer secrets list -v`: %s" % type(e).__name__, file=sys.stderr)
            return 2
        if r.returncode != 0:
            print("preflight error: `outlayer secrets list -v` exited %d: %s" % (r.returncode, _redact(r.stderr)[:300]), file=sys.stderr)
            return 2
        listing = r.stdout
    problems = check(listing, a.escrow, a.hash, a.profile)
    if problems:
        for p in problems:
            print("FAIL " + _redact(p))
        return 1
    print("OK: NEAR_AI_API_KEY bound for escrow %s, resolver hash %s (profile %s)" % (a.escrow, a.hash, a.profile))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
