# TESTPY1: resolve ONE known-good python (has judge-proto's deps) for every python step in test.sh.
# Usage: PY="$(ts_resolve_python)" || exit 1     (prints the interpreter path on stdout; diagnostics on stderr)
# Order: $PRAETORIAL_PYTHON (never falls back if set but bad) -> repo-local .venv (created/repaired
# from judge-proto/requirements.txt via pip) -> loud failure. Never silently skips.
# Test hooks: PRAETORIAL_VENV_DIR (default .venv), PRAETORIAL_BOOTSTRAP_PYTHON (default python3).

_ts_py_ok() { "$1" -c 'import cryptography.hazmat.primitives.asymmetric.ed25519' >/dev/null 2>&1; }

ts_resolve_python() {
  local root venv boot py
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  if [ -n "${PRAETORIAL_PYTHON:-}" ]; then
    if [ ! -x "$PRAETORIAL_PYTHON" ] && ! command -v "$PRAETORIAL_PYTHON" >/dev/null 2>&1; then
      echo "test.sh: PRAETORIAL_PYTHON='$PRAETORIAL_PYTHON' is not an executable python. Fix or unset it." >&2
      return 1
    fi
    if ! _ts_py_ok "$PRAETORIAL_PYTHON"; then
      echo "test.sh: PRAETORIAL_PYTHON='$PRAETORIAL_PYTHON' cannot import 'cryptography'. Install judge-proto deps into it (pip install -r judge-proto/requirements.txt) or unset PRAETORIAL_PYTHON to use the repo-local .venv." >&2
      return 1
    fi
    echo "$PRAETORIAL_PYTHON"
    return 0
  fi
  venv="${PRAETORIAL_VENV_DIR:-$root/.venv}"
  py="$venv/bin/python3"
  if [ ! -x "$py" ] || ! _ts_py_ok "$py"; then
    boot="${PRAETORIAL_BOOTSTRAP_PYTHON:-python3}"
    echo "test.sh: preparing $venv from judge-proto/requirements.txt (using $boot)..." >&2
    if ! { "$boot" -m venv "$venv" && "$py" -m pip install -q -r "$root/judge-proto/requirements.txt"; } >&2 2>&1 || ! _ts_py_ok "$py"; then
      echo "test.sh: FATAL no usable python with 'cryptography'. Set PRAETORIAL_PYTHON=/path/to/python3 (with cryptography installed), or fix: python3 -m venv .venv && .venv/bin/pip install -r judge-proto/requirements.txt" >&2
      return 1
    fi
  fi
  echo "$py"
}
