# PUB1: node deps for test.sh steps, the same rule for services/ and apps/web: when <dir>/node_modules is missing,
# `npm ci` (lockfile) or `npm install` (no lockfile). A no-op when node_modules exists. A failed install returns
# non-zero with a message naming the dir, so the step is red (never skipped). Sourced by test.sh step commands
# and tests/test_sh_deps.sh.
ts_ensure_node_deps() {
  local dir="$1"
  [ -d "$dir/node_modules" ] && return 0
  echo "test.sh: $dir/node_modules missing; installing deps" >&2
  if [ -f "$dir/package-lock.json" ]; then
    (cd "$dir" && npm ci --no-audit --no-fund) || { echo "test.sh: npm ci failed in $dir" >&2; return 1; }
  else
    (cd "$dir" && npm install --no-audit --no-fund) || { echo "test.sh: npm install failed in $dir" >&2; return 1; }
  fi
}
