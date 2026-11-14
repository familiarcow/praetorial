# services/registry: username registry (REG1)

Maps human usernames to NEAR accounts for the referee picker. Holds no signing key and no funds.

Run: `REGISTRY_ID=registry.praetorial-dev-1101.testnet REGISTRY_STORE_PATH=/var/lib/praetorial/registry.json REGISTRY_CORS_ORIGINS=https://app.example npm run registry` (from `services/`).

## Env
| var | default | meaning |
|---|---|---|
| `REGISTRY_ID` | required | NEP-413 `recipient` the claim signature is bound to |
| `REGISTRY_PORT` | 8790 | listen port |
| `REGISTRY_STORE_PATH` | unset | JSON file (atomic temp+rename, 0600). Unset = in-memory (lost on restart) |
| `NEAR_RPC_URL` | fastnear testnet | RPC for `view_access_key_list` |
| `REGISTRY_CORS_ORIGINS` | empty | comma-separated allow-list; empty = no CORS |
| `REGISTRY_RATE_CAPACITY` / `REGISTRY_RATE_REFILL_PER_SEC` | 20 / 0.5 | per-IP token bucket on `/claim` + `/search` |
| `REGISTRY_TRUST_PROXY` | 0 | `1` = key the bucket on `x-forwarded-for` (only behind a trusted proxy) |

## API
- `POST /claim` (body <= 2 KB) `{username, account_id, public_key, nonce(base64, 32B), signature(base64|ed25519:b58), discoverable?}`.
  - Signed message: `praetorial-username:<normalized username>`, recipient `REGISTRY_ID`, NEP-413 (`@praetorial/common/nep413`).
  - Nonce = 8-byte big-endian ms timestamp + 24 random bytes; accepted if <= 10 min old (<= 1 min in the future); single use (replay -> 409). A failed claim does not burn the nonce.
  - `public_key` must be a **FullAccess** key on `account_id` per RPC; RPC failure fails closed (502).
  - 200 `{username, account_id}`. Errors: 400 `invalid_username|username_reserved|bad_*|nonce_expired`, 401 `bad_signature`, 403 `key_not_full_access`, 409 `username_taken|nonce_replay`, 413, 429, 502.
- `GET /search?q=` -> up to 10 `{username, account_tail}` (prefix before substring; look-alike folded). `discoverable=false` users are never returned. `account_tail` = full id for named accounts, last 8 chars for 64-hex implicit accounts.
- `GET /lookup/account/:id` -> `{username}` or 404 (exact; works for non-discoverable users).
- `GET /health`.

## Username rules
Lowercased, one leading `@` stripped, `[a-z0-9_]{3,20}`. Reserved: praetorial, admin, support, referee, ai, guardian. Uniqueness and the reserved check use a look-alike fold (`rn`->`m`, `0`->`o`, `1`/`i`->`l`, `5`->`s`). One name per account: re-claiming renames and frees the old name.

## Limits / not done
Single process, file store serialised in-process (no multi-writer). No unclaim endpoint. Key rotation after claim is not re-checked (ownership is proven at claim time only).
Web client: `HttpUserRegistry` + `claimUsername` in `apps/web/lib/refereeRegistry.ts` (config `REGISTRY_URL`, `REGISTRY_ID`); picker screens unchanged and still use the mock.

## REGCLAIM1: why Privy-signed username claims got 400/401 (fixed in apps/web)
Found by DR6: first-login claim from the web returned `400 bad_key_or_signature`. Two web-side causes, registry verification untouched (still refuses forged / wrong-key claims):
1. `apps/web/src/components/UsernameStep.tsx` sent `public_key` = the Privy NEAR address (64-hex raw ed25519 key, the implicit account id); `core.ts` `parseClaim` (core.ts:43) requires NEAR key form `ed25519:<base58>` -> 400. Now `claimWithWallet` (lib/refereeRegistry.ts) sends `ed25519:` + `base58FromHex(address)`. Test: apps/web/tests/regclaim1.unit.test.ts (real ed25519 keys, real parseClaim + verifyClaimSignature).
2. Behind that, `apps/web/lib/network.ts` testnet `registryId` was `registry.praetorial-dev-1101.testnet` while the deployed Worker verifies the NEP-413 recipient as `REGISTRY_ID = registry.praetorial.testnet` (services/workers/registry/wrangler.toml) -> 401 bad_signature. Aligned; pinned by apps/web/tests/regclaim1RegistryId.unit.test.ts.
Live evidence (local testnet build on localhost:3000, Privy test login): before fix 400 -> 401, after fix `POST /claim` 200 and `GET /lookup/username/rc1_35626` -> `{"username":"rc1_35626","account_id":"8941e607...81c7"}`.
Also: review-card storage line stayed "loading from the contract..." forever for assets with no `asset_limit` on the testnet escrow (wrap.testnet returns null; usdc resolves); it now says "not available ..." once the read settles (tests/regclaim1Storage.unit.test.ts). Enabling wrap.testnet on the contract is a separate ops item.
