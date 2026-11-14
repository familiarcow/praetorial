# Status: what is deployed where

Checked 2026-11-14 against the chain and the release records. Contract ids come from `release/mainnet-night/input.priced.json`
(mainnet), `release/freeze-candidate-2.json` (testnet) and `services/workers/*/wrangler.toml`.

| Part | Mainnet | Testnet | Planned / not yet |
|---|---|---|---|
| Escrow contract (`contracts/escrow`, Rust, near-sdk 5.29) | `bets.praetorial.near`: deployed, **0 access keys**, code hash `EfCgMFhe…` = reproducible build sha256 `caf134a4…`; `bet_count` 2 ([BETS.md](BETS.md)) | `praetorial-frz3-2611100414.praetorial-dev-1101.testnet`: same code hash, still has a key | external audit |
| Judge program (`resolver/`, Rust → wasm) on OutLayer TEE | `outlayer.near`, program sha256 `8791413f…2473` pinned in the escrow (`resolver_keys`) | `outlayer.testnet`, same program hash | public replay of each ruling's page text; attestation check of each run |
| AI models (NEAR AI Cloud) | 4 judge pairs on chain (`judge_chain`), e.g. DeepSeek-V4.1-Flash + GLM-5.3-flash | same | — |
| NEAR Intents balances | `intents.near` | a mock Intents contract (no Intents testnet exists) | — |
| 1Click: add money, cash out to another chain, convert | live (`services/workers/funding`, `FUNDING_DRY_ONLY="0"`) | previews only | — |
| Usernames (registry Worker) | `registry.praetorial.near` (a name used in signatures; no contract is deployed there) | yes | — |
| Services (8 Cloudflare Workers: relayer, keeper, indexer, monitor, notifier, registry, sourcecheck, funding) | deployed, `check-deployed-stack --network mainnet --release release/mainnet-night/release-mainnet.json` = 8/8 PASS | deployed | — |
| Web app (`apps/web`, React) | https://praetorial.com (unlisted beta) | https://praetorial-web-testnet.familiarcow.workers.dev | — |
| Cross-asset bets (each side a different token) | supported by the escrow at exact amounts the maker sets (no price oracle) | same | not in the app UI yet |

## How it uses NEAR

- **Escrow contract.** `bets.praetorial.near` holds stakes as NEP-245 tokens of `intents.near`, verifies the judge's ed25519 signature,
  runs the challenge, concede and referee paths, and pays out (`contracts/escrow`).
- **NEAR Intents + 1Click.** Balances and stakes live in each user's NEAR Intents account. 1Click (NEAR Intents' cross-chain swap API)
  adds money from native assets on other chains and cashes out to them (`services/workers/funding`). Assets: NEAR, USDC, USDT, BTC, ETH, ZEC.
- **Verifiable AI judge on OutLayer (TEE) with NEAR AI Cloud models.** The judge program (`resolver/`) has a pinned sha256
  (`8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473`) stored in the escrow's `resolver_keys`; the model pairs are on chain
  (`judge_chain`).
- **Privy email login + relayer gas.** Logging in with an email code creates a NEAR implicit account. The user signs each action; the
  relayer (`services/workers/relayer`) sends it as a NEAR meta-transaction (signed delegate action) and pays the gas.

## Tests

`./test.sh fast` is the single entry point (15 steps). It never skips: any red step fails the run (exit 1). It covers:

- escrow contract unit and property tests (`cargo test`), mock-intents ABI parity with the real `intents.near`
- judge program tests under both the offline and the production feature set (`real-http,outlayer-sign`)
- services: unit tests for every Worker, Miniflare tests for most of them, plus `tsc --noEmit`
- web: unit tests (including tests that pin README and Docs claims), mocked Playwright e2e, and a visual gate (every screen at 375 and 1280 px)
- contract and resolver conformance suites
- Python ↔ Rust decision parity, offline replay of recorded red-team judge answers, the verifier on recorded evidence, and release-record
  checks (the deployed source is covered by its reproducible-build record)

The release-record step and the web test `releasePins` find the newest build record through a committed pointer
(`resolver/release/CURRENT`, `contracts/escrow/release/CURRENT`) and check the record's per-file source hashes against the tree, so they
pass in a clone without the original git history.

`./test.sh full` adds CPU budgets, two red-team runs that call live AI models (API keys needed, spends credit), the chaos suite (local NEAR
sandbox) and a release sandbox. `./test.sh live` runs against testnet. See `TESTING.md`.
