# Privy + NEAR E2E / wallet layer (testnet)

Real Privy app (Praetorial, `cmw1b5stc01q60glap4q18que`), real REST API calls, real NEAR testnet txs.
No mainnet. No real user emails -- every test user is a placeholder `@example.com` address, never a
real inbox. Secrets are loaded from `$PRAETORIAL_SECRETS_DIR/praetorial-privy.env` and never printed (only
length/prefix, when checked at all).

**Scope note (2026-11-03):** familiarcow reprioritized mid-session. The wallet layer (user/wallet provisioning,
the signer service, ownership model, account lifecycle, gas/meta-tx, recovery/export) is the main
deliverable and is documented in full in the wallet layer v1 design notes (internal).
Betting/payout E2E (opening/taking a bet, resolving it, confirming a payout) is **paused**, not deleted --
one real step (opening a bet with a Privy-signed tx) was completed before the pause; see below.

Run everything from this directory (`services/privy-e2e/`) with `node --import tsx <script>` and
`PRIVY_APP_SECRET` exported into the environment first (`set -a; source $PRAETORIAL_SECRETS_DIR/praetorial-privy.env; set +a`).
Node resolves `near-api-js`/`tweetnacl`/`bs58`/`js-sha256` from `services/node_modules` via upward module
resolution -- no separate `node_modules` needed in this folder.

## Layout

- `lib/privy.ts` -- Privy REST client (create user, create wallet, raw_sign). Never logs the app secret.
- `lib/walletStore.ts` / `lib/walletService.ts` -- idempotent per-user wallet provisioning (Option 1:
  user-owned wallets, see the wallet layer doc §1). `data/wallets.json` is the local store.
- `lib/nearRaw.ts` -- build/sign/broadcast a NEAR tx for a Tier-1 (raw-sign) wallet: borsh-serialize,
  sha256, hand the hash to a signer, reattach the signature, broadcast.
- `lib/signerPolicy.ts` -- the allowlist + amount-cap safety gate. Privy can't read NEAR tx content
  (confirmed in the earlier compatibility audit); this is where enforcement actually lives.
- `lib/signAndSend.ts` -- the production signer-service shape: ownership check → policy check → build →
  sign → **locally re-verify the signature** → broadcast. See wallet layer doc §2 for the Option-1 caveat
  (sign step is a real Privy `raw_sign` in this harness; production replaces it with a client-produced
  signature).
- `lib/localSigner.ts`, `lib/borsh.ts`, `lib/resolverSign.ts` -- self-contained copies of the equivalent
  `services/common` helpers (this folder intentionally has zero dependency on code another agent is
  editing in `contracts/escrow`/`services/keeper`).
- `scripts/01_create_privy_user.ts` -- original probe: inline user+wallet creation, surfaced the
  ownership-model finding (owner=user, raw_sign needs a session).
- `scripts/02_fund_and_mint.ts`, `03_open_bet_via_privy.ts` -- betting-path work, **paused** after one
  successful step (see below). Kept, not deleted.
- `scripts/04_wallet_idempotency.ts` -- proves `getOrCreateUserWallet` is idempotent (same email twice =
  same ids, no second Privy user).
- `scripts/05_signer_service_tests.ts` -- 6/6 live cases for `sign_and_send`: one real onchain broadcast,
  five pre-Privy refusals.
- `scripts/06_account_lifecycle.ts` -- before/after funding, minimum-funding probes.
- `scripts/07_relayer_meta_tx.ts` -- a real NEP-366 `DelegateAction` signed via Privy `raw_sign`, relayed
  by the funder; also documents that `services/relayer`'s current code does NOT support this (gap).

## Results summary (see data/*.json for full records, and the wallet layer doc for narrative)

| Check | Result | Evidence |
|---|---|---|
| Create a real Privy test user + NEAR wallet | PASS (both the inline-owned and standalone-harness paths) | `data/privy_user.json`, `data/wallets.json` |
| Wallet creation is idempotent per user | PASS | `scripts/04_wallet_idempotency.ts` console output; two distinct emails, two distinct wallets; same email twice, same wallet |
| `sign_and_send` ownership + allowlist + cap refusals, all before any Privy call | PASS, 6/6 | `data/signer_service_tests.json` |
| `sign_and_send` positive path (real Privy raw_sign, real broadcast) | PASS | tx `CnRfhwCLyCfviwVXJJeY9RET2zhsFFwnRApAsANQhDt7` |
| Implicit account lifecycle (pre-funding, first deposit, minimums) | PASS (documented, no protocol-level minimum found) | `data/account_lifecycle.json` |
| 0-NEAR user acting via NEP-366 meta-tx, signed via Privy | PASS, mechanism proven; `services/relayer` itself does NOT implement this (gap) | tx `Rq8fbn5Di6TbZscKhaRhSKuwc7oY9CCBYoBn7Qg56o9`, `data/relayer_meta_tx.json` |
| Wallet ownership model: Option 1 (user-owned, no app signer) | DECIDED by familiarcow; server-side raw_sign confirmed blocked twice, live, as expected | see wallet layer doc §1 |
| Option 1 full live round trip (real user JWT → raw_sign) | BLOCKED -- needs Dashboard "Enable test accounts" toggle (off today) | wallet layer doc §1.2 |
| NEP-413 signing via real Privy raw_sign | NOT DONE this session (deprioritized) | wallet layer doc §6, RED test |
| Key export | RECORDED ONLY, never called | wallet layer doc §5 |
| Betting: open a bet, Privy-signed | PASS (1 step only, then paused) | `data/open_bet.json`, tx logged there |
| Betting: take/resolve/payout | PAUSED, not run | — |

## Safety notes

- Never print `PRIVY_APP_SECRET`, any resolver seed, or any NEAR private key. Scripts that touch the
  resolver test-harness seed (`resolverSign.ts`) write it to a local JSON file only and redact it from
  console output.
- The allowlist in `lib/signerPolicy.ts` is intentionally narrow (escrow + the mock-intents
  `transfer_with_msg`-to-escrow-only path); it also implicitly rejects any non-FunctionCall action
  (`lib/privySigner.ts` doc) since a Privy-backed production wallet should never need to send a bare
  native `Transfer`.
- All testnet spend stayed well under the 2 NEAR budget (funding amounts were 0.3 NEAR x a few wallets
  plus small USDC mints and 1-yoctoNEAR probes).
