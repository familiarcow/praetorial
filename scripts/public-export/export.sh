#!/usr/bin/env bash
# HK1: build the tree familiarcow would publish as the public hackathon repo.
#
#   scripts/public-export/export.sh <outdir> [--ref <git-ref>] [--no-git]
#   scripts/public-export/export.sh --retriage <outdir>   # list current gitleaks hits as path:rule:line (never values)
#
# What it does (read-only on this repo: no push, no remote, no history rewrite):
#   1. `git archive <ref>` (default: main) minus the pathspecs in exclude.txt  ->  <outdir>
#   2. gitleaks on <outdir> (redacted), ignoring only the hand-triaged fingerprints in gitleaks-triaged.ignore
#   3. ed25519 secret-key check (cryptographic, see check_ed25519.py) and a private-material scan (scan_private.py):
#      FAIL on any secret key, vault path, Telegram bot token or .near-credentials / .env file; other types are counted
#   4. prints the file count and writes a sha256 manifest to <outdir>.MANIFEST.sha256 (outside the tree)
#   5. unless --no-git: `git init` in <outdir> and ONE commit "hackathon-submission" + tag hackathon-submission
#      (local only; publishing is familiarcow's step, see spikes/hk1/PUBLISH-STEPS.md)
# Exit 0 only if every check passed. Needs: git, gitleaks, python3 with `cryptography` (set PY=..., else .venv or python3).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
REF=main; GIT=1; RETRIAGE=0; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --no-git) GIT=0; shift ;;
    --retriage) RETRIAGE=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "export.sh: unknown flag $1" >&2; exit 1 ;;
    *) OUT="$1"; shift ;;
  esac
done
[ -n "$OUT" ] || { echo "usage: export.sh <outdir> [--ref <ref>] [--no-git]" >&2; exit 1; }
command -v gitleaks >/dev/null || { echo "export.sh: gitleaks not found (brew install gitleaks)" >&2; exit 1; }
PY="${PY:-}"
if [ -z "$PY" ]; then
  for c in "$REPO/.venv/bin/python3" python3; do
    if "$c" -c 'import cryptography' >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
[ -n "$PY" ] || { echo "export.sh: need python3 with 'cryptography' (pip install cryptography, or PY=/path/to/python3)" >&2; exit 1; }

if [ "$RETRIAGE" = 1 ]; then
  [ -d "$OUT" ] || { echo "export.sh --retriage: $OUT does not exist" >&2; exit 1; }
  T="$(mktemp)"; (cd "$OUT" && gitleaks dir . --redact=100 --no-banner --report-format json --report-path "$T" >/dev/null 2>&1) || true
  "$PY" -I -c 'import json,sys; [print(x["Fingerprint"]) for x in json.load(open(sys.argv[1]))]' "$T" | sort -u; rm -f "$T"
  exit 0
fi

OUT="$(mkdir -p "$OUT" && cd "$OUT" && pwd)"
[ -z "$(ls -A "$OUT")" ] || { echo "export.sh: $OUT is not empty; use a new directory" >&2; exit 1; }
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"

# 1. archive minus exclusions
PATHSPECS=(.)
while IFS= read -r line; do
  line="${line%%#*}"; line="$(echo "$line" | sed 's/[[:space:]]*$//')"
  [ -n "$line" ] && PATHSPECS+=(":(exclude,glob)$line")
done < "$HERE/exclude.txt"
git -C "$REPO" archive --format=tar "$SHA" -- "${PATHSPECS[@]}" | tar -x -C "$OUT"
TOTAL_AT_REF=$(git -C "$REPO" ls-tree -r --name-only "$SHA" | wc -l | tr -d ' ')
COUNT=$(cd "$OUT" && find . -type f -o -type l | grep -v '^\./\.git/' | wc -l | tr -d ' ')
echo "export: $REF @ ${SHA:0:12} -> $OUT"
echo "export: $COUNT files ($((TOTAL_AT_REF - COUNT)) of $TOTAL_AT_REF excluded by exclude.txt)"
[ -f "$OUT/LICENSE" ] || { echo "FAIL: no LICENSE in the export" >&2; exit 1; }

FAIL=0
# 2. gitleaks (values redacted; triaged fingerprints only). Report kept outside the tree.
rc=0
(cd "$OUT" && gitleaks dir . --redact=100 --no-banner --gitleaks-ignore-path "$HERE/gitleaks-triaged.ignore" \
   --report-format json --report-path "$OUT.gitleaks.json" --exit-code 3 >/dev/null 2>&1) || rc=$?
if [ "$rc" = 0 ]; then
  echo "PASS gitleaks: 0 untriaged findings"
else
  echo "FAIL gitleaks (exit $rc): untriaged findings below (path:rule:line, values never printed):"
  "$PY" -I -c 'import json,sys; [print("  ", x["Fingerprint"]) for x in json.load(open(sys.argv[1]))]' "$OUT.gitleaks.json" || true
  FAIL=1
fi
# 3a. ed25519 secret keys (cryptographic check)
if "$PY" -I "$HERE/check_ed25519.py" tree "$OUT"; then echo "PASS ed25519: no secret key"; else echo "FAIL ed25519: secret key material in the export"; FAIL=1; fi
# 3b. private material
"$PY" -I "$HERE/scan_private.py" tree "$OUT" > "$OUT.private-scan.tsv" 2> "$OUT.private-scan.summary" || true
BLOCK=$(awk -F'\t' '$3=="vault-path"||$3=="telegram-bot-token"||$3=="env-file"||$3=="near-credentials-file"' "$OUT.private-scan.tsv" | wc -l | tr -d ' ')
sed 's/^/  /' "$OUT.private-scan.summary"
if [ "$BLOCK" = 0 ]; then echo "PASS private-material: 0 blocking hits (vault path, bot token, .env, .near-credentials); counts above are informational, see $OUT.private-scan.tsv (values redacted)"
else echo "FAIL private-material: $BLOCK blocking hits:"; awk -F'\t' '$3=="vault-path"||$3=="telegram-bot-token"||$3=="env-file"||$3=="near-credentials-file"' "$OUT.private-scan.tsv" | sed 's/^/  /'; FAIL=1; fi

# 4. manifest
(cd "$OUT" && find . \( -type f -o -type l \) -not -path './.git/*' | LC_ALL=C sort | sed 's#^\./##' | while IFS= read -r f; do
  if [ -L "$f" ]; then printf '%s  %s\n' "$(printf 'symlink:%s' "$(readlink "$f")" | shasum -a 256 | cut -d' ' -f1)" "$f"; else shasum -a 256 "$f"; fi
done) > "$OUT.MANIFEST.sha256"
echo "manifest: $OUT.MANIFEST.sha256 ($(wc -l < "$OUT.MANIFEST.sha256" | tr -d ' ') entries, sha256 $(shasum -a 256 "$OUT.MANIFEST.sha256" | cut -c1-64))"

if [ "$FAIL" != 0 ]; then echo "export: FAILED checks -- do not publish"; exit 1; fi

# 5. one local commit + tag (no remote)
if [ "$GIT" = 1 ]; then
  git -C "$OUT" init -q -b main
  git -C "$OUT" add -A
  git -C "$OUT" -c commit.gpgsign=false commit -q -m "hackathon-submission" -m "Praetorial, NEAR HACKATHON submission. Clean export of the private repo at ${SHA:0:12} ($REF), built by scripts/public-export/export.sh. Full development history (2026-11-01 onward) available on request."
  git -C "$OUT" tag hackathon-submission
  echo "git: $(git -C "$OUT" log --oneline -1) (tag hackathon-submission); no remote configured"
fi
echo "export: OK"
