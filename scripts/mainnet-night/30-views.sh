#!/usr/bin/env bash
# MAINPREP1 step (e): deployed escrow views == the new() args file (read-only RPC). Exit 1 on any FAIL.
# Usage: 30-views.sh [network] [escrow] [args.json]   (defaults: mainnet bets.praetorial.near release/mainnet-night/args.mainnet.json)
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO/services"
node --import tsx release/src/nightCli.ts views --network "${1:-mainnet}" --escrow "${2:-bets.praetorial.near}" --args "${3:-$REPO/release/mainnet-night/args.mainnet.json}"
