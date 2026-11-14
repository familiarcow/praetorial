# privy-web-e2e

Closes the Option-1 (D-PRIVY1) Privy + NEAR wallet round trip for real: a real `@privy-io/react-auth`
client app, a real Privy test account (email + fixed OTP), a server that never signs, and real NEAR
testnet broadcasts -- plus a NEP-413 intents message signed the same way and checked live via mainnet
`simulate_intents` (view-only, no spend).

## Run it

```
npm install
npx playwright install chromium   # once
npm run e2e
```

Reads `PRIVY_TEST_EMAIL` / `PRIVY_TEST_OTP` / `PRIVY_APP_SECRET` (unused here, kept for parity) from
`$PRAETORIAL_SECRETS_DIR/praetorial-privy.env`. Writes `report.md` (plain-English, no secrets) and
`data/results.json`. Boots the vite dev app on :3000 and the API server on :8787, runs the full
Playwright suite headless against them, tears both down, and exits non-zero if anything failed.

## What's proved

- `src/` is the entire browser half: login form -> `useLoginWithEmail`, NEAR wallet via
  `useCreateWallet({chainType:'near'})`, raw-hash signing via `useSignRawHash` (both for a native tx and
  a NEP-413 message), passkey linking via `useLinkWithPasskey`. No app secret ever touches this code.
- `server/` builds unsigned txs/NEP-413 payloads, runs an allowlist+cap check (`lib/signerPolicy.ts`)
  BEFORE a hash is ever handed to the browser, verifies the browser's signature against the account's
  own public key before ever broadcasting, and confirms FINAL. It never signs.
- `tests/e2e.spec.ts` drives the real UI with Playwright (headless Chromium), including a CDP
  `WebAuthn.addVirtualAuthenticator` for the passkey-recovery check.

See `report.md` after a run, and the internal wallet-layer v1 and Privy NEAR E2E v1
notes for the write-up with tx hashes.
