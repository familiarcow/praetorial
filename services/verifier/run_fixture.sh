#!/bin/sh
# Offline verify-bet fixture run on the recorded R3e evidence (test.sh step). Exit 0 only if no check FAILs
# AND the checks that must PASS offline did PASS (E1 E2 B1 B2 B3 B5 B6).
cd "$(dirname "$0")" || exit 1
out=$(./verify-bet --evidence-dir ../e2e/live-runR3e --expect-escrow-hash f50742358b404ccc7b9a80f9da86e5cd7591e32ccf7371f9e970fbe94ad0b9ed) || { echo "$out"; exit 1; }
echo "$out"
for c in E1 E2 B1 B2 B3 B5 B6; do
  echo "$out" | grep -q "^PASS $c " || { echo "required PASS missing: $c"; exit 1; }
done
