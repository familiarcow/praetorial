#!/usr/bin/env bash
# MAINPREP1: put the MAINNET Worker secrets. Values are piped from files to `wrangler secret put` stdin: never echoed, never
# on a command line, never in the repo. Gated like deploy-mainnet.sh (PRAETORIAL_MAINNET_GO=GO, or DRY_RUN=1 = names only).
# Key files (bot-held, D-KEYS1/D-RCFG1): $KEYS/<role>/<implicit>.json written by `near account create-account fund-later
# use-auto-generation save-to-folder`, field private_key = "ed25519:...".
# Usage: cd services/workers && [DRY_RUN=1] PRAETORIAL_MAINNET_GO=GO scripts/set-mainnet-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."
WRANGLER=${WRANGLER:-npx wrangler}
DRY=${DRY_RUN:-0}
if [ "$DRY" != "1" ] && [ "${PRAETORIAL_MAINNET_GO:-}" != "GO" ]; then
  echo "refusing: needs PRAETORIAL_MAINNET_GO=GO or DRY_RUN=1" >&2; exit 3
fi
# PUB1: key files and env files live in the operator secrets dir (outside the repo); defaults refuse when it is unset.
KEYS=${KEYS:-${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-mainnet-keys}
ALERTS_ENV=${ALERTS_ENV:-${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-alerts.env}
# F1: the 1Click partner key for the funding Worker. The file holds a line ONECLICK_API_KEY=<jwt> (optionally `export`, quoted).
ONECLICK_ENV=${ONECLICK_ENV:-${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-oneclick.env}
keyfile() { local f; f=$(ls "$KEYS/$1"/*.json 2>/dev/null | head -1); [ -n "$f" ] || { echo "missing key file for role $1 under $KEYS/$1" >&2; exit 1; }; echo "$f"; }
privkey() { python3 -I -c 'import json,sys; sys.stdout.write(json.load(open(sys.argv[1]))["private_key"])' "$1"; }
put() { # put <worker dir> <SECRET_NAME> <producer function + args...>
  local dir=$1 name=$2; shift 2
  if [ "$DRY" = "1" ]; then echo "DRY: (cd $dir && <$*> | $WRANGLER secret put $name --env mainnet)"; return; fi
  ( cd "$dir" && "$@" | $WRANGLER secret put "$name" --env mainnet >/dev/null ) && echo "set $dir $name" || { echo "FAILED $dir $name" >&2; exit 1; }
}
put relayer     RELAYER_PRIVATE_KEY            privkey "$(keyfile relayer)"
put keeper      KEEPER_PRIVATE_KEY             privkey "$(keyfile keeper)"
put sourcecheck SOURCECHECK_ATTEST_PRIVATE_KEY privkey "$(keyfile attest)"
# F1: checked first (no value printed): a missing file/line stops the run before anything is put for funding.
oneclick_key() { sed -n -e 's/\r$//' -e "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}ONECLICK_API_KEY=//p" "$1" | head -1 | sed -e "s/^[\"']//" -e "s/[\"']$//" | tr -d '\n'; }
if [ ! -f "$ONECLICK_ENV" ] || [ -z "$(oneclick_key "$ONECLICK_ENV")" ]; then
  echo "missing ONECLICK_API_KEY=<key> line in $ONECLICK_ENV (funding Worker 1Click key; contents not shown)" >&2; exit 1
fi
put funding     ONECLICK_API_KEY               oneclick_key "$ONECLICK_ENV"
# The contact key encrypts stored contacts: generate it ONCE. A re-run must not rotate it (stored contacts would become unreadable).
if [ "$DRY" != "1" ] && (cd notifier && $WRANGLER secret list --env mainnet 2>/dev/null | grep -q '"NOTIFIER_CONTACT_KEY"'); then
  echo "keep notifier NOTIFIER_CONTACT_KEY (already set; not rotated)"
else
  put notifier NOTIFIER_CONTACT_KEY openssl rand -hex 32
fi
if [ -f "$ALERTS_ENV" ] && grep -q '^ALERT_TELEGRAM_BOT_TOKEN=' "$ALERTS_ENV"; then
  tok() { sed -n 's/^ALERT_TELEGRAM_BOT_TOKEN=//p' "$ALERTS_ENV" | tr -d '\n'; }
  put monitor ALERT_TELEGRAM_BOT_TOKEN tok
else
  echo "WARNING: $ALERTS_ENV has no ALERT_TELEGRAM_BOT_TOKEN: the mainnet monitor will run but cannot alert (ALRT1, familiarcow task)" >&2
fi
echo "secrets done (values never printed)"
