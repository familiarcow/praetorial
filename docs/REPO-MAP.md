# Repo map

| Path | What is there |
|---|---|
| `contracts/` | Rust (near-sdk): `escrow` (the deployed contract), `mock-intents` and `mock-outlayer` (stand-ins for testnet and tests). Frozen: the mainnet build is pinned by `release/`. |
| `resolver/` | The judge program: `core` (pure decision logic), `wasm-bin` (the OutLayer program), `release/` (reproducible-build script and build records), `live-run*/` (recorded live runs). |
| `apps/web/` | The React web app and its static-assets Worker (`worker/`), unit tests, mocked Playwright e2e and the visual gate. |
| `services/workers/` | The 8 deployed Cloudflare Workers (relayer, keeper, indexer, monitor, notifier, registry, sourcecheck, funding). |
| `services/` (other folders) | Shared code (`common`), the read-only verifier (`verifier`), release tooling (`release`), the earlier Node versions of keeper/indexer/relayer/notifier/monitor/registry whose logic the Workers reuse, ops and treasury jobs, and `e2e/` (scripts and recorded evidence of live testnet/mainnet runs; tests read the logs). |
| `release/` | Release records: deploy inputs, `freeze-candidate-2.json` (testnet), `mainnet-night/` (mainnet runbook, limits, release record). |
| `scripts/` | `verify-bet.mjs` (bet verifier, Node only), mainnet deploy-night scripts, live smoke and live-bundle checks. |
| `judge-proto/` | The Python judge prototype, bet-type research and red-team evidence; `./test.sh` runs its parity and replay tests. |
| `tests/` | `conformance/` (contract and resolver conformance suites), a seam test, and tests of `test.sh` itself. |
| `chaos/` | Chaos and adversarial scenarios against a local NEAR sandbox (`./test.sh full`). |
| `fixtures/` | Shared fixtures: the real `intents.near` ABI, the web/resolver lint parity table. |
| `sim/` | Monte Carlo model of the challenge game (bond sizes, attacker payoffs); design input, not run by tests. |
| `docs/` | The documents below. |
| `test.sh`, `TESTING.md` | The single test entry point and its policy. |

## Every file in `docs/`

| File | What it is |
|---|---|
| `docs/BETS.md` | Every settled bet, with its ruling, how it ended and its transactions. |
| `docs/STATUS.md` | What is deployed on mainnet and testnet, how it uses NEAR, and what the test suite covers. |
| `docs/LIMITS.md` | Known limits, including the security review's open findings (SR-C1 to SR-C9). |
| `docs/VERIFY.md` | Every verification check (E1-E4, B1-B6), the exact commands, and what each check does *not* prove. |
| `docs/CLOSEOUT.md` | Close-out audit (2026-11-13, before the first mainnet bet): what is built, tested and live, open items, and a check of every public claim. |
| `docs/BET-PROMPT.md` | The prompt for writing an "Anything else" bet with your own AI, with worked examples (same text as the app's Copy prompt button). |
| `docs/REDTEAM-RT1b.md` | Red-team of the escrow contract: one test per attack (`contracts/escrow/src/rt1b.rs`). |
| `docs/REDTEAM-RTE1.md` | Prompt-injection cases against the production judge model pair. |
| `docs/RUNBOOK-JC1x.md` | Operator runbook for the guardian: judge chain, guardian rotation, parameter changes. |
| `docs/evidence/r2-corpus/` | R2 (2026-11-06, historical): offline measurement of wrong winners for the judge design. |

In the app (no login needed): `/docs` (What Praetorial is), `/docs/verification`, `/docs/near-intents`, `/docs/trust` (what you trust, and
how to check each part yourself), `/docs/hackathon`.
