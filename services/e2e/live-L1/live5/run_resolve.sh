#!/bin/bash
cd "$(dirname "$0")"
for b in jason_bitstamp_only_no; do
  ( date -u +%T; timeout 540 node resolve.mjs $b ) > resolve_$b.log 2>&1 &
done
wait
