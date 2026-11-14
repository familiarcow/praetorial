# services/ops — launch kit (SVC1)

Host-agnostic tooling to point keeper / indexer / notifier / relayer / monitor:alerts / treasury at a
frozen release and prove the alert path (D-SVC1). It installs, loads and starts **nothing**.

## Setup order

1. **release record** — the freeze record for the deploy (e.g. `release/freeze-candidate-2.json`, which carries
   `testnet_escrow.account`; a mainnet record carries `mainnet_escrow.account`). Contract ids are never hand-typed.
2. **env file** — copy the template below to a path outside the repo, `chmod 600`, fill in.
3. `npm run ops:check -- --network <testnet|mainnet> --env-file <path> --release <record.json>`
4. `npm run ops:test-alert -- --env-file <path> [--dry-run]` — sends ONE message `praetorial ops test <iso time> <network>`.
5. `npm run ops:gen-launchd -- --env-file <path> --out <dir>` — one plist per service + `praetorial-run.sh`
   (the wrapper sources the env file; secrets are never in a plist). Review, then install the plists yourself.
6. **verify heartbeats within 2 intervals**: files appear in `HEARTBEAT_DIR` for keeper, relayer, monitor, notifier
   (defaults 15 s / 60 s / monitor poll / 20 s) and the monitor raises no `service_heartbeat_missing`.

Exit codes (ops:check): 0 ok, 1 config error, 2 usage. Output is var names + `ok`/`FAIL`/`warn` only, never values.

## What ops:check proves

- every service's required vars are set (table: `src/serviceEnv.ts`, guarded by a static test against the runners' reads);
- the env names exactly the release record's escrow id (`ESCROW_CONTRACT_ID` / `ESCROW_CONTRACTS`);
- `NEAR_NETWORK_ID` equals `--network`;
- mainnet: no id ends `.testnet`, `NEAR_RPC_FALLBACKS` has >= 1 entry (D-RPC1), both Telegram alert vars set;
- `HEARTBEAT_DIR` set for every service MON4 heartbeats cover.

`ops:test-alert` proves the log channel and (if configured) Telegram delivery of a real message.

## What it does NOT prove

Keys exist, are the right keys, or are funded; RPC health over time or rate-limit headroom; OutLayer is up or has
credit; the host survives reboot; that the contracts at those ids match the audited wasm (use `verify-escrow`).

## Testnet env template (placeholders only)

```
NEAR_NETWORK_ID=testnet
NEAR_RPC_URL=https://test.rpc.fastnear.com
# NEAR_RPC_FALLBACKS=            # optional on testnet, required (>=1) on mainnet
ESCROW_CONTRACT_ID=<ESCROW_ACCOUNT_FROM_RELEASE_RECORD>
INTENTS_CONTRACT_ID=<INTENTS_ACCOUNT>
USDC_TOKEN_ID=<USDC_TOKEN_ID>
HEARTBEAT_DIR=<ABSOLUTE_HEARTBEAT_DIR>
KEEPER_KEY_FILE=<PATH_TO_KEEPER_KEY_JSON>
KEEPER_ACCOUNT_ID=<KEEPER_ACCOUNT>
RELAYER_KEY_FILE=<PATH_TO_RELAYER_KEY_JSON>
RELAYER_ACCOUNT_ID=<RELAYER_ACCOUNT>
NOTIFIER_CONTACT_KEY=<64_HEX_CHARS_GENERATED_LOCALLY>
FEE_ACCOUNT_ID=<FEE_ACCOUNT>
TREASURY_ACCOUNT_ID=<TREASURY_ACCOUNT>
TREASURY_RELAYER_ACCOUNT_ID=<RELAYER_ACCOUNT>
TREASURY_KEEPER_ACCOUNT_ID=<KEEPER_ACCOUNT>
TREASURY_USD_ASSET_ID=<NEP141_USD_ASSET_ID>
ALERT_TELEGRAM_BOT_TOKEN=<BOT_TOKEN_FROM_BOTFATHER>   # required on mainnet
ALERT_TELEGRAM_CHAT_ID=<OPERATOR_CHAT_ID>             # required on mainnet
```
