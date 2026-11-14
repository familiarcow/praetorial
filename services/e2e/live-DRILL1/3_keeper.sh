#!/bin/sh
# DRILL1 step 6: run the REAL keeper (services/keeper/src/runner.ts, tickMulti) one-shot, twice, against the throwaway escrow only.
# Tick 1 plans emergency_refund for every non-terminal bet; tick 2 drains the scheduled refund lines (emergency_refund only schedules ledger lines).
# Uses the init-config keeper account's key file in-process (never printed); NOT the deployed Worker config.
# usage (from services/): NEAR_RPC_URL=... sh e2e/live-DRILL1/3_keeper.sh <escrow-account>
ESC="$1"; D=e2e/live-DRILL1
[ "$KEEP" = 1 ] || rm -f $D/keeper-state.json $D/keeper-tx-log.jsonl
for i in ${TICKS:-1 2}; do
  ESCROW_CONTRACTS="$ESC@v1" INTENTS_CONTRACT_ID=intents-mock.praetorial-dev-1101.testnet \
  KEEPER_KEY_FILE=$HOME/.near-credentials/testnet/keeper.praetorial-dev-1101.testnet.json KEEPER_RUN_ONCE=1 KEEPER_ACCOUNT_ID=keeper.praetorial-dev-1101.testnet \
  KEEPER_STATE_FILE=$D/keeper-state.json KEEPER_LOG_FILE=$D/keeper-tx-log.jsonl \
  node --import tsx keeper/src/runner.ts 2>&1 | grep -v "^Retrying\|^Receipt\|Log \[" | tail -8
  echo "--- tick $i done"; sleep 10
done
cat $D/keeper-tx-log.jsonl | cut -c1-400
