# sourcecheck Worker (SRCW1, D-SRCW1)

HTTP endpoint behind `apps/web/lib/sourceCheckClient.ts` (`VITE_SOURCECHECK_URL`).
`POST` `{"mode":"sourcecheck","terms":"<raw sheet>"}` -> `{ok,spec_hash,checked_at,unreachable:[{id,reason}],signing:{pubkey_hex,signature_hex}}`.

- Lint first (shared web/resolver-parity linter) -> 422 + zero OutLayer calls. Then caps: per-IP SOURCECHECK_IP_PER_HOUR/hour (default 10; testnet 60, mainnet 30 per wrangler.toml, SRCRL1c) and global 300/day -> 429 (+ Telegram alert hook).
- Execution: plain OutLayer `request_execution` signed by the attest signer (D-ATTEST2, `attest1.praetorial-dev-1101.testnet`; CM-OL11f). Wasm hash = escrow `resolver_keys`[2], base URL = escrow `outlayer_config`; nothing hand-configured. Mirrors `services/keeper/src/archiveProd.ts`.
- Fail closed (502/504, `ok:false`, never unsigned/partial): signing pubkey != escrow `resolver_keys`[1], spec_hash != sha256(terms), bad signature, unreachable sources, OutLayer error, timeout (55 s).
- CORS only for `SOURCECHECK_ALLOWED_ORIGINS` (foreign `Origin` -> 403, never `*`). No NEAR AI client is in the module graph (tested).

## Secrets / config
Worker secret (value never printed or committed): **`SOURCECHECK_ATTEST_PRIVATE_KEY`** (attest signer `ed25519:` key). Optional: `TELEGRAM_BOT_TOKEN`, `SOURCECHECK_ALERT_TELEGRAM_CHAT_ID`.
Vars in `wrangler.toml` (top level = testnet, `praetorial-sourcecheck-testnet`; `[env.mainnet]` = `praetorial-sourcecheck-mainnet`, draft, not deployed; mainnet `OUTLAYER_CONTRACT_ID` / `ATTEST_ACCOUNT_ID` / origins are deploy-day confirmations).

## Deploy (testnet)
```
set -a; . $PRAETORIAL_SECRETS_DIR/praetorial-cloudflare.env; set +a
cd services/workers/sourcecheck && npx wrangler deploy
# pipe the key file's private_key to stdin of: npx wrangler secret put SOURCECHECK_ATTEST_PRIVATE_KEY
```

Deployed URL: **https://praetorial-sourcecheck-testnet.familiarcow.workers.dev/sourcecheck** (any path works; `WEBSRC1` sets `VITE_SOURCECHECK_URL` to it).

## Live testnet results (2026-11-09, frozen escrow `praetorial-frz1b-2611081810.praetorial-dev-1101.testnet`)
- 3 real sourcechecks through the deployed URL on a `btc_touch` sheet (open_utc = current UTC minute, 2 h window): 3/3 HTTP 200, 3/3 signatures valid under the escrow's pinned attest pubkey (`resolver_keys`[1]) via `services/common` `verifySourceCheckAttestationPinned`. ~14-16 s each.
- Attest signer `attest1.praetorial-dev-1101.testnet` balance before 812.669757 NEAR, after 806.136289 NEAR: **net 0.006533 NEAR for 3 = 0.002178 NEAR per sourcecheck** (OutLayer refunds included; the 0.4 NEAR attached deposit is mostly refunded). Earlier failed runs cost the same ~0.0021-0.0022 NEAR each.
- Findings: (1) the guest prints `checked_at` as a bare u64 ns number, > 2^53; naive `JSON.parse` rounded it and broke the signature (fixed, test pinned). (2) A `btc_touch` sheet with a long window (fixture: 2026-11-07..2026-12-07, ~4 weeks) fails sourcecheck: the template's Coinbase source URL `candles?granularity=60&start..&end..` returns HTTP 400 (Coinbase allows <= 300 candles = 5 h), so `S_CB` is "unreachable" and the Worker correctly fails closed. A real btc_touch bet with a window > 5 h cannot get an attestation until the template/wasm source URL is fixed (not in SRCW1 scope; needs a PM ruling). (3) The guest also requires `open_utc` within 300 s of now (OPEN_UTC_SKEW).

