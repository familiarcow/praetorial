#!/usr/bin/env python3
"""HK1 GATE-10: grep git history (all refs) or a directory tree for private material.

Never prints a matched value: every hit is reported as <type, len=N, sha256[:8]>.

Usage:
  python3 -I scan_private.py history <repo> [--rev-args "--all"]   # added lines of every commit
  python3 -I scan_private.py tree <dir>                            # files on disk (skips node_modules/target/.git)
Output: TSV rows  commit  path  type  redacted   (+ a per-type summary on stderr)
"""
import hashlib, os, re, subprocess, sys, collections

B58 = r"[1-9A-HJ-NP-Za-km-z]"
PATTERNS = [
    # built from parts so this file does not match itself
    ("vault-path", re.compile("Hermes" + r" Vault|~/" + r"Documents|/Users/[^/\s]+/" + "Documents")),
    ("hermes-path", re.compile(r"\.her" + r"mes\b")),
    ("home-path", re.compile(r"/Users/" + r"familiarcow\b")),
    ("telegram-bot-token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")),
    ("telegram-id", re.compile(r"(?i)(?:telegram|tg|chat)[_ -]?(?:chat[_ -]?)?id[\"']?\s*[:=]\s*[\"']?-?\d{6,14}")),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?:com|io|net|org|ai|dev|app|xyz|co|me)\b")),
    ("phone", re.compile(r"(?<![\w.])\+\d{1,3}[ -]?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b")),
    ("privy-otp", re.compile(r"(?i)privy[^\n]{0,60}\b(?:otp|code|pin)\b[^\n]{0,20}\b\d{6}\b|test-\d{4}@privy\.io")),
    ("ed25519-secret", re.compile(r"ed25519:" + B58 + r"{64,}")),
    ("near-credentials", re.compile(r"\.near-credentials")),
    ("private-key-assign", re.compile(r"(?i)(?:private[_-]?key|secret[_-]?key|seed[_-]?phrase|mnemonic)[\"']?\s*[:=]\s*[\"']?[A-Za-z0-9:+/_-]{20,}")),
    ("wrangler-secret-put", re.compile(r"wrangler secret put\s+\S+\s*(?:<<<|\|)\s*\S+")),
    ("internal-note", re.compile("MASTER" + r" MAP|Praetorial" + r" - [A-Z][A-Za-z ]+(?:spec|plan|notes|MAP)|\[\[[^\]\n]*\s[^\]\n]*\]\]|Defuse" + " Labs internal")),
]
# Values that are known-public / synthetic and should not be counted as private material.
ALLOW_EMAIL = re.compile(r"(?i)@(?:example\.(?:com|org)|anthropic\.com|users\.noreply\.github\.com|test\.com|local)\b|noreply@")
PATH_TYPES = [("env-file", re.compile(r"(^|/)\.env(\.|$)|\.env$")), ("near-credentials-file", re.compile(r"\.near-credentials/"))]
ALLOW_ENV_PATH = re.compile(r"\.env\.example$")


def redact(v):
    return f"REDACTED(len={len(v)},sha256:{hashlib.sha256(v.encode()).hexdigest()[:8]})"


def scan_line(line):
    for typ, rx in PATTERNS:
        for m in rx.finditer(line):
            v = m.group(0)
            if typ == "email" and ALLOW_EMAIL.search(v):
                continue
            yield typ, v


def emit(rows, commit, path, typ, v):
    rows[(typ, path, redact(v))].append(commit)


def history(repo, rev_args):
    rows = collections.defaultdict(list)
    cmd = ["git", "-C", repo, "log", *rev_args.split(), "-p", "--no-color", "--no-ext-diff", "-U0", "--format=@@COMMIT %H", "--text"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    commit = path = None
    for raw in p.stdout:
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if line.startswith("@@COMMIT "):
            commit = line[9:17]
        elif line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else line[4:]
            for typ, rx in PATH_TYPES:
                if rx.search(path) and not ALLOW_ENV_PATH.search(path):
                    emit(rows, commit, path, typ, path)
        elif line.startswith("+") and not line.startswith("+++"):
            for typ, v in scan_line(line[1:]):
                emit(rows, commit, path, typ, v)
    p.wait()
    return rows


def tree(root):
    rows = collections.defaultdict(list)
    skip = {"node_modules", "target", ".git", ".venv", ".wrangler", "fresh"}
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in skip and not x.startswith("target-")]
        for f in files:
            p = os.path.join(d, f)
            rel = os.path.relpath(p, root)
            for typ, rx in PATH_TYPES:
                if rx.search(rel) and not ALLOW_ENV_PATH.search(rel):
                    emit(rows, "tree", rel, typ, rel)
            try:
                with open(p, "r", errors="replace") as fh:
                    for i, line in enumerate(fh, 1):
                        for typ, v in scan_line(line):
                            emit(rows, "tree", f"{rel}:{i}", typ, v)
            except (IsADirectoryError, OSError):
                pass
    return rows


def main():
    mode, target = sys.argv[1], sys.argv[2]
    rows = history(target, sys.argv[4] if len(sys.argv) > 4 else "--all") if mode == "history" else tree(target)
    summary = collections.Counter()
    for (typ, path, red), commits in sorted(rows.items()):
        summary[typ] += 1
        print(f"{commits[0]}\t{path}\t{typ}\t{red}\t(commits={len(set(commits))})")
    for typ, n in summary.most_common():
        print(f"SUMMARY {typ}: {n} distinct (path,value) pairs", file=sys.stderr)


if __name__ == "__main__":
    main()
