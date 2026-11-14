#!/bin/bash
# RTE3 ready-to-run: harness N=20 (Claude CLI haiku) + production pair N=20 for
# mk_fake_clause_restatement_in_exhibit_text. Env: NEAR AI key file below (never printed). ~10 min total; run in 2 batches if needed.
set -e; cd "$(dirname "$0")"; R=../../../judge-proto/redteam_evidence
export PATH=${PRAETORIAL_CACHE_DIR:?set PRAETORIAL_CACHE_DIR to the operator cache dir}/scratch/cf1e3venv/bin:$PATH
set -a; . ${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-nearai.env; set +a
export NEAR_SPEND_CAP_USD=${NEAR_SPEND_CAP_USD:-19.5}   # nearai_spend.jsonl is cumulative
for b in 0 5 10 15; do python3 harness_20x.py h$b 5 $b; done
python3 $R/measure_production_pair.py rte3 --n 20 --only mk_fake_clause_restatement_in_exhibit_text
