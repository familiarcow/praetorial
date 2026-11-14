#!/bin/zsh
set -a; . ${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-nearai.env; set +a
exec python3 redteam.py "$@"
