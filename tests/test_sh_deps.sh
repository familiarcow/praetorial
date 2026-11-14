#!/usr/bin/env bash
# PUB1: test.sh installs node deps for services/ AND apps/web the same way (npm ci when node_modules is missing),
# so a bare clone + `./test.sh fast` needs no manual npm ci. Uses a fake npm; no network. Run inside the
# "services npm test" step (and standalone: bash tests/test_sh_deps.sh).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
. tests/lib/deps.sh 2>/dev/null || { echo "FAIL cannot source tests/lib/deps.sh"; exit 1; }
tmp="$(mktemp -d)"
mkdir -p "$tmp/bin"
# fake npm: logs "<cwd-basename> <args>"; `ci`/`install` create node_modules unless FAKE_NPM_FAIL=1
cat > "$tmp/bin/npm" <<'EOF'
#!/bin/sh
echo "$(basename "$PWD") $*" >> "$FAKE_NPM_LOG"
[ "${FAKE_NPM_FAIL:-0}" = 1 ] && exit 1
case "$1" in ci|install) mkdir -p node_modules ;; esac
exit 0
EOF
chmod +x "$tmp/bin/npm"
export FAKE_NPM_LOG="$tmp/npm.log"
mkpkg() { mkdir -p "$tmp/$1"; echo '{}' > "$tmp/$1/package.json"; [ "${2:-}" = lock ] && echo '{}' > "$tmp/$1/package-lock.json"; return 0; }

# 1. missing node_modules + lockfile -> npm ci, in that dir
mkpkg withlock lock; : > "$FAKE_NPM_LOG"
( PATH="$tmp/bin:$PATH" ts_ensure_node_deps "$tmp/withlock" ) >/dev/null 2>&1; rc=$?
[ $rc -eq 0 ] && grep -qE "^withlock ci( |$)" "$FAKE_NPM_LOG" && [ -d "$tmp/withlock/node_modules" ] && ok "missing node_modules + lockfile -> npm ci" || bad "npm ci (rc=$rc log=$(cat "$FAKE_NPM_LOG"))"

# 2. node_modules present -> npm not called
: > "$FAKE_NPM_LOG"
( PATH="$tmp/bin:$PATH" ts_ensure_node_deps "$tmp/withlock" ) >/dev/null 2>&1; rc=$?
[ $rc -eq 0 ] && [ ! -s "$FAKE_NPM_LOG" ] && ok "node_modules present -> no install" || bad "present (rc=$rc log=$(cat "$FAKE_NPM_LOG"))"

# 3. no lockfile -> npm install
mkpkg nolock; : > "$FAKE_NPM_LOG"
( PATH="$tmp/bin:$PATH" ts_ensure_node_deps "$tmp/nolock" ) >/dev/null 2>&1; rc=$?
[ $rc -eq 0 ] && grep -qE "^nolock install( |$)" "$FAKE_NPM_LOG" && ok "no lockfile -> npm install" || bad "npm install (rc=$rc log=$(cat "$FAKE_NPM_LOG"))"

# 4. install failure -> non-zero (loud), never a silent pass
mkpkg failing lock; : > "$FAKE_NPM_LOG"
out="$( PATH="$tmp/bin:$PATH" FAKE_NPM_FAIL=1 ts_ensure_node_deps "$tmp/failing" 2>&1 )"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q "failing" && ok "install failure fails loudly" || bad "failure (rc=$rc out=$out)"

# 5. test.sh uses the helper for services/ before every step that needs services deps, and for apps/web
fast="$(sed -n '/^run_fast()/,/^}/p' test.sh)"
for step in "services npm test" "services tsc --noEmit" "web npm test" "conformance run.sh" "verifier fixture"; do
  line="$(printf '%s\n' "$fast" | grep -F "run_step \"$step")"
  printf '%s\n' "$line" | grep -q "ts_ensure_node_deps services" && ok "step '$step' ensures services deps" || bad "step '$step' does not ensure services deps"
done
printf '%s\n' "$fast" | grep -F 'run_step "web npm test' | grep -q "ts_ensure_node_deps apps/web" && ok "web npm test ensures apps/web deps" || bad "web npm test apps/web deps"
# DOCS4/DOCS5: one services test imports apps/web code, so a fresh clone needs apps/web deps BEFORE services npm test
# (the README used to tell people to run `cd apps/web && npm ci` first; test.sh does it now).
printf '%s\n' "$fast" | grep -F 'run_step "services npm test' | grep -q "ts_ensure_node_deps apps/web" && ok "services npm test ensures apps/web deps" || bad "services npm test does not ensure apps/web deps (a services test imports apps/web code)"
printf '%s\n' "$fast" | grep -F 'run_step "services npm test' | grep -q "tests/test_sh_deps.sh" && ok "this test runs inside the services npm test step" || bad "test_sh_deps.sh not wired into test.sh"

rm -r "$tmp"
exit $fail
