#!/usr/bin/env bash
# TESTPY1: the python resolver in tests/lib/python.sh. No network, no venv creation.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
. tests/lib/python.sh 2>/dev/null || { echo "FAIL cannot source tests/lib/python.sh"; exit 1; }
tmp="$(mktemp -d)"

# fake pythons: 'good' has cryptography (exit 0 on any args), 'bad' lacks it (exit 1)
printf '#!/bin/sh\nexit 0\n' > "$tmp/good"
printf '#!/bin/sh\nexit 1\n' > "$tmp/bad"
chmod +x "$tmp/good" "$tmp/bad"

# 1. PRAETORIAL_PYTHON wins when set and has cryptography
out="$(PRAETORIAL_PYTHON="$tmp/good" ts_resolve_python 2>&1)"; rc=$?
[ $rc -eq 0 ] && [ "$out" = "$tmp/good" ] && ok "PRAETORIAL_PYTHON picked" || bad "PRAETORIAL_PYTHON picked (rc=$rc out=$out)"

# 2. PRAETORIAL_PYTHON lacking cryptography -> loud failure, no fallback, message names the fix
out="$(PRAETORIAL_PYTHON="$tmp/bad" ts_resolve_python 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "cryptography" && echo "$out" | grep -q "judge-proto/requirements.txt"; then ok "python lacking cryptography fails loudly"; else bad "lacking cryptography (rc=$rc out=$out)"; fi

# 3. PRAETORIAL_PYTHON nonexistent -> loud failure
out="$(PRAETORIAL_PYTHON="$tmp/nope" ts_resolve_python 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "PRAETORIAL_PYTHON"; then ok "missing PRAETORIAL_PYTHON fails loudly"; else bad "missing python (rc=$rc)"; fi

# 4. unset + venv that cannot be fixed (bootstrap python is broken) -> loud failure, not pass
out="$(unset PRAETORIAL_PYTHON; PRAETORIAL_VENV_DIR="$tmp/venv" PRAETORIAL_BOOTSTRAP_PYTHON="$tmp/bad" ts_resolve_python 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -qi "PRAETORIAL_PYTHON"; then ok "unfixable venv fails loudly"; else bad "unfixable venv (rc=$rc out=$out)"; fi

# 5. requirements pin cryptography; .venv ignored
grep -qE '^cryptography==' judge-proto/requirements.txt && ok "requirements pins cryptography" || bad "requirements pin"
git check-ignore -q .venv && ok ".venv gitignored" || bad ".venv gitignored"

rm -r "$tmp"
exit $fail
