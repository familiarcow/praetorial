#!/bin/sh
# CF1e3 diagnostic: 6 hits each of /diag/raw and /diag/stack (temporary routes, removed after), spaced 12 s
U=https://praetorial-indexer-testnet.familiarcow.workers.dev
sleep 20
for i in 1 2 3 4 5 6; do curl -s $U/diag/raw >/dev/null; sleep 6; curl -s $U/diag/stack > /dev/null; sleep 6; done
