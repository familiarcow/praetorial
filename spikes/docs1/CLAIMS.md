# DOCS1 claims: every factual claim on the Docs pages, with its source

Checked on 2026-11-12 in worktree `web/docs1`. Paths are from the repo root. "chain read" means a read-only RPC view against
`https://free.rpc.fastnear.com` (mainnet) or `https://test.rpc.fastnear.com` (testnet). Nothing was signed or sent, and no secret was read.
Page sources are in `apps/web/src/components/docs/`. The facts and commands are in `apps/web/lib/docsFacts.ts`.

Statuses used on the pages: "Mainnet" means the code switches it on for mainnet and the deployed mainnet site or contract has it. It does
not mean every path has carried real money. "Not possible yet" and "By hand" are stated on the page and appear in FOLLOWUPS.md.

## Corrections to the brief (checked against config, not copied)

| Brief said | Code and config say | Source | What the Docs say |
|---|---|---|---|
| Per-side cap $1,000 | No stake cap at launch (D-CAP3 superseded D-CAP2's ~$1,000). Every asset's `max_per_side` is 10^34 raw. | `apps/web/lib/assets.ts:51-54`; `release/mainnet-night/args.mainnet.json:22` (same at :35,48,61,74,87); `docs/VERIFY.md:91` | "No maximum stake per side at launch" (generated from `LAUNCH_MAX_PER_SIDE`; test-checked) |
| USDC withdraw is testnet-only | Withdraw-to-NEAR-wallet (`ft_withdraw`) has no network gate and is offered for USDC, USDT and NEAR on both networks. The mainnet funding Worker is configured (`FUNDING_DRY_ONLY="0"`). 1Click cash-out is mainnet-only. | `apps/web/lib/withdraw.ts:18-28`; `apps/web/lib/walletCards.ts:150`; `services/workers/funding/wrangler.toml:26` (testnet dry), `:55` (mainnet live) | Cash out to NEAR wallet = mainnet and testnet. Cash out to another chain = mainnet only. |
| Mainnet release record names no escrow id | It does name `bets.praetorial.near`. Its `deploy_tx` and `delete_key_tx` are still "PENDING". | `release/mainnet-night/release-mainnet.json:9` | Escrow id shown. The "Release record gaps" limit says the tx ids are not filled in. |

## Page 1: What Praetorial is (`/docs`, WhatPage.tsx)

| Claim | Source |
|---|---|
| Intro paragraphs (two people, escrow on NEAR, AI judge or a person) | reused verbatim from `apps/web/lib/about.ts` ABOUT "what" (its own sources are in the header comment there) |
| Term sheet hash stored with the bet | `contracts/escrow/src/lib.rs:597` (`Envelope.terms_hash`) |
| Rulings must carry the same hash | `contracts/escrow/src/lib.rs:3190-3193` |
| Missing data never counts as NO: retry up to 7 days, then refund | `resolver/core/src/lib.rs:1035-1036` (insufficient -> ESCALATE, "never NO"); `resolver/wasm-bin/src/main.rs:2922` (ESCALATE -> VOID); `contracts/escrow/src/lib.rs:152` (RECOVERY_WINDOW_NS = 7 days), `:3242-3255` |
| Guide link `/guide/custom-bet` | `apps/web/lib/router.ts` (route "guide", TPL3) |
| Lifecycle: cancel before taken, refund if not taken | about.ts "how" steps (cancel/expire); `contracts/escrow/src/lib.rs` cancel/expire paths (C12) |
| Two models must agree; code turns answers into YES/NO/VOID | `resolver/wasm-bin/src/main.rs:667` (`two_model_agree`); `resolver/core/src/lib.rs:1017-1049` (`decide`) |
| 24 hours to challenge | `apps/web/lib/betOptions.ts:6` (app fixes 24h); `contracts/escrow/src/lib.rs:56` (ROUND_WINDOW_NS) |
| Payout minus fee, VOID refund no fee | about.ts "fees" (PROTOCOL_FEE_BPS_V1 = 100, `contracts/escrow/src/lib.rs:94`; C12 no fee on void) |
| A person can decide instead; pays at once | about.ts "how" (D-REFUI4); `docs/VERIFY.md` "Person-decided bets" |
| How / Fees / Good to know rows | reused from `apps/web/lib/about.ts` (unchanged; existing tests) |

## Page 2: How a result is verified (`/docs/verification`, VerificationPage.tsx)

| Claim | Source |
|---|---|
| Terms fixed: hash stored, ruling must match | `contracts/escrow/src/lib.rs:597`, `:3190-3193` |
| Escrow account has no keys | chain read `view_access_key_list bets.praetorial.near` -> `"keys":[]` (2026-11-12, block 224270966) |
| Code matches a reproducible build | chain read `view_account` code_hash `EfCgMFhe…` = `contracts/escrow/release/record-84f23c8.json:10-11` (3 identical builds :12-25). Re-built by DOCS1 on 2026-11-12: `build_reproducible.sh 84f23c8 run` printed `caf134a4…0f2f` |
| Three switches: pause, shutdown, fee/limit change after 24h | `contracts/escrow/src/lib.rs:1329-1338` (guardian powers), `:5216` (emergency_shutdown); `docs/VERIFY.md:86-92` (D-PARAMS1 24h delay) |
| Models fill a form (met / not met / not enough evidence, with a quote); code decides | `resolver/core/src/lib.rs:68` (FIXED_SYSTEM: the answer format), `:868-933` (verify each answer), `:1017-1049` (`decide`) |
| Burden on YES; not proven = not met; missing data never NO | `resolver/core/src/lib.rs:1026-1027`, `:1035-1036`, `:1042`, `:1048` |
| Two models from different companies, rerun once on disagreement, else no winner | `resolver/wasm-bin/src/main.rs:667-678` (`two_model_agree`), `:830-875`; launch pairs `release/mainnet-night/args.mainnet.json:105-122` (chain read `judge_chain` equal) |
| Quotes word for word in the page read | `resolver/core/src/lib.rs:185` (`quote_in`), `:912-919` |
| Non-curated sources: YES/NO needs two different websites | `resolver/core/src/lib.rs:1007-1010`; `resolver/wasm-bin/src/main.rs:3477-3483` (curated-only -> curated rules) |
| One fixed program on OutLayer TEE; signs with key pinned at deploy with fingerprint (D-KEY1); other signatures refused | `contracts/escrow/src/lib.rs:1385-1392`, `:1766` (`resolver_keys`), `:3271-3275` (verify under pinned outcome_pubkey) |
| Key-to-program binding checked once at deploy; escrow doesn't check TEE | `docs/VERIFY.md:115-120` (E4); `release/mainnet-night/logs/verify-escrow.txt:5` (E4 PASS); `apps/web/lib/verify.ts:237` ("escrow doesn't check it") |
| Strict run order | `contracts/escrow/src/lib.rs:3198-3210` |
| Challenge: 24h; bond = max(min bond, 10% of pot) doubled per round + run price; up to two | `contracts/escrow/src/lib.rs:2399-2414` (code: `pot * 1_000 / BPS_DENOM` = 10%; note the comment at :1560 still says 5%), `:117-130` (max_rounds 2), `args.mainnet.json:14` |
| Fail-safe: 7 days, VOID, no ruling by deadline -> refund, no fee | `contracts/escrow/src/lib.rs:152`, `:3242-3255`, `:4295` (`void_after_deadline`, no caller check) |
| After shutdown anyone can refund any bet | `contracts/escrow/src/lib.rs:5208-5222`, `:5279` (`emergency_refund` permissionless after shutdown) |
| Verify screen re-checks terms hash and signature in the browser, links explorer | `apps/web/lib/verify.ts:203-206` (terms + hash), `:247-249` (signature), `apps/web/src/components/BetVerify.tsx:74-83` |
| Explorer: tx list has submit_outcome / finalize | method names `contracts/escrow/src/lib.rs:3105`, `:3851` |
| `resolver_keys` = ruling key, attest key, fingerprint; attest key signs the source check at open | `contracts/escrow/src/lib.rs:1766`, `:1934-1936` |
| Judge models / verify rows | reused from `apps/web/lib/about.ts` (unchanged) |

## Page 3: NEAR Intents (`/docs/near-intents`, IntentsPage.tsx)

| Claim | Source |
|---|---|
| Token table (symbols, mainnet/testnet, min stake, min fee) | generated: `apps/web/lib/assets.ts:56-115` (`ASSET_TABLE`, `isAssetEnabled` :209) + `apps/web/lib/assetLimits.generated.ts` (from `release/mainnet-night/args.mainnet.json`) via `apps/web/lib/about.ts` `feeRows`; test `apps/web/tests/docs1.unit.test.ts` |
| No maximum stake per side at launch | `apps/web/lib/assets.ts:51-54`; args.mainnet.json:22 |
| Limits for new bets change only after 24h notice | `docs/VERIFY.md:86-92`; about.ts "know" |
| Both sides can use different tokens | `contracts/escrow/src/lib.rs:974` (`fee_min_taker_options`), D-PRICE6 per-asset payout `:3851` doc |
| Balance in your own Intents account, not ours; stakes to escrow and back | `apps/web/lib/about.ts:170`; `apps/web/lib/network.ts:57` (`intents.near`), `:40` (testnet mock) |
| Add money from any wallet (1Click one-time address) = mainnet | `apps/web/src/components/funding/FundSheet.tsx:1-8`; `apps/web/src/components/funding/fundingLive.ts:16` (mainnet only); `services/workers/funding/wrangler.toml:55` (`FUNDING_DRY_ONLY="0"`); deployed mainnet bundle sets `VITE_FUNDING_URL` to the mainnet funding Worker (GET of the site's JS, 2026-11-12) and that Worker's `/health` = 200 |
| Testnet 1Click = previews only | `services/workers/funding/wrangler.toml:4,26` |
| Move from your NEAR wallet (NEAR, USDC, USDT, omft BTC/ETH/ZEC) = both | `apps/web/lib/moveToBetting.ts:1-3,14-16`; `apps/web/src/components/WalletPage.tsx:161` (Move on every row) |
| Cash out to NEAR wallet: USDC, USDT, NEAR; NEAR as wNEAR = both | `apps/web/lib/withdraw.ts:1-6,18-28`; `apps/web/lib/walletCards.ts:150` |
| Cash out to another chain, Convert (1Click) = mainnet | `apps/web/src/components/funding/WithdrawSheet.tsx`, `ConvertSheet.tsx`; funding Worker endpoints `services/workers/funding/README.md:28-30` |
| Free test NEAR = testnet | `apps/web/lib/faucet.ts:1-3`; `apps/web/src/components/WalletPage.tsx:99-101` |
| Login creates your NEAR account; we pay the network fee | `apps/web/README.md:31-33,69` (Privy email OTP -> NEAR implicit account); `services/relayer/src/policy.ts:123-128` (relayer pays gas, no deposits) |
| Escrow refunds unknown tokens | `contracts/escrow/src/lib.rs:1820-1829` |
| NEAR Intents docs link | public: https://docs.near-intents.org (HTTP 200 on 2026-11-12), in `apps/web/lib/docsPublic.json` |

## Page 4: Trust and verification (`/docs/trust`, TrustPage.tsx)

### Status notice
| Claim | Source |
|---|---|
| Mainnet escrow deployed and locked | chain read: `view_account` (code present) + `view_access_key_list` -> `[]` |
| No mainnet bet settled yet | chain read `bet_count` = 0 (2026-11-12) |
| Per-bet checks run on a settled testnet bet | DOCS1 ran both verifiers on testnet bet 52 (REPORT.md) |

### Trust table
| Row | Source |
|---|---|
| Chain/escrow: pays only the two sides, fee, referee tip; guardian powers; no keys; shutdown lets anyone refund | `contracts/escrow/src/lib.rs:1329-1338`, `:5208-5222`, `:5279`; chain read keys `[]`; about.ts "know" |
| OutLayer: runs pinned program, can't get another key accepted; a challenge re-runs the same program on the same service | `contracts/escrow/src/lib.rs:1385-1392`, `:3271-3275`; `apps/web/lib/about.ts:142-144` ("Run by OutLayer", "One signing key") |
| NEAR AI: can't choose outcome, two must agree, quote must be in page | see Page 2 rows (`decide`, `two_model_agree`, `quote_in`) |
| Sources: picked up front; a party-controlled page can't make a met alone | `resolver/core/src/lib.rs:997-1004` |
| Intents/1Click: balance in `intents.near`; stakes in escrow; failed 1Click deposit refunded to your account | `apps/web/lib/network.ts:57`; `apps/web/lib/about.ts:170`; `apps/web/lib/funding/nearcom.ts:6-7` |
| Privy: email login, holds the key of your embedded NEAR wallet | `apps/web/README.md:31-33,69`; `apps/web/src/App.tsx:5` (`useSignRawHash`) |
| Relayer: forwards user-signed txs, allow-list, no deposits on escrow calls; keeper can't decide | `services/relayer/src/policy.ts:123-128`, `:148`, `:154`, `:179-198`; `services/workers/relayer/src/index.ts:1-4`; outcome signature gate `contracts/escrow/src/lib.rs:3271-3275` |
| Anyone can request a ruling, finalize, refund after deadline | no caller check: `contracts/escrow/src/lib.rs:2671` (`request_resolution`), `:3851` (`finalize`), `:4295` (`void_after_deadline`) |
| Front end on Cloudflare can't move money without your signature | `apps/web/wrangler.mainnet.toml:1-29` (static assets + proxies); every action user-signed (policy.ts above) |

### Command blocks (each run on 2026-11-12; outputs in REPORT.md)
| Id | What it checks | Source / run |
|---|---|---|
| cmd:view-helper | defines `view <method> [args]` over public RPC | run in bash and zsh: `resolver_keys`, `get_bet`, `judge_chain` returned JSON |
| cmd:escrow-code-hash | E1, deployed code hash | run: `code_hash":"EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q"` = `release/mainnet-night/release-mainnet.json:5` |
| cmd:escrow-keys | locked | run: `"keys":[]` |
| cmd:escrow-build | E1 reproducible build | run with Docker: printed `caf134a484bc…0f2f` = `contracts/escrow/release/record-84f23c8.json:10`; script `contracts/escrow/release/build_reproducible.sh:9-12` |
| cmd:verify-escrow | E1-E3 at once, E4 skipped | run: `PASS E1, PASS E2, PASS E3, SKIP E4`, exit 3 (documented in `services/verifier/src/cli.ts:19,95`) |
| cmd:get-bet | B1, `envelope.terms_hash`; `last_resolution_raw`; `bonds` | `contracts/escrow/src/lib.rs:5345` (`get_bet`), `:597`; run: returns `null` for a bet id that doesn't exist yet on mainnet (no bets) |
| cmd:resolver-keys | pinned keys + fingerprint | run: `["f67c1f8f…","27070cba…","8791413f…"]`; `contracts/escrow/src/lib.rs:1766` |
| cmd:outlayer-config | where OutLayer fetches the program | run: `wasm_base_url` `https://main.fastfs.io/ops.praetorial.near/outlayer.near`; `docs/VERIFY.md:110-113` (E3) |
| cmd:wasm-download | E3 | run: printed `8791413f…2473` = resolver_keys[2] |
| cmd:resolver-build | reproducible resolver build | run with Docker: printed `8791413f…2473` = `resolver/release/record-f5695b9.json` hash; script `resolver/release/build_reproducible.sh:7-10` |
| cmd:judge-chain | exact model ids | run: 4 pairs = `release/mainnet-night/args.mainnet.json:105-122` |
| cmd:nearai-attestation | NEAR AI attestation report (keyless) | run: HTTP 200, JSON with `gateway_attestation.signing_address`; `docs/VERIFY.md:152-164` |
| cmd:verify-bet-mjs | terms hash, keys, ruling signatures, stored ruling, program, escrow code, locked, every tx | run on testnet bet 52 (`--network testnet`): 14 PASS, 1 FAIL (`escrow-locked`: the testnet escrow still has 1 key; mainnet has none). Script `scripts/verify-bet.mjs:1-24` |
| cmd:services-install | install the verifier's deps | `services/package.json`; `services/verifier/verify-bet:1-3` (runs `src/cli.ts` through tsx) |
| cmd:verify-bet-full | E1-E4, B1-B6 | run on testnet bet 52: B1, B2, B3, B5, B6 PASS; B4 PARTIAL (no raw NEAR AI stream); E4 FAIL without OutLayer homes (as documented, `services/verifier/src/cli.ts:18`) |
| cmd:web-install | install the web app | run in this worktree (REPORT.md) |
| cmd:web-dev | dev server on :3000 | `apps/web/package.json:8`; run: `/docs` served |
| cmd:web-unit | web unit tests | `apps/web/package.json:10`; run green |
| cmd:web-e2e-docs | the Docs browser test | run green |
| cmd:test-fast | the whole fast suite | `test.sh:2-4`; run green (REPORT.md) |

### Steps and limits
| Claim | Source |
|---|---|
| E4 needs OutLayer homes logged in as the escrow and the attest signer; not possible for a stranger | `services/verifier/src/cli.ts:18`; `docs/VERIFY.md:115-120` |
| We ran E4 at deploy: 4 PASS | `release/mainnet-night/logs/verify-escrow.txt:2-6` |
| Escrow accepts a new bet only with a source check signed by attest key, ≤ 1 h old | `contracts/escrow/src/lib.rs:1934-1936`; `docs/VERIFY.md:127-131` (B2; :129 "<= 1 h") |
| verify-bet.mjs served by this site | `apps/web/vite.config.ts:63-73` |
| NEAR AI signatures re-checked, signer matched to NEAR AI report; hardware quote chain not checked | `docs/VERIFY.md:152-175` (B4 signer binding; :170 "the attestation quote chain itself is NOT verified") |
| OutLayer run attestation: not checked by escrow or verifier | `apps/web/lib/verify.ts:237`; `scripts/verify-bet.mjs:22-23` |
| Settings: temperature 0, fixed max tokens, JSON-only | `resolver/wasm-bin/src/main.rs:183-191` |
| Prompt compiled into the program; audit prompt location | `resolver/core/src/lib.rs:68` (FIXED_SYSTEM), `resolver/wasm-bin/src/main.rs:135`; `resolver/wasm-bin/src/template_audit.rs`; shown on the page from `apps/web/lib/judgePrompt.generated.ts` (generated from those files, kept current by `apps/web/tests/judgePrompt.unit.test.ts`) |
| No prompt hash on chain, and none in the signed ruling | escrow stores only `resolver_wasm_hash` (`contracts/escrow/src/lib.rs:1766`); signed submission elements are `{id, verdict}` (`resolver/wasm-bin/src/main.rs:3484`, hash `:3532`). (`prompt_sha256` exists only in the direct-judge path `main.rs:4130`, not the signed one.) |
| Page text not on chain, only sha256 | `docs/VERIFY.md:140-146`; `resolver/wasm-bin/src/main.rs:3883-3893` (`source_record`) |
| Quote-in-source check with `--judge-evidence` | `docs/VERIFY.md:165-167` |
| Verdict recomputed by public `decide` (B4) | `docs/VERIFY.md:147`; `resolver/core/src/lib.rs:1017` |
| B3 run numbers, B6 timeline | `docs/VERIFY.md:133-139`, `:193-197` |
| Bonds: exact amount required; verifier doesn't map them | `contracts/escrow/src/lib.rs:2411-2413`; `docs/VERIFY.md:54-55` ("Challenge bonds / objection deposits are not mapped: B5 SKIPs") |
| B5 payout arithmetic, VOID skipped | `docs/VERIFY.md:186-191` |
| History from an indexer, trusted for completeness | `docs/VERIFY.md:38-39`, `:53-54` |
| Testnet escrow has an access key | verify-bet.mjs run on testnet: `FAIL escrow-locked the escrow account has 1 access key(s)` |
| Unaudited | no audit report anywhere in the repo (searched for "audit report"); stated as a limit |
| NEAR AI verification guide link | public: https://docs.near.ai/cloud/verification/ (HTTP 200, 2026-11-12), `docs/VERIFY.md:175` |

## Page 5: Hackathon (`/docs/hackathon`, HackathonPage.tsx)

| Claim | Source |
|---|---|
| Rules: dev 1-14 Nov 2026, ends 14 Nov 23:59 UTC; public repo + X post tagging @NEARProtocol and #NEARHackathon; screened by Claude Code and Codex; judging criteria; tracks | public: https://nearhackathon.com (read by the PM on 11-12, re-read by DOCS1 on 11-12: "Development 1–14 Nov 2026", "14 Nov 2026 · 23:59 UTC", "tag @NEARProtocol and #NEARHackathon", tracks "Unstoppable DeFi", "AI Security & Defense", "Open Innovation") |
| Mainnet escrow `bets.praetorial.near` | `apps/web/lib/network.ts:56`; `release/mainnet-night/release-mainnet.json:9`; chain read |
| Mainnet intents `intents.near` | `apps/web/lib/network.ts:57`; `args.mainnet.json:2` |
| Registry id `registry.praetorial.near`: username signature recipient + escrow setup arg, never called, no account on chain | `apps/web/lib/network.ts:68`; `apps/web/lib/refereeRegistry.ts:150`; `args.mainnet.json:7`; `contracts/escrow/src/lib.rs:1339` (stored, no `self.registry` read anywhere); chain read `view_account registry.praetorial.near` -> UNKNOWN_ACCOUNT |
| Usernames run on a Cloudflare Worker (mainnet up) | `apps/web/lib/networkSelect.ts:10`; GET `/health` = 200 (2026-11-12) |
| Testnet escrow same code, still has a key | `apps/web/lib/network.ts:39`; verify-bet.mjs testnet run: `escrow-code EfCgMFhe…` and `escrow-locked FAIL (1 key)` |
| Judge fingerprint pinned in both escrows; models from NEAR AI Cloud | `apps/web/lib/release.mainnet.json:5`, `apps/web/lib/release.json:5`; chain reads `resolver_keys` (mainnet and testnet runs) |
| 1Click mainnet only | see Page 3 |
| Web app deployed on both networks, unlisted | `apps/web/wrangler.mainnet.toml:1` ("unlisted: no routes, no custom domain"); `apps/web/wrangler.testnet.toml:1-6`; both sites return 200 (2026-11-12) |
| Built list (contract, judge, web with six bet types, services, verifiers, tests) | `contracts/escrow/src/lib.rs`; `resolver/`; `apps/web/lib/betTypePicker.ts:10-17` (six cards); `services/workers/` (relayer, keeper, sourcecheck, indexer, registry, funding); `services/verifier/`, `scripts/verify-bet.mjs`; `test.sh:2-4` |
| Planned list | each one matches a "Not possible yet" / "By hand" step on the Trust page and a FOLLOWUPS.md item; the repo and license are TODOs |
| Run locally commands | run in this worktree on 2026-11-12 (REPORT.md); `apps/web/package.json:8,10` |
| Known limits: unaudited, OutLayer/NEAR AI trust, nondeterminism, no cap, 1Click mainnet only, testnet USDC+NEAR only, unlisted | Trust page sources above; `apps/web/lib/assets.ts:14-16,72-112` (testnet only USDC and NEAR); `apps/web/wrangler.mainnet.toml:1` |
| Built from public sources only | the Docs cite only repo files, public chain reads and public sites listed here |

## External links on the Docs (the in-docs link test allows only these origins)
- https://nearblocks.io and https://testnet.nearblocks.io: public explorers (account pages `/address/<id>`; the site sends bots a 403 but serves browsers)
- https://nearhackathon.com: public rules
- https://docs.near.ai: NEAR AI attestation guide (HTTP 200)
- https://docs.near-intents.org: NEAR Intents docs (HTTP 200)
- https://main.fastfs.io: program download (inside a command only, read from the escrow's `outlayer_config`)

## TODOs for familiarcow
- `TODO(familiarcow): public repository URL` (Trust page "Start from the source code", Hackathon "Repository")
- `TODO(familiarcow): license` (Hackathon "License"; there is no LICENSE file in the repo today)
- `TODO(familiarcow): team` (Hackathon "Team")
- `TODO(familiarcow): demo post on X and the demo site address` (Hackathon status table and "Demo")
- When the repo goes public: About's "Its source code is not public yet" (`apps/web/lib/about.ts`, verify bullets) and `apps/web/vite.config.ts:64` need updating. They are true today, so DOCS1 left them unchanged.
