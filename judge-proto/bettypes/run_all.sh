#!/bin/sh
# Run all bet-type prototype tests from judge-proto/. Needs a python3 with `cryptography` (evidence.py imports it).
# LIVE_FETCH=1 adds the optional public-endpoint reachability tests (no keys, no logins, no model spend).
cd "$(dirname "$0")/.." || exit 1
PY="${PY:-python3}"; rc=0
for t in social_post polymarket github_release; do $PY bettypes/$t/test_$t.py | tail -4 || rc=1; done
$PY bettypes/test_templates.py | tail -1 || rc=1
exit $rc
