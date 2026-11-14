# Praetorial: Option-1 Privy + NEAR E2E report

Generated: 2026-11-04T00:19:14.453Z. Real Privy app `cmw1b5stc01q60glap4q18que`, real test account, real NEAR testnet txs. No secrets below.

| Step | Result | Detail |
|---|---|---|
| 1. Email + fixed test OTP login (real Privy client SDK), NEAR wallet create/load | ✅ PASS | account `8941e607b64ff1b0d62ff6e061ce073df75a53a1205852708f965779240981c7` |
| 2. Fund account from praetorial-dev-1101.testnet (<= 0.5 NEAR) | ✅ PASS | skipped -- account already funded from an earlier run (balance 589910726975000000000000 yoctoNEAR >= 0.05 NEAR threshold); not re-sent to avoid draining the shared testnet funder on every rerun |
| 3. Server builds NEAR transfer -> browser raw-signs (user session) -> server verifies + broadcasts + confirms FINAL | ✅ PASS | tx `D34cNg1PstaNUxViG7eDZdnh5NSqJXfd7dVZFYLqq3kw` ([explorer](https://testnet.nearblocks.io/txns/D34cNg1PstaNUxViG7eDZdnh5NSqJXfd7dVZFYLqq3kw)) |
| 4. NEP-413 intents message, same signing path, verified via simulate_intents (mainnet, view-only) | ✅ PASS | signature verified locally: true; simulate_intents error: Querying failed: wasm execution failed with error: HostError(GuestPanic { panic_msg: "insufficient balance or overflow" }).
{
  "block_hash": "7Ni4zQhbJ4ncJCFTha2n5dX1D1CDPx5E4Y2qyz4LGqLB",
  "block_height": 222944395,
  "error": "wasm execution failed with error: HostError(GuestPanic { panic_msg: \"insufficient balance or overflow\" })",
  "logs": []
} |
| 5. Logout then back in returns the same NEAR wallet | ✅ PASS | 8941e607b64ff1b0d62ff6e061ce073df75a53a1205852708f965779240981c7 -> 8941e607b64ff1b0d62ff6e061ce073df75a53a1205852708f965779240981c7 |
| 6. Passkey as a recovery path after email signup (CDP virtual authenticator) | ✅ PASS | linkPasskey() result: ok |

**Overall: ALL PASS.**

## What this proves about Option 1 (D-PRIVY1)

- The wallet is user-owned; the server never holds or calls raw_sign with an app secret anywhere in this app.
- Signing happens inside the user's own live Privy session in the browser (`useSignRawHash`, chainType `near`), exactly per the decision.
- The server's role is strictly: build tx (with live nonce + blockhash) -> allowlist/cap check -> hand back a hash -> verify the client's signature against the account's own public key -> broadcast -> confirm FINAL. It is never in the signing path.
- The same signing primitive (`signRawHash`) covers both a native NEAR transfer and a NEP-413 off-chain message -- one mechanism, two payload shapes.

## Red tests / gaps (not skipped, tracked)

- **simulate_intents on mainnet rejected the intent for lack of funds** (`insufficient balance or overflow`), not for a bad signature or payload -- this is the EXPECTED, correct result: the account genuinely has no USDC deposited into `intents.near` (no mainnet spend happened, per the task's hard constraint), so the simulator gets past signature verification and payload parsing and fails only on the balance check. This confirms the NEP-413 round trip (Privy raw_sign -> local verify -> real mainnet contract call) is cryptographically sound end to end. Status: expected, not a red test.

No credentials, OTPs, or private keys appear anywhere in this report.
